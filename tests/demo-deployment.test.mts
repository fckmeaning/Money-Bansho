// Money Bansho demo deployment: own-origin CORS and the opt-in mode without
// Redis. Both must be off unless the environment asks for them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getCorsHeaders as apiCors } from '../api/_cors.js';
import { restoreDomainRequest } from '../api/_domain-rewrite';
import { BANSHO_MISSION_PANELS } from '../src/config/bansho-missions';
import { isBanshoPanelAvailable } from '../src/config/bansho-panels';
import { checkRateLimit as apiLimit } from '../api/_rate-limit.js';
import { isAllowedOrigin } from '../server/cors';
import { checkEndpointRateLimit, checkRateLimit as serverLimit } from '../server/_shared/rate-limit';

const KEYS = ['DEMO_NO_REDIS', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV', 'VERCEL_URL', 'VERCEL_PROJECT_PRODUCTION_URL'];
const saved = new Map(KEYS.map((key) => [key, process.env[key]]));
const OWN = 'https://money-bansho.vercel.app';
const PATH = '/api/news/v1/summarize-article';
const request = () => new Request(`${OWN}${PATH}`, { headers: { 'x-real-ip': '203.0.113.7' } });
const echoed = (origin: string) => apiCors(new Request(OWN, { headers: { origin } }))['Access-Control-Allow-Origin'];

beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
});
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('own production origin', () => {
  it('is refused without the deployment variables', () => {
    assert.equal(isAllowedOrigin(OWN), false);
    assert.notEqual(echoed(OWN), OWN);
  });

  it('is allowed by exact match only', () => {
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'money-bansho.vercel.app';
    assert.equal(isAllowedOrigin(OWN), true);
    assert.equal(echoed(OWN), OWN);
    for (const foreign of ['https://money-bansho-evil.vercel.app', 'https://evil.vercel.app', 'http://money-bansho.vercel.app']) {
      assert.equal(isAllowedOrigin(foreign), false, foreign);
      assert.notEqual(echoed(foreign), foreign);
    }
  });
});

describe('rate limiting without Redis', () => {
  const limits = {
    api: () => apiLimit(request(), {}, { failClosed: true }),
    server: () => serverLimit(request(), {}, { failClosed: true }),
  };

  for (const [name, run] of Object.entries(limits)) {
    it(`${name}: refuses by default when it must fail closed`, async () => {
      assert.equal((await run())?.status, 503);
    });

    it(`${name}: lets the request through in the demo mode`, async () => {
      process.env.DEMO_NO_REDIS = '1';
      assert.equal(await run(), null);
    });

    it(`${name}: keeps refusing when Redis is half configured`, async () => {
      process.env.DEMO_NO_REDIS = '1';
      process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
      assert.equal((await run())?.status, 503);
    });
  }

  it('endpoint policy: refuses by default and passes in the demo mode', async () => {
    const { ENDPOINT_RATE_POLICIES } = await import('../server/_shared/rate-limit');
    const path = Object.keys(ENDPOINT_RATE_POLICIES)[0] as string;
    assert.equal((await checkEndpointRateLimit(request(), path, {}))?.status, 503);
    process.env.DEMO_NO_REDIS = '1';
    assert.equal(await checkEndpointRateLimit(request(), path, {}), null);
  });
});

describe('dashboard tasks', () => {
  it('list only panels the dashboard can show', () => {
    for (const [id, panels] of Object.entries(BANSHO_MISSION_PANELS)) {
      assert.equal(panels[0], 'map', id);
      assert.equal(new Set(panels).size, panels.length, id);
      assert.deepEqual(panels.filter((key) => !isBanshoPanelAvailable(key)), [], id);
    }
  });
});

describe('gateway rewrite', () => {
  const query = 'bansho_domain=natural&bansho_rpc=list-natural-events&days=7';
  for (const path of ['/api/domain-gateway', '/api/natural/v1/list-natural-events']) {
    it(`restores the original request from ${path}`, () => {
      const url = new URL(restoreDomainRequest(new Request(`${OWN}${path}?${query}`)).url);
      assert.equal(url.pathname + url.search, '/api/natural/v1/list-natural-events?days=7');
    });
  }

  it('leaves other paths and unsafe names alone', () => {
    for (const target of [`/api/news/v1/list-feed-digest?${query}`, '/api/domain-gateway?bansho_domain=..&bansho_rpc=x']) {
      const untouched = new Request(`${OWN}${target}`);
      assert.equal(restoreDomainRequest(untouched), untouched);
    }
  });
});

describe('deployment files', () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

  it('keeps the shared dashboard function in the upload', () => {
    assert.ok(read('.vercelignore').split(/\r?\n/).includes('!/api/domain-gateway.ts'));
  });

  it('rewrites to the gateway exactly the domains it serves, never the four with their own function', () => {
    const served = [...read('api/domain-gateway.ts').matchAll(/server\/worldmonitor\/([a-z-]+)\/v1\/handler/g)].map((m) => m[1]);
    const rewrites: Array<{ source: string; destination: string }> = JSON.parse(read('vercel.json')).rewrites;
    const rule = rewrites.find((entry) => entry.destination.startsWith('/api/domain-gateway'));
    const listed = /:domain\(([^)]*)\)/.exec(rule?.source ?? '')?.[1]?.split('|');
    assert.deepEqual(listed, served);
    for (const own of ['news', 'market', 'intelligence', 'displacement']) assert.ok(!listed?.includes(own), own);
  });

  it('builds the deployment in demo mode', () => {
    assert.match(JSON.parse(read('package.json')).scripts['build:deploy'], /VITE_BANSHO_DEMO=1/);
  });
});
