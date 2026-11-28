// A light satellite globe: NASA's Blue Marble already shipped with the project,
// brightened so oceans read as blue and land keeps its relief, with thin country
// borders on top. Drawn once at runtime.

const IMAGERY_URL = '/textures/earth-blue-marble.jpg';
const COUNTRIES_URL = '/data/countries.geojson';
const WIDTH = 4096;
const HEIGHT = 2048;
/** Added in "screen" mode: lifts the near-black ocean, barely touches bright land. */
const LIFT = '#1d4d7c';
const BORDER = 'rgba(255, 255, 255, 0.42)';

interface CountryShapes {
  features: Array<{ geometry: { type: string; coordinates: unknown } | null }>;
}

let cached: Promise<string> | null = null;

function traceRing(ctx: CanvasRenderingContext2D, ring: number[][]): void {
  ring.forEach((point, index) => {
    const x = ((point[0]! + 180) / 360) * WIDTH;
    const y = ((90 - point[1]!) / 180) * HEIGHT;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

async function load(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response;
}

async function draw(resolveAsset: (path: string) => string): Promise<string> {
  const [imagery, shapes] = await Promise.all([
    load(resolveAsset(IMAGERY_URL)).then((r) => r.blob()).then(createImageBitmap),
    load(resolveAsset(COUNTRIES_URL)).then((r) => r.json() as Promise<CountryShapes>),
  ]);
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');

  // Browsers without canvas filters simply skip this and rely on the lift below.
  ctx.filter = 'brightness(1.38) saturate(1.12)';
  ctx.drawImage(imagery, 0, 0, WIDTH, HEIGHT);
  ctx.filter = 'none';
  imagery.close();
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = LIFT;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.globalCompositeOperation = 'source-over';

  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  for (const { geometry } of shapes.features) {
    if (!geometry) continue;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates as number[][][]]
      : geometry.type === 'MultiPolygon' ? geometry.coordinates as number[][][][] : [];
    for (const polygon of polygons) {
      ctx.beginPath();
      for (const ring of polygon) traceRing(ctx, ring);
      ctx.stroke();
    }
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(URL.createObjectURL(blob));
      else reject(new Error('texture encoding failed'));
    }, 'image/jpeg', 0.92);
  });
}

/** Object URL of the light texture, drawn once per page. */
export function getLightGlobeTextureUrl(resolveAsset: (path: string) => string): Promise<string> {
  cached ??= draw(resolveAsset).catch((error: unknown) => {
    cached = null;
    throw error;
  });
  return cached;
}
