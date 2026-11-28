// Dot-matrix world map: land is sampled from the shipped country shapes into a
// grid of small dots, with symbol markers on top. Static, redrawn on change.

import type { Marker, MarkerKind } from './data';

const NORTH = 82;
const SOUTH = -58;
const STEP_PX = 6;

export const MARKER_STYLE: Record<MarkerKind, { glyph: string; token: string; label: string; size?: number }> = {
  quake: { glyph: '◎', token: '--t-gold', label: 'землетрясения' },
  conflict: { glyph: '✕', token: '--t-red', label: 'зоны конфликтов' },
  hazard: { glyph: '▲', token: '--t-blue', label: 'стихия' },
  fire: { glyph: '♦', token: '--t-orange', label: 'пожары' },
  exchange: { glyph: '■', token: '--t-gold', label: 'Фондовые биржи', size: 13 },
  'financial-center': { glyph: '●', token: '--t-text', label: 'Финансовые центры', size: 13 },
  'central-bank': { glyph: '▲', token: '--t-blue', label: 'Центробанки и финансовые институты', size: 13 },
  'commodity-hub': { glyph: '◆', token: '--t-orange', label: 'Сырьевые узлы', size: 13 },
};

interface Shapes {
  features: Array<{ geometry: { type: string; coordinates: unknown } | null }>;
}

let shapes: Shapes | null = null;
let lastMask: { cols: number; rows: number; pixels: Uint8ClampedArray } | null = null;

export async function loadLand(): Promise<void> {
  const response = await fetch('/data/countries.geojson');
  if (!response.ok) throw new Error(`countries ${response.status}`);
  shapes = await response.json() as Shapes;
  lastMask = null;
}

/** One pixel per dot cell; a non-zero alpha means land. */
function landMask(cols: number, rows: number): Uint8ClampedArray | null {
  if (!shapes) return null;
  if (lastMask?.cols === cols && lastMask.rows === rows) return lastMask.pixels;
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.beginPath();
  for (const { geometry } of shapes.features) {
    if (!geometry) continue;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates as number[][][]]
      : geometry.type === 'MultiPolygon' ? geometry.coordinates as number[][][][] : [];
    for (const polygon of polygons) {
      for (const ring of polygon) {
        ring.forEach((point, index) => {
          const x = ((point[0]! + 180) / 360) * cols;
          const y = ((NORTH - point[1]!) / (NORTH - SOUTH)) * rows;
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
      }
    }
  }
  ctx.fill('evenodd');
  const pixels = ctx.getImageData(0, 0, cols, rows).data;
  lastMask = { cols, rows, pixels };
  return pixels;
}

export function drawMap(canvas: HTMLCanvasElement, markers: readonly Marker[], selected: Marker | null): void {
  const box = canvas.parentElement;
  if (!box || box.clientWidth < 40 || box.clientHeight < 40) return;
  // Fit the box, keeping the projection's proportions within reason.
  const width = box.clientWidth;
  const height = Math.min(box.clientHeight, Math.round(width * 0.62));
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  const css = getComputedStyle(canvas);
  const color = (token: string) => css.getPropertyValue(token).trim();
  const cols = Math.floor(width / STEP_PX);
  const rows = Math.floor(height / STEP_PX);
  const mask = landMask(cols, rows);
  if (mask) {
    ctx.fillStyle = color('--t-land');
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        if (mask[(row * cols + col) * 4 + 3]! > 90) {
          ctx.fillRect((col + 0.5) * (width / cols) - 1, (row + 0.5) * (height / rows) - 1, 2, 2);
        }
      }
    }
  }

  const place = (marker: Marker): [number, number] => [
    ((marker.lon + 180) / 360) * width,
    ((NORTH - marker.lat) / (NORTH - SOUTH)) * height,
  ];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const marker of markers) {
    const style = MARKER_STYLE[marker.kind];
    const size = style.size ?? (marker.kind === 'quake' ? Math.max(9, Math.min(22, (marker.magnitude ?? 3) * 3))
      : marker.kind === 'conflict' ? 15 : 10);
    ctx.font = `${size}px monospace`;
    ctx.fillStyle = color(style.token);
    const [x, y] = place(marker);
    ctx.fillText(style.glyph, x, y);
  }
  if (selected) {
    const [x, y] = place(selected);
    ctx.strokeStyle = color('--t-text');
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 10, y - 10, 20, 20);
  }
}
