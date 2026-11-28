// A slowly turning globe for the main menu: real country outlines (public/data) in an orthographic
// projection, with the market centres of the dossier regions linked by great circles.
import { geoDistance, geoGraticule10, geoOrthographic, geoPath } from 'd3';
import type { GeoPermissibleObjects } from 'd3';
import { feature } from 'topojson-client';

const CENTRES: Array<[number, number]> = [
  [-74, 40.7], [-0.1, 51.5], [8.7, 50.1], [34.8, 32.1], [121.5, 31.2], [114.2, 22.3], [139.7, 35.7], [127, 37.5],
];
const ROUTES: Array<[number, number]> = [[0, 1], [1, 2], [2, 3], [3, 5], [5, 4], [4, 6], [6, 7]];
const TILT = -22;
const DEGREES_PER_SECOND = 5;

let land: Promise<GeoPermissibleObjects> | null = null;
let angle = -20;

function loadLand(): Promise<GeoPermissibleObjects> {
  land ??= fetch('/data/countries-110m.json').then(async (response) => {
    if (!response.ok) throw new Error(`globe data: HTTP ${response.status}`);
    const topology = await response.json();
    return feature(topology, topology.objects.countries) as unknown as GeoPermissibleObjects;
  });
  land.catch(() => {
    land = null;
  });
  return land;
}

/** The globe canvas; it draws while it is in the document and stops by itself afterwards. */
export function createGlobe(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'sm-globe';
  canvas.setAttribute('aria-hidden', 'true');
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let countries: GeoPermissibleObjects | null = null;
  let previous = 0;

  const draw = () => {
    const ctx = canvas.getContext('2d');
    const size = canvas.clientWidth;
    if (!ctx || !size) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(size * ratio)) canvas.width = canvas.height = Math.round(size * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const style = getComputedStyle(canvas);
    const color = (name: string) => style.getPropertyValue(name).trim();
    const projection = geoOrthographic().translate([size / 2, size / 2]).scale(size / 2 - 2).rotate([angle, TILT]);
    const path = geoPath(projection, ctx);
    const paint = (shape: GeoPermissibleObjects, fill: string, stroke: string, width = 1) => {
      ctx.beginPath();
      path(shape);
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = width;
        ctx.stroke();
      }
    };
    paint({ type: 'Sphere' }, color('--globe-sea'), color('--globe-rim'), 1.5);
    paint(geoGraticule10(), '', color('--globe-grid'), 0.6);
    if (countries) paint(countries, color('--globe-land'), color('--globe-sea'), 0.6);
    for (const [from, to] of ROUTES) {
      paint({ type: 'LineString', coordinates: [CENTRES[from] as [number, number], CENTRES[to] as [number, number]] }, '', color('--sm-accent'), 1.2);
    }
    const facing: [number, number] = [-angle, -TILT];
    for (const centre of CENTRES) {
      const at = geoDistance(centre, facing) < Math.PI / 2 ? projection(centre) : null;
      if (!at) continue;
      ctx.beginPath();
      ctx.arc(at[0], at[1], 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color('--globe-dot');
      ctx.fill();
    }
  };

  const frame = (now: number) => {
    if (!canvas.isConnected) return;
    // About 30 frames a second are enough for a slow turn.
    if (now - previous >= 33) {
      if (previous && !still) angle += (DEGREES_PER_SECOND * Math.min(now - previous, 100)) / 1000;
      previous = now;
      draw();
    }
    window.requestAnimationFrame(frame);
  };
  window.requestAnimationFrame(frame);
  void loadLand().then(
    (shape) => {
      countries = shape;
      draw();
    },
    (error) => console.warn('[start-menu] no map data', error),
  );
  return canvas;
}
