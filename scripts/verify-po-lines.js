// Verify the purchase_order_lines projection (P4) against the source blobs.
// Run after applying sql/po-lines-projection.sql:
//   node scripts/verify-po-lines.js
//
// Checks: every PO's projected line count equals data.lines length (no drift),
// reports total spend, and prints a sample. Read-only — touches nothing.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Page past Supabase's 1000-row default cap.
async function fetchAll(table, columns) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

(async () => {
  const pos = await fetchAll('purchase_orders', 'id, po_number, brand_name, deleted_at, data');
  const lines = await fetchAll('purchase_order_lines', 'po_id, line_type, asin, quantity, unit_price, extended_cost');

  // Group projected lines by po_id
  const byPo = new Map();
  for (const ln of lines) {
    if (!byPo.has(ln.po_id)) byPo.set(ln.po_id, []);
    byPo.get(ln.po_id).push(ln);
  }

  let mismatches = [];
  let totalBlobLines = 0;
  for (const po of pos) {
    const blobLines = Array.isArray(po.data?.lines) ? po.data.lines.length : 0;
    const projLines = (byPo.get(po.id) || []).length;
    totalBlobLines += blobLines;
    if (blobLines !== projLines) {
      mismatches.push({ po: po.po_number ?? po.id.slice(0, 8), brand: po.brand_name, blob: blobLines, projected: projLines, deleted: !!po.deleted_at });
    }
  }

  const totalSpend = lines.reduce((s, l) => s + Number(l.extended_cost || 0), 0);
  const fmt = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  console.log('── PO Lines Projection Verification ─────────────────────────');
  console.log(`POs:                 ${pos.length}`);
  console.log(`Projected lines:     ${lines.length}`);
  console.log(`Blob lines (sum):    ${totalBlobLines}`);
  console.log(`Total line spend:    ${fmt(totalSpend)}  (extended_cost summed)`);
  console.log(`Count mismatches:    ${mismatches.length}`);

  if (mismatches.length) {
    console.log('\n⚠️  Drift detected (blob count ≠ projected count):');
    console.table(mismatches);
    console.log('Re-saving each PO or re-running the backfill will resync.');
  } else {
    console.log('\n✅ Every PO projects exactly its blob line count. No drift.');
  }

  // Sample of the largest PO by line count
  const sample = [...byPo.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (sample) {
    const po = pos.find(p => p.id === sample[0]);
    console.log(`\nSample — PO ${po?.po_number ?? sample[0].slice(0, 8)} (${po?.brand_name}), ${sample[1].length} lines:`);
    console.table(sample[1].slice(0, 8).map(l => ({
      type: l.line_type, asin: l.asin, qty: l.quantity, unit: Number(l.unit_price), ext: Number(l.extended_cost),
    })));
  }
})().catch(err => { console.error('Verify failed:', err.message); process.exit(1); });
