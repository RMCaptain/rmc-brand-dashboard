// Remote MCP endpoint for claude.ai custom connectors (Streamable HTTP, JSON responses).
//
// Lets team chats on claude.ai pull dashboard data directly instead of pasting
// exports into the RMC skills. Hand-rolled JSON-RPC handler — no MCP SDK
// dependency (the SDK is ESM-first and this app is CommonJS).
//
// Auth model: the endpoint is mounted BEFORE basicAuth and the secret URL path
// is the credential (claude.ai custom connectors can't send Basic Auth or
// custom headers). Read-only tools only. Override the path secret with the
// MCP_TOKEN env var on Render; the committed fallback keeps the private-repo
// deploy simple.
//
// claude.ai setup: Settings → Connectors → Add custom connector →
//   https://app.rockymountainco.ca/mcp/<token>

const express = require('express');

const TOKEN = process.env.MCP_TOKEN || '7c794441aa561de574cbe99e0ce0f5761fce0b04a12fd9f9';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
// Tool results land in a chat context window — clamp anything huge.
const MAX_RESULT_CHARS = 400000;

function localApi(pathname) {
  const port = process.env.PORT || 3000;
  const headers = {};
  if (process.env.AUTH_USERNAME && process.env.AUTH_PASSWORD) {
    headers.Authorization = 'Basic ' +
      Buffer.from(`${process.env.AUTH_USERNAME}:${process.env.AUTH_PASSWORD}`).toString('base64');
  }
  return fetch(`http://127.0.0.1:${port}${pathname}`, { headers }).then(async res => {
    if (!res.ok) throw new Error(`${pathname} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  });
}

const qs = params => {
  const clean = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return clean.length ? '?' + new URLSearchParams(clean).toString() : '';
};

// ── Tools ────────────────────────────────────────────────────────────────────
// Coverage per skill: asin-audit + brand-audit (get_brand_report, get_listing_health),
// ppc-report (get_brand_report per period), ppc-deep-dive (get_brand_report +
// get_ads_campaigns), ppc-search-terms (get_search_terms + get_ads_campaigns),
// listing-copy + ppc-campaign-builder (get_datadive), all (list_brands).

const TOOLS = [
  {
    name: 'list_brands',
    description: 'List all RMC brands with their ids (use the id in every other tool). Returns id, name, marketplace per brand.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const data = await localApi('/api/brands?preset=30d');
      const brands = (data.brands || []).map(b => ({ id: b.id, name: b.name, marketplace: b.marketplace || 'CA' }));
      return {
        lastSync: data.lastSync,
        count: brands.length,
        note: 'This is the complete brand list — always present all of them, including internal buckets like unknown-brand and general-wholesale.',
        brands,
      };
    },
  },
  {
    name: 'get_brand_report',
    description: 'Full report dataset for one brand and period: summary (units, revenue CAD/USD, sessions, CVR, Buy Box, refunds, ad summary with spend/sales/clicks/impressions/ACOS/TACOS), per-ASIN products, true order counts, inventory, and a prior comparison period. Defaults to last calendar month vs the month before. Pass from/to (YYYY-MM-DD) for a custom window; compFrom/compTo for a custom comparison. Set includeDaily=true only when you need day-by-day series (large). Ads data is Sponsored Products only, CA+US.',
    inputSchema: {
      type: 'object',
      properties: {
        brandId: { type: 'string', description: 'Brand id from list_brands, e.g. "zellies"' },
        from: { type: 'string', description: 'Period start YYYY-MM-DD' },
        to: { type: 'string', description: 'Period end YYYY-MM-DD' },
        compFrom: { type: 'string', description: 'Comparison start YYYY-MM-DD (with compTo)' },
        compTo: { type: 'string', description: 'Comparison end YYYY-MM-DD (with compFrom)' },
        includeDaily: { type: 'boolean', description: 'Include daily revenue/units series (default false — large)' },
      },
      required: ['brandId'],
      additionalProperties: false,
    },
    handler: async args => {
      const data = await localApi(`/api/brand-report-dataset/${encodeURIComponent(args.brandId)}` +
        qs({ from: args.from, to: args.to, compFrom: args.compFrom, compTo: args.compTo }));
      if (!args.includeDaily) {
        delete data.dailySeries; delete data.dailySeriesPrev;
        delete data.ytdSeries; delete data.ytdSeriesPrev;
      }
      return data;
    },
  },
  {
    name: 'get_ads_campaigns',
    description: 'Sponsored Products campaign structure snapshot for a brand: campaigns with budgets, states, targeting type, ASINs, keyword/negative counts. Set full=true for complete keywords/targets/negatives detail (large — only when designing or auditing structure). Refreshed daily.',
    inputSchema: {
      type: 'object',
      properties: {
        brandId: { type: 'string' },
        profile: { type: 'string', enum: ['CA', 'US'], description: 'Ads profile, default CA' },
        full: { type: 'boolean', description: 'Include full keyword/target/negative detail (default false)' },
      },
      required: ['brandId'],
      additionalProperties: false,
    },
    handler: args => localApi('/api/ads/campaigns' +
      qs({ brand: args.brandId, profile: args.profile || 'CA', full: args.full ? 1 : undefined })),
  },
  {
    name: 'get_search_terms',
    description: 'Rolling 30-day clicked search terms for a brand (Sponsored Products) with campaign/ad-group/keyword context — spend, clicks, orders per term. Refreshed Mondays; response includes the data window. Use for negation lists, exact-match harvest, and match-type migration.',
    inputSchema: {
      type: 'object',
      properties: {
        brandId: { type: 'string' },
        profile: { type: 'string', enum: ['CA', 'US'], description: 'Ads profile, default CA' },
      },
      required: ['brandId'],
      additionalProperties: false,
    },
    handler: args => localApi('/api/ads/search-terms' + qs({ brand: args.brandId, profile: args.profile || 'CA' })),
  },
  {
    name: 'get_datadive',
    description: 'ORGANIC keyword data for a brand from Data Dive: per-keyword current rank, 30d-ago rank, trend, search volume, relevancy, and SQP where present. Contains NO advertising metrics by design — ads data comes only from get_brand_report, get_ads_campaigns, and get_search_terms (Amazon-direct). Refreshed Mondays. First stop for keyword tiers (Defend/Strike/Index gap/Long shot) and rank-movement tables.',
    inputSchema: {
      type: 'object',
      properties: { brandId: { type: 'string' } },
      required: ['brandId'],
      additionalProperties: false,
    },
    handler: args => localApi(`/api/datadive/${encodeURIComponent(args.brandId)}`),
  },
  {
    name: 'get_listing_health',
    description: 'Current listing-health report across all brands: Buy Box losses (with winning seller and price), suppressed/stranded/inactive listings, unfulfillable units. Use for the catalog-health dimension of audits.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => localApi('/api/health'),
  },
];

// ── JSON-RPC over Streamable HTTP ────────────────────────────────────────────

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id != null ? msg.id : null, -32600, 'Invalid request');
  }
  // Notifications (no id) get no response body.
  if (msg.id === undefined || msg.id === null) return null;

  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params && msg.params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : '2025-03-26';
      return rpcResult(msg.id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'RMC Brand Dashboard', version: '1.0.0' },
        instructions: 'Read-only tools over the RMC brand dashboard (Amazon CA/US sales, sessions, ads, search terms, Data Dive keywords). Start with list_brands to get brand ids. Ads data is Sponsored Products only. Always state the period and pull time next to any number you quote.',
      });
    }
    case 'ping':
      return rpcResult(msg.id, {});
    case 'tools/list':
      return rpcResult(msg.id, {
        tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === (msg.params && msg.params.name));
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${msg.params && msg.params.name}`);
      try {
        const data = await tool.handler((msg.params && msg.params.arguments) || {});
        let text = JSON.stringify(data);
        if (text.length > MAX_RESULT_CHARS) {
          text = JSON.stringify({
            error: 'Result too large for chat context. Narrow the query (shorter period, full=false, includeDaily=false).',
            topLevelKeys: Object.keys(data || {}),
          });
        }
        return rpcResult(msg.id, { content: [{ type: 'text', text }], isError: false });
      } catch (err) {
        // Tool execution errors are results, not protocol errors (MCP spec).
        return rpcResult(msg.id, { content: [{ type: 'text', text: `Tool failed: ${err.message}` }], isError: true });
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

function mountMcp(app) {
  const path = `/mcp/${TOKEN}`;

  app.post(path, express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const body = req.body;
      const response = Array.isArray(body)
        ? (await Promise.all(body.map(handleMessage))).filter(Boolean)
        : await handleMessage(body);
      if (response === null || (Array.isArray(response) && response.length === 0)) {
        return res.status(202).end();
      }
      res.json(response);
    } catch (err) {
      console.error('[MCP] handler error:', err.message);
      res.status(500).json(rpcError(null, -32603, 'Internal error'));
    }
  });

  // No server-initiated streams; sessions are stateless.
  app.get(path, (req, res) => res.status(405).end());
  app.delete(path, (req, res) => res.status(200).end());

  console.log('[MCP] endpoint mounted at /mcp/<token>');
}

module.exports = { mountMcp };
