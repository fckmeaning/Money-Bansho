// `build:deploy` sets VITE_BANSHO_DEMO=1. In that build:
// - nothing is sold, so the free-tier caps on panels and sources do not apply
//   (see FREE_MAX_PANELS and FREE_MAX_SOURCES in ./panels);
// - the app skips /api/selfhost-key, /api/product-catalog,
//   /api/correlation-runtime-mode and /api/health. The demo has no Redis or
//   sidecar behind them (Vercel Hobby also caps a deployment at 12 functions), so
//   each caller takes the fallback it already takes for a missing route.
export const BANSHO_DEMO = import.meta.env?.VITE_BANSHO_DEMO === '1';
