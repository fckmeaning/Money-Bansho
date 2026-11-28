// Keyless live loaders for seed keys when no Redis exists (local dev, a free
// Vercel demo). Upstream deployments fill these keys with scripts/seed-*.mjs;
// the parsers here are reduced adaptations of those AGPL-3.0 seeders and read
// the same public, no-key sources. A source that does not answer stays absent:
// nothing is invented. Used ONLY when Upstash credentials are not set.
//
// Edge-safe: fetch and string parsing only.

const USER_AGENT = 'MoneyBansho/1.0';
const TIMEOUT_MS = 20_000;
const STALE_MAX_MS = 60 * 60_000;
const MISS_MS = 60_000;
const DAY_MS = 86_400_000;

async function get(url, accept = 'application/json', timeoutMs = TIMEOUT_MS) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new Error(`HTTP ${resp.status} from ${new URL(url).hostname}`);
  }
  return resp;
}
const getJson = async (url, accept) => (await get(url, accept)).json();
const getText = async (url, accept = '*/*') => (await get(url, accept)).text();

/** Fulfilled values only; throws when every source failed. */
async function anyOf(tasks) {
  const settled = await Promise.allSettled(tasks);
  if (settled.every((r) => r.status === 'rejected')) throw settled[0].reason;
  return settled.map((r) => (r.status === 'fulfilled' ? r.value : []));
}

function centroidOf(points) {
  if (!points.length) return undefined;
  let lon = 0;
  let lat = 0;
  for (const [x, y] of points) {
    lon += x;
    lat += y;
  }
  return [lon / points.length, lat / points.length];
}

function outerRing(geometry) {
  if (geometry?.type === 'Polygon') return geometry.coordinates[0] ?? [];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates[0]?.[0] ?? [];
  return [];
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function plainText(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? match;
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Country names ────────────────────────────────────────────────────────

const normalizeName = (name) => String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').replace(/^the /, '').trim();

let countryIndex;
function countries() {
  if (countryIndex) return countryIndex;
  const display = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
  const byName = new Map();
  const names = new Map();
  const skip = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ', 'SU', 'YU', 'CS', 'DD', 'AN', 'BU', 'TP', 'ZR', 'FX', 'NT', 'YD', 'UK']);
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = display.of(code);
      if (!name || skip.has(code)) continue;
      names.set(code, name);
      byName.set(normalizeName(name), code);
    }
  }
  const aliases = {
    'korea north': 'KP', 'north korea': 'KP', 'korea south': 'KR', 'south korea': 'KR', burma: 'MM', myanmar: 'MM',
    russia: 'RU', 'russian federation': 'RU', iran: 'IR', syria: 'SY', turkey: 'TR', 'cote d ivoire': 'CI',
    'democratic republic of the congo': 'CD', 'congo democratic republic of the': 'CD', 'republic of the congo': 'CG',
    'congo republic of the': 'CG', 'hong kong': 'HK', macau: 'MO', 'west bank': 'PS', gaza: 'PS',
    'region gaza': 'PS', 'palestinian': 'PS', 'bosnia and herzegovina': 'BA', 'czech republic': 'CZ',
    'the gambia': 'GM', 'gambia': 'GM', 'bahamas': 'BS', 'cabo verde': 'CV', 'eswatini': 'SZ',
    'virgin islands british': 'VG', 'british virgin islands': 'VG', 'saint kitts and nevis': 'KN',
    'saint lucia': 'LC', 'saint vincent and the grenadines': 'VC', 'trinidad and tobago': 'TT',
    'antigua and barbuda': 'AG', 'sao tome and principe': 'ST', 'timor leste': 'TL', 'vatican city': 'VA',
  };
  for (const [name, code] of Object.entries(aliases)) byName.set(name, code);
  const ordered = [...byName.keys()].sort((x, y) => y.length - x.length);
  countryIndex = { byName, names, ordered };
  return countryIndex;
}

/** The longest country name that appears as whole words in `text`. */
function countryInText(text) {
  const { byName, ordered } = countries();
  const haystack = ` ${normalizeName(text)} `;
  const hit = ordered.find((name) => haystack.includes(` ${name} `));
  return hit ? byName.get(hit) : '';
}

// ── Earthquakes (USGS) ───────────────────────────────────────────────────

async function earthquakes() {
  const geo = await getJson('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson');
  if (!Array.isArray(geo?.features)) throw new Error('USGS malformed response');
  return {
    earthquakes: geo.features
      .filter((f) => f?.properties && f.geometry?.coordinates)
      .map((f) => ({
        id: String(f.id || ''),
        place: String(f.properties.place || ''),
        magnitude: f.properties.mag ?? 0,
        depthKm: f.geometry.coordinates[2] ?? 0,
        location: { latitude: f.geometry.coordinates[1] ?? 0, longitude: f.geometry.coordinates[0] ?? 0 },
        occurredAt: f.properties.time > 0 ? f.properties.time : 0,
        sourceUrl: String(f.properties.url || ''),
        source: 'usgs',
      }))
      .sort((a, b) => b.occurredAt - a.occurredAt),
  };
}

// ── Natural events (NASA EONET + GDACS) ──────────────────────────────────

const GDACS_CATEGORY = { EQ: 'earthquakes', FL: 'floods', TC: 'severeStorms', VO: 'volcanoes', WF: 'wildfires', DR: 'drought' };

async function eonetEvents() {
  const data = await getJson('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30');
  if (!Array.isArray(data?.events)) throw new Error('EONET malformed response');
  const events = [];
  for (const event of data.events) {
    const category = event.categories?.[0];
    const geometry = event.geometry?.[event.geometry.length - 1];
    if (!category || category.id === 'earthquakes' || geometry?.type !== 'Point') continue;
    const date = new Date(geometry.date).getTime();
    if (category.id === 'wildfires' && Date.now() - date > 2 * DAY_MS) continue;
    const [lon, lat] = geometry.coordinates;
    events.push({
      id: event.id || '', title: event.title || '', description: event.description || '',
      category: category.id, categoryTitle: category.title || '', lat, lon, date,
      magnitude: geometry.magnitudeValue ?? 0, magnitudeUnit: geometry.magnitudeUnit || '',
      sourceUrl: event.sources?.[0]?.url || '', sourceName: event.sources?.[0]?.id || '',
      closed: event.closed !== null, forecastTrack: [], conePolygon: [], pastTrack: [],
    });
  }
  return events;
}

async function gdacsEvents() {
  const data = await getJson('https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP');
  if (!Array.isArray(data?.features)) throw new Error('GDACS malformed response');
  const seen = new Set();
  const events = [];
  for (const f of data.features) {
    const p = f?.properties;
    const category = GDACS_CATEGORY[p?.eventtype];
    if (!category || f.geometry?.type !== 'Point' || p.alertlevel === 'Green') continue;
    const id = `gdacs-${p.eventtype}-${p.eventid}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const marker = p.alertlevel === 'Red' ? '\u{1F534} ' : p.alertlevel === 'Orange' ? '\u{1F7E0} ' : '';
    const description = p.description || p.eventtype;
    const severity = p.severitydata?.severitytext || '';
    events.push({
      id, title: `${marker}${p.name || ''}`, description: `${description}${severity ? ` - ${severity}` : ''}`,
      category, categoryTitle: description,
      lat: f.geometry.coordinates[1] ?? 0, lon: f.geometry.coordinates[0] ?? 0,
      date: new Date(p.fromdate || 0).getTime(), magnitude: 0, magnitudeUnit: '',
      sourceUrl: p.url?.report || '', sourceName: 'GDACS', closed: false,
      forecastTrack: [], conePolygon: [], pastTrack: [],
    });
  }
  return events.slice(0, 100);
}

async function naturalEvents() {
  const [eonet, gdacs] = await anyOf([eonetEvents(), gdacsEvents()]);
  return { events: [...gdacs, ...eonet], fetchedAt: Date.now(), dataAvailable: true };
}

// ── Weather alerts (NWS + Environment and Climate Change Canada) ─────────

const SEVERITY_RANK = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 };
const bySeverity = (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);

function weatherAlert(feature, fields) {
  const coordinates = outerRing(feature.geometry);
  return { ...fields, coordinates, centroid: centroidOf(coordinates) };
}

async function nwsAlerts() {
  const data = await getJson('https://api.weather.gov/alerts/active', 'application/geo+json');
  if (!Array.isArray(data?.features)) throw new Error('NWS malformed response');
  return data.features
    .filter((f) => ['Extreme', 'Severe'].includes(f?.properties?.severity) && outerRing(f.geometry).length)
    .map((f) => weatherAlert(f, {
      id: f.id || '', event: f.properties.event || '', severity: f.properties.severity,
      headline: f.properties.headline || '', description: (f.properties.description || '').slice(0, 500),
      areaDesc: f.properties.areaDesc || '', onset: f.properties.onset || '', expires: f.properties.expires || '',
      countryCode: 'US', source: 'nws',
    }))
    .sort(bySeverity)
    .slice(0, 50);
}

const ECCC_SEVERITY = { red: 'Extreme', orange: 'Severe', yellow: 'Moderate' };

async function ecccAlerts() {
  const data = await getJson('https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=500&sortby=feature_id', 'application/geo+json');
  if (!Array.isArray(data?.features)) throw new Error('ECCC malformed response');
  const now = Date.now();
  return data.features
    .map((f) => {
      const p = f?.properties ?? {};
      const severity = ECCC_SEVERITY[String(p.risk_colour_en || '').toLowerCase()];
      const expires = p.expiration_datetime || p.event_end_datetime || '';
      if (!severity || String(p.status_en).toLowerCase() === 'ended' || Date.parse(expires) < now) return null;
      const event = p.alert_name_en || p.alert_short_name_en || '';
      const area = p.feature_name_en || '';
      return weatherAlert(f, {
        id: String(f.id || p.feature_id || ''), event, severity,
        headline: event && area ? `${event} — ${area}` : event || area,
        description: String(p.alert_text_en || '').slice(0, 500),
        areaDesc: [area, p.province].filter(Boolean).join(', '),
        onset: p.validity_datetime || p.publication_datetime || '', expires,
        countryCode: 'CA', source: 'eccc',
      });
    })
    .filter((alert) => alert && alert.coordinates.length)
    .sort(bySeverity)
    .slice(0, 50);
}

async function weatherAlerts() {
  const [nws, eccc] = await anyOf([nwsAlerts(), ecccAlerts()]);
  return { alerts: [...nws, ...eccc].sort(bySeverity) };
}

// ── Canada provincial alerts (BC evacuation orders and alerts) ───────────

const BC_SEVERITY = { order: 'Extreme', 'tactical evacuation': 'Extreme', alert: 'Severe' };
const isoTime = (value) => (Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : '');

async function canadaAlerts() {
  const url = new URL('https://services6.arcgis.com/ubm4tcTYICKBpist/arcgis/rest/services/Evacuation_Orders_and_Alerts/FeatureServer/0/query');
  url.searchParams.set('where', "ORDER_ALERT_STATUS IN ('Alert','Order','Tactical Evacuation')");
  url.searchParams.set('outFields', '*');
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('resultRecordCount', '200');
  url.searchParams.set('f', 'geojson');
  const data = await getJson(url.toString());
  if (!Array.isArray(data?.features)) throw new Error('BC feed malformed response');
  const alerts = [];
  for (const feature of data.features) {
    const p = feature?.properties ?? {};
    const status = String(p.ORDER_ALERT_STATUS ?? '').trim();
    const severity = BC_SEVERITY[status.toLowerCase()];
    let ring = feature.geometry?.coordinates;
    while (Array.isArray(ring?.[0]?.[0])) ring = ring[0];
    const centroid = centroidOf(ring ?? []);
    if (!severity || !centroid || !p.EMRG_OAA_SYSID) continue;
    const area = String(p.ORDER_ALERT_NAME || '').trim();
    alerts.push({
      id: `bc-evacuation-${p.EMRG_OAA_SYSID}`, province: 'BC', severity,
      event: String(p.EVENT_TYPE || status).trim(),
      headline: [String(p.EVENT_NAME || status).trim(), area].filter(Boolean).join(' — '),
      description: [status, p.ISSUING_AGENCY ? `Issued by ${p.ISSUING_AGENCY}` : ''].filter(Boolean).join('. '),
      areaDesc: area, onset: isoTime(p.EVENT_START_DATE) || isoTime(p.DATE_MODIFIED), expires: '',
      updatedAt: p.DATE_MODIFIED ?? null, lat: centroid[1], lon: centroid[0], centroid,
      url: 'https://catalogue.data.gov.bc.ca/dataset/7efd46d0-b5d3-4dff-af80-d376c42aec33', source: 'bc-emergency-info',
    });
  }
  return { alerts: alerts.sort(bySeverity) };
}

// ── Sanctions pressure (US Treasury OFAC SDN + consolidated lists) ───────

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

const csvValue = (value) => {
  const text = String(value ?? '').trim();
  return text === '-0-' ? '' : text;
};

async function ofacList(label, mainFile, addressFile) {
  const base = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/';
  const [main, addresses] = await Promise.all([getText(base + mainFile), getText(base + addressFile)]);
  const addressCountries = new Map();
  for (const row of parseCsv(addresses)) {
    const name = csvValue(row[4]);
    if (!name) continue;
    const id = csvValue(row[0]);
    if (!addressCountries.has(id)) addressCountries.set(id, new Set());
    addressCountries.get(id).add(name);
  }
  const entries = [];
  for (const row of parseCsv(main)) {
    const id = csvValue(row[0]);
    if (!/^\d+$/.test(id) || !csvValue(row[1])) continue;
    const type = csvValue(row[2]).toLowerCase();
    const { byName } = countries();
    const located = [...(addressCountries.get(id) ?? [])]
      .map((name) => [byName.get(normalizeName(name)), name])
      .filter(([code]) => code);
    const codes = [...new Set(located.map(([code]) => code))];
    entries.push({
      id: `${label}:${id}`, uid: Number(id), name: csvValue(row[1]),
      entityType: `SANCTIONS_ENTITY_TYPE_${type === 'individual' || type === 'vessel' || type === 'aircraft' ? type.toUpperCase() : 'ENTITY'}`,
      countryCodes: codes,
      countryNames: codes.map((code) => countries().names.get(code)),
      programs: csvValue(row[3]).split(/\]\s*\[|\[|\]/).map((p) => p.trim()).filter(Boolean),
      sourceLists: [label], effectiveAt: '0', isNew: false, note: csvValue(row[11]).slice(0, 240),
      parentCountryCodes: [], parentCountryNames: [],
    });
  }
  if (!entries.length) throw new Error(`OFAC ${label} list is empty`);
  return entries;
}

let ofacMemo;
function ofacEntries() {
  if (ofacMemo && Date.now() - ofacMemo.at < 6 * 60 * 60_000) return ofacMemo.task;
  const task = Promise.all([
    ofacList('SDN', 'SDN.CSV', 'ADD.CSV'),
    ofacList('CONSOLIDATED', 'CONS_PRIM.CSV', 'CONS_ADD.CSV'),
  ]);
  ofacMemo = { at: Date.now(), task };
  task.catch(() => { ofacMemo = undefined; });
  return task;
}

async function sanctionsPressure() {
  const [sdn, consolidated] = await ofacEntries();
  const entries = [...sdn, ...consolidated];
  const byCountry = new Map();
  const byProgram = new Map();
  for (const entry of entries) {
    entry.countryCodes.forEach((code, i) => {
      const row = byCountry.get(code) ?? {
        countryCode: code, countryName: entry.countryNames[i], entryCount: 0, newEntryCount: 0, vesselCount: 0, aircraftCount: 0,
      };
      row.entryCount++;
      if (entry.entityType.endsWith('VESSEL')) row.vesselCount++;
      if (entry.entityType.endsWith('AIRCRAFT')) row.aircraftCount++;
      byCountry.set(code, row);
    });
    for (const program of entry.programs) {
      const row = byProgram.get(program) ?? { program, entryCount: 0, newEntryCount: 0 };
      row.entryCount++;
      byProgram.set(program, row);
    }
  }
  const ranked = (map) => [...map.values()].sort((a, b) => b.entryCount - a.entryCount);
  return {
    // The CSV exports carry no listing date: the highest OFAC ids are the latest additions.
    entries: [...sdn].sort((a, b) => b.uid - a.uid).slice(0, 60).map(({ uid: _uid, ...entry }) => entry),
    countries: ranked(byCountry),
    flagRegistries: [], regulationTargets: [],
    programs: ranked(byProgram).slice(0, 25),
    fetchedAt: String(Date.now()), datasetDate: '0',
    totalCount: entries.length, sdnCount: sdn.length, consolidatedCount: consolidated.length, newEntryCount: 0,
    vesselCount: entries.filter((e) => e.entityType.endsWith('VESSEL')).length,
    aircraftCount: entries.filter((e) => e.entityType.endsWith('AIRCRAFT')).length,
    semaCount: 0,
  };
}

async function sanctionsCountryCounts() {
  const { countries: rows } = await sanctionsPressure();
  return Object.fromEntries(rows.map((row) => [row.countryCode, row.entryCount]));
}

// ── Disease outbreaks (WHO Disease Outbreak News) ────────────────────────

async function diseaseOutbreaks() {
  const data = await getJson('https://www.who.int/api/news/diseaseoutbreaknews?sf_culture=en&$orderby=PublicationDateAndTime%20desc&$top=30');
  if (!Array.isArray(data?.value)) throw new Error('WHO malformed response');
  const outbreaks = data.value.flatMap((item) => {
    const title = plainText(item.Title);
    const publishedAt = Date.parse(item.PublicationDateAndTime);
    if (!title || !item.ItemDefaultUrl || !Number.isFinite(publishedAt)) return [];
    const parts = title.split(/\s+[-–—]\s*|\s*[–—]\s+/);
    const place = parts.length > 1 ? parts[parts.length - 1] : '';
    const summary = plainText(item.Summary || item.Overview).slice(0, 300);
    const text = `${title} ${summary}`;
    return [{
      id: `who-${item.ItemDefaultUrl}`, disease: parts[0], location: place, countryCode: countryInText(place),
      alertLevel: /\b(outbreak|emergency|epidemic|pandemic)\b/i.test(text) ? 'alert'
        : /\b(warning|spread|cases increasing)\b/i.test(text) ? 'warning' : 'watch',
      summary, sourceUrl: `https://www.who.int/emergencies/disease-outbreak-news/item${item.ItemDefaultUrl}`,
      publishedAt, sourceName: 'WHO', lat: 0, lng: 0, cases: 0,
    }];
  });
  return { outbreaks, fetchedAt: Date.now(), alertLevelMethodologyVersion: 'v2' };
}

// ── Security advisories (US State Dept, Australia DFAT) ──────────────────

const US_LEVELS = { 4: 'do-not-travel', 3: 'reconsider', 2: 'caution', 1: 'normal' };

function advisoryLevel(title, description) {
  const us = title.match(/Level (\d)/i);
  if (us) return US_LEVELS[us[1]] ?? 'info';
  const text = `${title} ${description}`.toLowerCase();
  if (text.includes('do not travel')) return 'do-not-travel';
  if (text.includes('reconsider your need to travel')) return 'reconsider';
  if (text.includes('high degree of caution')) return 'caution';
  if (text.includes('normal safety precautions')) return 'normal';
  return 'info';
}

async function advisoryFeed(url, source, sourceCountry) {
  const xml = await getText(url, 'application/rss+xml, application/xml, text/xml');
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].flatMap(([, block]) => {
    const tag = (name) => plainText(block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1]);
    const title = tag('title');
    const link = tag('link');
    const published = Date.parse(tag('pubDate'));
    if (!title || !/^https?:\/\//.test(link) || !Number.isFinite(published)) return [];
    return [{
      title, link, pubDate: new Date(published).toISOString(), source, sourceCountry,
      level: advisoryLevel(title, tag('ta:warnings') || tag('description').slice(0, 400)),
      country: countryInText(title.split(/ [-–] | Travel Advisory/)[0]),
    }];
  });
}

async function securityAdvisories() {
  const [us, au] = await anyOf([
    advisoryFeed('https://travel.state.gov/_res/rss/TAsTWs.xml', 'US State Dept', 'US'),
    advisoryFeed('https://www.smartraveller.gov.au/countries/documents/index.rss', 'Australia DFAT Smartraveller', 'AU'),
  ]);
  const advisories = [...us, ...au].sort((a, b) => b.pubDate.localeCompare(a.pubDate));
  if (!advisories.length) throw new Error('No advisories parsed');
  const rank = { 'do-not-travel': 4, reconsider: 3, caution: 2, normal: 1 };
  const byCountry = {};
  for (const { country, level } of advisories) {
    if (country && rank[level] && rank[level] > (rank[byCountry[country]] ?? 0)) byCountry[country] = level;
  }
  return { advisories, byCountry, fetchedAt: Date.now() };
}

// ── Crypto quotes (CoinGecko public API) ─────────────────────────────────

const CRYPTO_IDS = 'bitcoin,ethereum,binancecoin,solana,ripple,cardano,dogecoin,tron,avalanche-2,chainlink';

async function cryptoQuotes() {
  const rows = await getJson(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${CRYPTO_IDS}&order=market_cap_desc&sparkline=true&price_change_percentage=24h,7d`);
  if (!Array.isArray(rows) || !rows.length) throw new Error('CoinGecko malformed response');
  return {
    quotes: rows.filter((row) => row.current_price > 0).map((row) => ({
      name: row.name, symbol: String(row.symbol).toUpperCase(), price: row.current_price,
      change: row.price_change_percentage_24h ?? 0,
      change7d: row.price_change_percentage_7d_in_currency ?? 0,
      sparkline: (row.sparkline_in_7d?.price ?? []).slice(-48),
    })),
  };
}

// ── Registry ─────────────────────────────────────────────────────────────

const MIN = 60_000;
const LOADERS = {
  'seismology:earthquakes:v1': [earthquakes, 5 * MIN],
  'natural:events:v1': [naturalEvents, 15 * MIN],
  'weather:alerts:v1': [weatherAlerts, 10 * MIN],
  'alerts:canada:v1': [canadaAlerts, 10 * MIN],
  'sanctions:pressure:v1': [sanctionsPressure, 6 * 60 * MIN],
  'sanctions:country-counts:v1': [sanctionsCountryCounts, 6 * 60 * MIN],
  'health:disease-outbreaks:v1': [diseaseOutbreaks, 60 * MIN],
  'intelligence:advisories:v1': [securityAdvisories, 60 * MIN],
  'market:crypto:v1': [cryptoQuotes, 3 * MIN],
};

const liveSeedKey = (key) => key === 'intelligence:advisories-bootstrap:v1' ? 'intelligence:advisories:v1' : key;

const cache = new Map();
const inflight = new Map();

/** False under test runners, so unit tests never reach the network. */
function enabled() {
  const env = globalThis.process?.env ?? {};
  return !env.NODE_TEST_CONTEXT && !env.VITEST;
}

export function hasLiveSeed(key) {
  return enabled() && Object.hasOwn(LOADERS, liveSeedKey(key));
}

/** Resolves with the live payload for a seed key, or `undefined`. Never rejects. */
export function readLiveSeed(key) {
  if (!hasLiveSeed(key)) return Promise.resolve(undefined);
  key = liveSeedKey(key);
  const [load, ttl] = LOADERS[key];
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.failed ? MISS_MS : ttl)) return Promise.resolve(hit.value);
  if (inflight.has(key)) return inflight.get(key);
  const task = load()
    .then((value) => {
      cache.set(key, { at: Date.now(), loadedAt: Date.now(), value });
      return value;
    })
    .catch((error) => {
      console.warn(`[live-seed] ${key}: ${error?.message ?? error}`);
      // Serve the last good payload for a limited time, never older.
      const value = hit?.value && Date.now() - hit.loadedAt < STALE_MAX_MS + ttl ? hit.value : undefined;
      cache.set(key, { at: Date.now(), loadedAt: hit?.loadedAt, value, failed: true });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

/**
 * Several seeds at once. A source slower than `deadlineMs` is left out of this
 * answer and keeps loading into the cache for the next request.
 */
export async function readLiveSeedBatch(keys, deadlineMs = 6_000) {
  const result = new Map();
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, deadlineMs); });
  await Promise.all(keys.map((key) => Promise.race([
    readLiveSeed(key).then((value) => { if (value !== undefined) result.set(key, value); }),
    deadline,
  ])));
  clearTimeout(timer);
  return new Map(result);
}
