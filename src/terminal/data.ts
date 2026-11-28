// Data for the terminal mode. Keyless sources only; every field is checked and
// anything missing stays missing (the screen shows «нет данных»).

export interface Story {
  title: string;
  url: string;
  sources: number;
  time: number;
  type: string;
  typeLabel: string;
  regions: string[];
}

export interface Quote {
  symbol: string;
  name: string;
  group: string;
  unit: string;
  price: number;
  change: number | null;
  series: number[];
}

export type MarketMarkerKind = 'exchange' | 'financial-center' | 'central-bank' | 'commodity-hub';
export type MarkerKind = 'quake' | 'conflict' | 'hazard' | 'fire' | MarketMarkerKind;

export interface Marker {
  kind: MarkerKind;
  title: string;
  url: string;
  lat: number;
  lon: number;
  time: number | null;
  magnitude: number | null;
}

type Json = Record<string, unknown>;

const obj = (value: unknown): Json => (value && typeof value === 'object' ? value as Json : {});
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(obj) : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

async function getJson(url: string): Promise<Json> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return obj(await response.json());
}

function story(raw: Json): Story | null {
  const title = text(raw.titleRu) || text(raw.title);
  if (!title) return null;
  return {
    title,
    url: text(raw.url),
    sources: num(raw.sourceCount) ?? 1,
    time: num(raw.lastAt) ?? num(raw.time) ?? 0,
    type: text(raw.type),
    typeLabel: text(raw.typeLabel),
    regions: Array.isArray(raw.regions) ? raw.regions.map(text) : [text(raw.region)].filter(Boolean),
  };
}

const stories = (rows: Json[]): Story[] => rows.map(story).filter((s): s is Story => s !== null);

/** Ranked stories (most important first) from the world view. */
export async function loadWorld(): Promise<{ stories: Story[]; windowHours: number }> {
  const data = await getJson('/api/dossier?view=world&tl=ru');
  const ranked = stories([...list(data.events), ...list(data.more)]);
  if (!ranked.length) throw new Error('world: empty');
  return { stories: ranked, windowHours: num(data.windowHours) ?? 72 };
}

/** The latest headlines, newest first. */
export async function loadWire(): Promise<{ stories: Story[]; publishers: string[] }> {
  const data = await getJson('/api/dossier?view=wire&tl=ru');
  const rows = list(data.events);
  const latest = stories(rows).sort((a, b) => b.time - a.time);
  if (!latest.length) throw new Error('wire: empty');
  return { stories: latest, publishers: rows.map(row => text(row.source)).filter(Boolean) };
}

/** Publisher names in the dashboard news digest, for the source counter. */
export async function loadDigestPublishers(): Promise<string[]> {
  const data = await getJson('/api/news/v1/list-feed-digest?variant=full&lang=en');
  return Object.values(obj(data.categories))
    .flatMap(category => list(obj(category).items))
    .map(item => text(item.publisherName) || text(item.source))
    .filter(Boolean);
}

export async function loadQuotes(): Promise<Quote[]> {
  const data = await getJson('/api/dossier?view=economy&tl=ru');
  const quotes = list(data.rows).flatMap((row): Quote[] => {
    const price = num(row.price);
    if (price === null) return [];
    const series = Array.isArray(row.series)
      ? row.series.map(point => num(Array.isArray(point) ? point[1] : null)).filter((v): v is number => v !== null)
      : [];
    return [{
      symbol: text(row.symbol), name: text(row.name) || text(row.symbol), group: text(row.group),
      unit: text(row.unit), price, change: num(row.change1d), series,
    }];
  });
  if (!quotes.length) throw new Error('economy: empty');
  return quotes;
}

export async function loadQuakes(): Promise<Marker[]> {
  const data = await getJson('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson');
  return list(data.features).flatMap((feature): Marker[] => {
    const properties = obj(feature.properties);
    const coordinates = obj(feature.geometry).coordinates;
    if (!Array.isArray(coordinates)) return [];
    const lon = num(coordinates[0]);
    const lat = num(coordinates[1]);
    const magnitude = num(properties.mag);
    if (lat === null || lon === null || magnitude === null) return [];
    return [{ kind: 'quake', title: text(properties.place), url: text(properties.url), lat, lon, time: num(properties.time), magnitude }];
  }).sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0));
}

/** Open natural events (NASA EONET): wildfires as «fire», the rest as «hazard». */
export async function loadNaturalEvents(): Promise<Marker[]> {
  const data = await getJson('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30&limit=300');
  return list(data.events).flatMap((event): Marker[] => {
    const category = text(list(event.categories)[0]?.id);
    if (category === 'earthquakes') return [];
    const track = list(event.geometry);
    const geometry = track[track.length - 1];
    const coordinates = geometry?.coordinates;
    if (!Array.isArray(coordinates)) return [];
    const lon = num(coordinates[0]);
    const lat = num(coordinates[1]);
    if (lat === null || lon === null) return [];
    return [{
      kind: category === 'wildfires' ? 'fire' : 'hazard', title: text(event.title),
      url: text(list(event.sources)[0]?.url), lat, lon,
      time: Date.parse(text(geometry?.date)) || null, magnitude: null,
    }];
  }).sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
}
