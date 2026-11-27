'use strict';
/**
 * Settlement + fee-preview readers for the FBA fee audit skill (Mike,
 * 2026-11-27). Read-only, NA credentials, marketplace CA|US.
 *
 *  - listSettlements:   Amazon's auto-generated V2 settlement flat files
 *                       (getReports — never createReport), newest first.
 *  - getSettlementFees: per order-line principal / tax / FBA fee for SKUs
 *                       under a prefix, plus Fee Adjustment credits. Prior
 *                       weeks' files are used ONLY to map blank-SKU credits
 *                       back to a SKU via order-id.
 *  - getFeePreview:     GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA per SKU, every
 *                       fee column passed through, cached 24h.
 *
 * Settlement documents are immutable once DONE, so parsed files are cached
 * in memory by reportId (small LRU). Roles: settlements need Finance &
 * Accounting; the fee preview report needs Amazon Fulfillment — a 403 from
 * Amazon surfaces as a clear error naming the role.
 */
const { getAccessToken, spRequest, createReport, waitForReport, downloadReport, sleep } = require('./amazon');
const MP = require('./marketplaces');

const SETTLEMENT_TYPE = 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2';
const FEE_PREVIEW_TYPE = 'GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA';
const CURRENCY_OF = { CA: 'CAD', US: 'USD' };

function mpIdFor(marketplace) {
  const code = String(marketplace || '').toUpperCase();
  if (!CURRENCY_OF[code]) throw new Error(`marketplace must be CA or US (got "${marketplace}")`);
  return { code, mpId: MP.idByCode(code), currency: CURRENCY_OF[code] };
}

// ── TSV parsing (Amazon flat files: tab-separated, header row first) ────────
function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length);
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].split('\t').map(h => h.trim().toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = (cells[c] ?? '').trim();
    rows.push(row);
  }
  return { header, rows };
}
const num = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

// ── Report document cache ───────────────────────────────────────────────────
const docCache = new Map();   // reportId → { header, rows, fetchedAt }
const DOC_CACHE_MAX = 12;
async function loadReportRows(reportId, token) {
  const hit = docCache.get(reportId);
  if (hit) return hit;
  const res = await spRequest('GET', `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`, token);
  if (res.status === 403) throw new Error('SP-API 403 reading report — the app lacks the Finance & Accounting role (settlements) or Amazon Fulfillment role (fee preview)');
  if (res.status !== 200) throw new Error(`getReport ${reportId}: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  const docId = res.body.reportDocumentId;
  if (!docId) throw new Error(`report ${reportId} has no document (status ${res.body.processingStatus})`);
  const parsed = parseTsv(await downloadReport(docId, token));
  parsed.fetchedAt = new Date().toISOString();
  parsed.createdTime = res.body.createdTime;
  parsed.processingEndTime = res.body.processingEndTime;
  docCache.set(reportId, parsed);
  if (docCache.size > DOC_CACHE_MAX) docCache.delete(docCache.keys().next().value);
  return parsed;
}

async function getReportsList(token, { reportTypes, mpId, pageSize = 20, processingStatuses = 'DONE', createdSince } = {}) {
  const q = new URLSearchParams({ reportTypes, pageSize: String(pageSize), processingStatuses });
  if (mpId) q.set('marketplaceIds', mpId);
  if (createdSince) q.set('createdSince', createdSince);
  const res = await spRequest('GET', `/reports/2021-06-30/reports?${q}`, token);
  if (res.status === 403) throw new Error('SP-API 403 listing reports — check the app roles (Finance & Accounting for settlements, Amazon Fulfillment for fee preview)');
  if (res.status !== 200) throw new Error(`getReports: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  return res.body.reports || [];
}

// ── 1. list_settlements ─────────────────────────────────────────────────────
async function listSettlements(marketplace, { limit = 6 } = {}) {
  const { mpId, currency, code } = mpIdFor(marketplace);
  const token = await getAccessToken();
  const cap = Math.max(1, Math.min(Number(limit) || 6, 20));
  // Over-fetch: the marketplaceIds filter is advisory for settlement files
  // (they are per settlement group), so confirm by the file's own currency.
  const reports = await getReportsList(token, { reportTypes: SETTLEMENT_TYPE, mpId, pageSize: Math.min(cap * 3, 60) });
  const out = [];
  for (const r of reports) {
    if (out.length >= cap) break;
    try {
      const doc = await loadReportRows(r.reportId, token);
      const head = doc.rows[0] || {};
      if ((head['currency'] || '').toUpperCase() !== currency) continue;
      out.push({
        reportId: r.reportId,
        settlementId: head['settlement-id'] || null,
        settlementStartDate: head['settlement-start-date'] || null,
        settlementEndDate: head['settlement-end-date'] || null,
        depositDate: head['deposit-date'] || null,
        totalAmount: num(head['total-amount']),
        currency: head['currency'] || currency,
        rows: doc.rows.length,
        createdTime: r.createdTime,
      });
    } catch (e) {
      console.warn(`[Settlements] skip ${r.reportId}: ${e.message}`);
    }
    await sleep(300);
  }
  out.sort((a, b) => String(b.settlementEndDate || '').localeCompare(String(a.settlementEndDate || '')));
  return { marketplace: code, currency, count: out.length, settlements: out };
}

// ── 2. get_settlement_fees ──────────────────────────────────────────────────
function computeSettlementFees(auditedRows, extraRowSets, skuPrefix, { cap = 2000 } = {}) {
  const prefix = String(skuPrefix || '');
  const matches = sku => prefix ? sku.startsWith(prefix) : true;
  // order-id → sku, from every file (credits often arrive with a blank SKU).
  const skuByOrder = {};
  for (const rows of [auditedRows, ...extraRowSets]) {
    for (const r of rows) {
      const sku = r['sku'];
      const oid = r['order-id'];
      if (sku && oid && !skuByOrder[oid]) skuByOrder[oid] = sku;
    }
  }
  const skuOf = r => r['sku'] || skuByOrder[r['order-id']] || '';

  const lineMap = new Map();
  const credits = [];
  for (const r of auditedRows) {
    const sku = skuOf(r);
    if (!matches(sku)) continue;
    const tt = r['transaction-type'];
    if (tt === 'Order') {
      const key = `${r['order-id']}|${r['order-item-code']}`;
      const l = lineMap.get(key) || (lineMap.set(key, {
        postedDate: r['posted-date'] || null, orderId: r['order-id'], orderItemCode: r['order-item-code'] || null,
        sku, qty: 0, principal: 0, tax: 0, fbaFee: 0, marketplaceName: r['marketplace-name'] || null,
      }), lineMap.get(key));
      const at = r['amount-type'], ad = r['amount-description'], amt = num(r['amount']);
      if (at === 'ItemPrice' && ad === 'Principal') { l.qty += num(r['quantity-purchased']); l.principal += amt; }
      else if (at === 'ItemPrice' && ad === 'Tax') l.tax += amt;
      if (ad === 'FBAPerUnitFulfillmentFee') l.fbaFee += amt;
    } else if (tt === 'Fee Adjustment') {
      credits.push({ postedDate: r['posted-date'] || null, orderId: r['order-id'] || null, sku, amount: num(r['amount']), amountDescription: r['amount-description'] || null });
    }
  }
  const round = v => Math.round(v * 100) / 100;
  let lines = [...lineMap.values()].filter(l => Math.abs(l.fbaFee) >= 0.005)
    .map(l => ({ ...l, principal: round(l.principal), tax: round(l.tax), fbaFee: round(l.fbaFee) }));
  const truncated = lines.length > cap;
  if (truncated) lines = lines.slice(0, cap);
  return { lines, credits, truncated, lineCount: lineMap.size };
}

async function getSettlementFees(marketplace, { reportId, skuPrefix, extraReportIds = [] } = {}) {
  const { code, currency } = mpIdFor(marketplace);
  if (!reportId) throw new Error('reportId required');
  if (!skuPrefix) throw new Error('skuPrefix required (e.g. "ZE-")');
  const token = await getAccessToken();
  const audited = await loadReportRows(reportId, token);
  const extras = [];
  for (const id of (Array.isArray(extraReportIds) ? extraReportIds : String(extraReportIds).split(',')).map(s => String(s).trim()).filter(Boolean)) {
    try { extras.push((await loadReportRows(id, token)).rows); }
    catch (e) { console.warn(`[Settlements] extra ${id} skipped: ${e.message}`); }
  }
  const head = audited.rows[0] || {};
  const result = computeSettlementFees(audited.rows, extras, skuPrefix);
  return {
    marketplace: code, currency: head['currency'] || currency, reportId, skuPrefix,
    settlementId: head['settlement-id'] || null, settlementStartDate: head['settlement-start-date'] || null, settlementEndDate: head['settlement-end-date'] || null,
    extraReportsUsed: extras.length,
    ...result,
  };
}

// ── 3. get_fee_preview ──────────────────────────────────────────────────────
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const DIM_COLS = ['longest-side', 'median-side', 'shortest-side', 'unit-of-dimension', 'item-package-weight', 'unit-of-weight', 'product-size-weight-band', 'product-size-tier', 'your-price', 'sales-price', 'currency'];

// Amazon's Fee Preview for a unified NA account is ONE account-wide file:
// a row per SKU PER STORE (amazon-store column; CA rows in CAD/cm/g, US rows
// in USD/in/lb). Verified 2026-11-27: the "CA" document carried USD rows for
// SKUs listed in both stores. So: cache one document for the account and
// filter ROWS per request — never pick a document per marketplace.
const STORE_MATCH = {
  CA: v => /^(ca|amazon\.ca|canada)$/i.test(v) || /\.ca$/i.test(v),
  US: v => /^(us|amazon\.com|united states)$/i.test(v) || /\.com$/i.test(v),
};
function rowMarketplace(r) {
  const store = r['amazon-store'] || r['marketplace'] || r['marketplace-name'] || '';
  if (store) { for (const code of Object.keys(STORE_MATCH)) if (STORE_MATCH[code](store.trim())) return code; }
  const cur = (r['currency'] || '').toUpperCase();
  return cur === 'CAD' ? 'CA' : cur === 'USD' ? 'US' : null;
}
function previewCurrencyOf(rows) {
  for (const r of rows) { const c = (r['currency'] || '').toUpperCase(); if (c) return c; }
  return null;
}

let accountPreview = null;   // { at, reportId, generatedAt, header, rows } — one per NA account
async function loadFeePreview(token, { force = false } = {}) {
  if (!force && accountPreview && Date.now() - accountPreview.at < PREVIEW_TTL_MS) return accountPreview;
  const recent = await getReportsList(token, { reportTypes: FEE_PREVIEW_TYPE, pageSize: 5, createdSince: new Date(Date.now() - 2 * 864e5).toISOString() });
  let entry = null;
  for (const report of recent) {
    try {
      const parsed = await loadReportRows(report.reportId, token);
      if (!parsed.rows.length) continue;
      entry = { at: Date.now(), reportId: report.reportId, generatedAt: report.processingEndTime || report.createdTime, header: parsed.header, rows: parsed.rows };
      break;
    } catch (e) { console.warn(`[FeePreview] reusing ${report.reportId} failed: ${e.message}`); }
  }
  if (!entry) {
    const id = await createReport(FEE_PREVIEW_TYPE, [MP.idByCode('CA'), MP.idByCode('US')], null, null, token);
    const docId = await waitForReport(id, token, 20 * 60 * 1000);
    const parsed = parseTsv(await downloadReport(docId, token));
    entry = { at: Date.now(), reportId: id, generatedAt: new Date().toISOString(), header: parsed.header, rows: parsed.rows };
  }
  accountPreview = entry;
  return entry;
}

function shapePreviewRows(rows, header, { skuPrefix, asinSet, marketplace } = {}) {
  const feeCols = header.filter(h => /fee/.test(h) && !DIM_COLS.includes(h));
  const out = [];
  for (const r of rows) {
    if (marketplace && rowMarketplace(r) !== marketplace) continue;
    const sku = r['sku'] || '', asin = r['asin'] || '';
    if (skuPrefix && !sku.startsWith(skuPrefix)) continue;
    if (asinSet && !asinSet.has(asin)) continue;
    const o = { sku, asin, fnsku: r['fnsku'] || null, productName: r['product-name'] || null, fulfilledBy: r['fulfilled-by'] || null, store: r['amazon-store'] || null };
    for (const col of DIM_COLS) if (col in r) o[col] = r[col] === '' ? null : (isNaN(Number(r[col])) ? r[col] : Number(r[col]));
    for (const col of feeCols) o[col] = r[col] === '' ? null : (isNaN(Number(r[col])) ? r[col] : Number(r[col]));
    out.push(o);
  }
  return { rows: out, feeColumns: feeCols };
}

async function getFeePreview(marketplace, { skuPrefix, asinSet, brandId } = {}) {
  const { code, currency } = mpIdFor(marketplace);
  if (!skuPrefix && !asinSet) throw new Error('skuPrefix or brandId required');
  const token = await getAccessToken();
  const prev = await loadFeePreview(token);
  const marketRows = prev.rows.filter(r => rowMarketplace(r) === code);
  if (!marketRows.length) throw new Error(`Fee Preview document ${prev.reportId} has no ${code} (${currency}) rows — nothing returned`);
  // Hard guard: every returned row must carry the marketplace's currency.
  const offCurrency = marketRows.filter(r => (r['currency'] || '').toUpperCase() !== currency);
  if (offCurrency.length) throw new Error(`Fee Preview ${code}: ${offCurrency.length} rows carry a currency other than ${currency} — refusing to mix marketplaces`);
  const shaped = shapePreviewRows(marketRows, prev.header, { skuPrefix, asinSet });
  return { marketplace: code, currency, reportId: prev.reportId, reportGeneratedAt: prev.generatedAt, cachedAt: new Date(prev.at).toISOString(), skuPrefix: skuPrefix || null, brandId: brandId || null, count: shaped.rows.length, marketplaceRowsInDocument: marketRows.length, feeColumns: shaped.feeColumns, skus: shaped.rows };
}

module.exports = { listSettlements, getSettlementFees, getFeePreview, computeSettlementFees, shapePreviewRows, parseTsv, previewCurrencyOf, rowMarketplace };
