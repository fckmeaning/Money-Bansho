// Company dossier: quote, price history, news and filings with reputation score.
// Public, keyless upstreams only (Yahoo Finance, Google News RSS, SEC EDGAR).
import { getCorsHeaders, getPublicCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { buildCoMentions } from './_dossier/comentions.js';
import { buildAtlas } from './_dossier/atlas.js';
import companies from './_dossier/companies.js';
import { buildDossier, RANGE_DAYS } from './_dossier/company.js';
import { buildEconomy } from './_dossier/economy.js';
import { buildGeoscore } from './_dossier/geoscore-data.js';
import { buildInstability } from './_dossier/instability-data.js';
import { explainDossier, explainEconomy, explainWire, explainWorld } from './_dossier/math/consequences.js';
import { buildScreener } from './_dossier/math/market.js';
import { withTranslations } from './_dossier/translate.js';
import { buildWire } from './_dossier/wire.js';
import { buildWorld } from './_dossier/world.js';
import { loadBoard } from './_dossier/yahoo.js';

export const config = { runtime: 'edge' };

// An edge response must start within 25 s: translation only gets what is left before this.
const RESPONSE_DEADLINE_MS = 23_500;
const TRANSLATE_MAX_MS = 3500;

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
  const startedAt = Date.now();
  // ?tl=ru adds Russian headlines (`titleRu`); analysis always uses the originals.
  const localize = (body) => {
    if (params.get('tl') !== 'ru') return body;
    const left = RESPONSE_DEADLINE_MS - (Date.now() - startedAt);
    return withTranslations(body, { budgetMs: Math.max(0, Math.min(TRANSLATE_MAX_MS, left)) });
  };
  // Every event gets `consequences` (docs/math/consequences.md), in Russian unless ?cl=en.
  const lang = params.get('cl') === 'en' ? 'en' : 'ru';
  try {
    if (view === 'board') {
      const { quotes, errors } = await loadBoard(companies.map((c) => c.symbol));
      return respond({ quotes, updatedAt: Date.now(), errors }, quotes.length ? 15 : 0);
    }
    if (view === 'wire') {
      const wire = await buildWire();
      return respond(await localize(explainWire(wire, lang)), wire.events.length ? 60 : 0);
    }
    if (view === 'screener') {
      const screener = await buildScreener();
      return respond(screener, screener.rows.length ? 60 : 0);
    }
    if (view === 'analytics') {
      // Market atlas: all companies, correlations, networks and regions.
      const atlas = await buildAtlas();
      return respond(atlas, atlas.rows.length ? 60 : 0);
    }
    if (view === 'comentions') {
      const mentions = await buildCoMentions();
      return respond(await localize(mentions), mentions.sample.headlines ? 120 : 0);
    }
    if (view === 'economy') {
      const economy = await buildEconomy();
      return respond(await localize(explainEconomy(economy, lang)), economy.rows.length ? 60 : 0);
    }
    if (view === 'world') {
      const world = await buildWorld();
      return respond(await localize(explainWorld(world, lang)), world.events.length ? 60 : 0);
    }
    if (view === 'instability') {
      const instability = await buildInstability({ country: params.get('country')?.toUpperCase() });
      // A GDELT refusal is transient: do not let it be cached for long.
      return respond(await localize(instability), instability.degraded || instability.gdelt?.reason ? 30 : 300);
    }
    if (view === 'geoscore') {
      // ?point=layer:id or ?lat=&lon= scores one marker; otherwise the ranked list.
      const number = (key) => (params.get(key) ? Number(params.get(key)) : null);
      const geoscore = await buildGeoscore({
        point: params.get('point'),
        lat: number('lat'),
        lon: number('lon'),
        name: params.get('name') ?? '',
        country: params.get('country') ?? '',
        limit: number('limit') ?? 40,
      });
      // An answer without the index or the world events is cached only briefly.
      const complete = geoscore.sources.instability && geoscore.sources.world;
      return respond(await localize(geoscore), complete ? 120 : 20);
    }
    if (view) return fail('Unknown view', 400);

    const symbol = parseSymbol(params.get('symbol'));
    if (!symbol) return fail('Invalid symbol', 400);
    const range = params.get('range') || '1mo';
    if (!Object.hasOwn(RANGE_DAYS, range)) return fail('Invalid range (use 1mo, 3mo or 1y)', 400);
    const dossier = await buildDossier(symbol, range);
    if (!dossier) return fail('Unknown symbol', 400);
    // Cache briefly when complete; never cache a response with no quote.
    return respond(await localize(explainDossier(dossier, lang)), dossier.quote ? 15 : 0);
  } catch (error) {
    console.error('[dossier]', error);
    return fail('Dossier unavailable', 502);
  }
}
