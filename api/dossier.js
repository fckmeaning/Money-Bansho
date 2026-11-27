// Company dossier: quote, price history, news and filings with reputation score.
// Public, keyless upstreams only (Yahoo Finance, Google News RSS, SEC EDGAR).
import { getCorsHeaders, getPublicCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import companies from './_dossier/companies.js';
import { buildDossier, RANGE_DAYS } from './_dossier/company.js';
import { buildScreener } from './_dossier/math/market.js';
import { buildWire } from './_dossier/wire.js';
import { loadBoard } from './_dossier/yahoo.js';

export const config = { runtime: 'edge' };

// Yahoo symbols: AAPL, BRK-B, 0700.HK, ^GSPC, EURUSD=X. Nothing URL-significant.
const SYMBOL = /^\^?[A-Z0-9]+(?:[.-][A-Z0-9]+){0,2}(?:=[XF])?$/;

export function parseSymbol(value) {
  const symbol = String(value ?? '').toUpperCase();
  return symbol.length <= 20 && SYMBOL.test(symbol) ? symbol : null;
}

function respond(body, maxAge) {
  return jsonResponse(body, 200, {
    ...getPublicCorsHeaders(),
    'Cache-Control': maxAge
      ? `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=${maxAge}`
      : 'no-store',
  });
}

export default async function handler(req) {
  const cors = getCorsHeaders(req);
  if (isDisallowedOrigin(req)) return jsonResponse({ error: 'Origin not allowed' }, 403, cors);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const fail = (error, status) => jsonResponse({ error }, status, { ...cors, 'Cache-Control': 'no-store' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail('Method not allowed', 405);

  const params = new URL(req.url).searchParams;
  const view = params.get('view');
  try {
    if (view === 'board') {
      const { quotes, errors } = await loadBoard(companies.map((c) => c.symbol));
      return respond({ quotes, updatedAt: Date.now(), errors }, quotes.length ? 15 : 0);
    }
    if (view === 'wire') {
      const wire = await buildWire();
      return respond(wire, wire.events.length ? 60 : 0);
    }
    if (view === 'screener') {
      const screener = await buildScreener();
      return respond(screener, screener.rows.length ? 60 : 0);
    }
    if (view) return fail('Unknown view', 400);

    const symbol = parseSymbol(params.get('symbol'));
    if (!symbol) return fail('Invalid symbol', 400);
    const range = params.get('range') || '1mo';
    if (!Object.hasOwn(RANGE_DAYS, range)) return fail('Invalid range (use 1mo, 3mo or 1y)', 400);
    const dossier = await buildDossier(symbol, range);
    if (!dossier) return fail('Unknown symbol', 400);
    // Cache briefly when complete; never cache a response with no quote.
    return respond(dossier, dossier.quote ? 15 : 0);
  } catch (error) {
    console.error('[dossier]', error);
    return fail('Dossier unavailable', 502);
  }
}
