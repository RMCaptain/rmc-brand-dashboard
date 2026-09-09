'use strict';
// Exercise the new registry helpers + health grouping with mock data. No env, no network.
const assert = require('assert');
process.env.SP_API_MARKETPLACE_IDS = 'A2EUQ1WTGCTBG2,ATVPDKIKX0DER';
const MP = require(require('path').resolve(__dirname, '..', '..') + '/sync/marketplaces');

const CA = 'A2EUQ1WTGCTBG2', US = 'ATVPDKIKX0DER', UK = 'A1F83G8C2ARO7P';

// wideTableOnly / isWideTableMp / isCaMp
assert.deepStrictEqual(MP.wideTableOnly([CA, US, UK, 'walmart_ca', 'bogus'], 'T'), [CA, US]);
assert.strictEqual(MP.isWideTableMp(CA), true);
assert.strictEqual(MP.isWideTableMp(UK), false);
assert.strictEqual(MP.isCaMp(CA), true);
assert.strictEqual(MP.isCaMp(US), false);
assert.throws(() => MP.isCaMp(UK), /cannot be written to a CAD\/USD wide table/);
assert.throws(() => MP.isCaMp(null), /unknown/);

// codesForBrand
assert.deepStrictEqual(MP.codesForBrand({ marketplace: 'CA' }), ['CA']);
assert.deepStrictEqual(MP.codesForBrand({ marketplace: 'CA,US' }), ['CA', 'US']);
assert.deepStrictEqual(MP.codesForBrand({ marketplace: ' us , ca ' }), ['US', 'CA']);
assert.deepStrictEqual(MP.codesForBrand({}), ['CA']);
assert.deepStrictEqual(MP.codesForBrand({ id: 'x', marketplace: 'CA,XX' }), ['CA']);

// codeForAsin: listed marketplace wins, else brand's first code
const brand = { id: 'b', marketplace: 'CA,US', asinMarketplaces: { A1: 'US', A2: 'CA', A3: 'ZZ', A4: 'UK' } };
assert.strictEqual(MP.codeForAsin(brand, 'A1'), 'US');
assert.strictEqual(MP.codeForAsin(brand, 'A2'), 'CA');
assert.strictEqual(MP.codeForAsin(brand, 'A3'), 'CA');   // unknown listed code → brand default
assert.strictEqual(MP.codeForAsin(brand, 'A4'), 'CA');   // listed on a marketplace the brand doesn't declare → default
assert.strictEqual(MP.codeForAsin(brand, 'A9'), 'CA');   // unlisted → brand default
assert.strictEqual(MP.codeForAsin({ marketplace: 'US' }, 'A9'), 'US');
// Single-marketplace brand: declared marketplace wins even if the listing says otherwise
assert.strictEqual(MP.codeForAsin({ marketplace: 'CA', asinMarketplaces: { A1: 'US' } }, 'A1'), 'CA');
assert.strictEqual(MP.codeForAsin({}, 'A1'), 'CA');

// storefrontHost
assert.strictEqual(MP.storefrontHost('CA'), 'www.amazon.ca');
assert.strictEqual(MP.storefrontHost('US'), 'www.amazon.com');
assert.strictEqual(MP.storefrontHost('UK'), 'www.amazon.co.uk');
assert.strictEqual(MP.storefrontHost('nope'), null);

// Health grouping — replicate enrichListingHealth's grouping block exactly.
function groupForHealth(brands, mpIds) {
  const byMp = {}, asinMpCode = {};
  for (const b of brands) {
    if (b.id === 'unknown-brand') continue;
    for (const asin of b.asins || []) {
      const code = MP.codeForAsin(b, asin, 'Health');
      const mp = MP.idByCode(code);
      if (!mp || !mpIds.includes(mp)) continue;
      (byMp[mp] = byMp[mp] || new Set()).add(asin);
      asinMpCode[asin] = code;
    }
  }
  return { byMp, asinMpCode };
}
{
  const brands = [
    { id: 'acure', marketplace: 'CA', asins: ['X1', 'X2', 'X3'], asinMarketplaces: { X1: 'CA', X2: 'US' } },
    { id: 'dual',  marketplace: 'CA,US', asins: ['Y1', 'Y2'], asinMarketplaces: { Y2: 'US' } },
    { id: 'usonly', marketplace: 'US', asins: ['Z1'] },
    { id: 'unknown-brand', marketplace: 'CA', asins: ['Q1'] },
  ];
  const { byMp, asinMpCode } = groupForHealth(brands, [CA, US]);
  // 'CA' brand: all three on .ca regardless of listing (X2's US listing is not where we sell it)
  // 'CA,US' brand: Y2 routed by its US listing, Y1 defaults to CA
  assert.deepStrictEqual([...byMp[CA]].sort(), ['X1', 'X2', 'X3', 'Y1']);
  assert.deepStrictEqual([...byMp[US]].sort(), ['Y2', 'Z1']);
  assert.strictEqual(asinMpCode.Y2, 'US');
  assert.strictEqual(asinMpCode.Q1, undefined);
  // Old rule for comparison: 'CA,US' → CA only, so Y2 never got checked on .com
  const oldUs = brands.filter(b => b.marketplace === 'US').flatMap(b => b.asins);
  assert.deepStrictEqual(oldUs, ['Z1']);
}

// orders.js wrapper: module-level getMarketplaceIds() filters to the wide pair
{
  process.env.SP_API_MARKETPLACE_IDS = `${CA},${US},${UK}`;
  const amazon = require(require('path').resolve(__dirname, '..', '..') + '/sync/amazon');
  assert.deepStrictEqual(amazon.getMarketplaceIds(), [CA, US, UK]);
  const ordersSrc = require('fs').readFileSync(require('path').resolve(__dirname, '..', '..') + '/sync/orders.js', 'utf8');
  assert.ok(/function getMarketplaceIds\(\) \{ return MP\.wideTableOnly\(allMarketplaceIds\(\), 'Orders'\); \}/.test(ordersSrc));
  assert.ok(!/=== 'A2EUQ1WTGCTBG2'/.test(ordersSrc), 'no literal CA id comparisons left in orders.js');
}

// sellerIdsToScrape: copy of the server.js helper (server.js boots Supabase on require)
function sellerIdsToScrape(brands, sellerNames, { skip = new Set(), ourSellerId = null, refreshMs = 30 * 864e5 } = {}) {
  const idsByMp = {};
  for (const b of brands || []) {
    if (skip.has(b.id)) continue;
    for (const [asin, hist] of Object.entries(b.buyBoxOwnerHistory || {})) {
      for (const h of hist || []) {
        if (!h.sellerId || h.sellerId === ourSellerId) continue;
        const cached = sellerNames[h.sellerId];
        const stale = cached?.scrapedAt && (Date.now() - new Date(cached.scrapedAt).getTime() > refreshMs);
        if (cached && !stale) continue;
        const mp = h.marketplace || MP.codeForAsin(b, asin, 'SellerScrape');
        (idsByMp[mp] = idsByMp[mp] || new Set()).add(h.sellerId);
      }
    }
  }
  return idsByMp;
}
{
  const old = new Date(Date.now() - 40 * 864e5).toISOString();
  const brands = [
    { id: 'a', marketplace: 'CA,US', asinMarketplaces: { P2: 'US' }, buyBoxOwnerHistory: {
      P1: [{ sellerId: 'S1' }, { sellerId: 'ME' }],
      P2: [{ sellerId: 'S2' }],                       // pre-field entry → listed marketplace US
      P3: [{ sellerId: 'S3', marketplace: 'US' }],    // new entry carries marketplace
      P4: [{ sellerId: 'S4' }, { sellerId: 'S5' }],
    } },
    { id: 'general-wholesale', marketplace: 'CA', buyBoxOwnerHistory: { G: [{ sellerId: 'S9' }] } },
  ];
  const names = { S4: { name: 'fresh', scrapedAt: new Date().toISOString() }, S5: { name: 'stale', scrapedAt: old } };
  const r = sellerIdsToScrape(brands, names, { skip: new Set(['general-wholesale']), ourSellerId: 'ME' });
  assert.deepStrictEqual(Object.keys(r).sort(), ['CA', 'US']);
  assert.deepStrictEqual([...r.CA].sort(), ['S1', 'S5']);
  assert.deepStrictEqual([...r.US].sort(), ['S2', 'S3']);
}

console.log('all marketplace helper checks passed');
