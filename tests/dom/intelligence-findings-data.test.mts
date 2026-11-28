import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';

vi.mock('@/services/correlation', () => ({ getRecentSignals: () => [] }));
vi.mock('@/services/cross-module-integration', () => ({ getRecentAlerts: () => [] }));

let destroyBadge: (() => void) | undefined;

beforeEach(async () => {
  vi.resetModules();
  await initTestI18n();
});

afterEach(() => {
  destroyBadge?.();
  destroyBadge = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('shares one market request and keeps it alive for the second reader', async () => {
  const { fetchBanshoDashboardData } = await import('@/services/bansho-dashboard-data');
  let finish!: (response: Response) => void;
  const fetchSpy = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>((resolve) => { finish = resolve; }));
  vi.stubGlobal('fetch', fetchSpy);
  const query = 'view=economy&tl=ru';
  const controller = new AbortController();
  const panel = fetchBanshoDashboardData(query, controller.signal);
  const findings = fetchBanshoDashboardData(query);
  const cancelled = expect(panel).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await cancelled;
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(fetchSpy.mock.calls[0]![1].signal?.aborted).toBe(false);

  const body = { rows: [{ symbol: 'USD/KZT' }] };
  finish(Response.json(body));
  await expect(findings).resolves.toEqual(body);
  await expect(fetchBanshoDashboardData(query)).resolves.toEqual(body);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

it('cancels an abandoned shared request and lets the next reader retry', async () => {
  const { fetchBanshoDashboardData } = await import('@/services/bansho-dashboard-data');
  const fetchSpy = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  }));
  vi.stubGlobal('fetch', fetchSpy);
  const query = 'view=instability&tl=ru';
  const controller = new AbortController();
  const first = fetchBanshoDashboardData(query, controller.signal);
  const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await cancelled;
  expect(fetchSpy.mock.calls[0]![1].signal?.aborted).toBe(true);

  const body = { countries: [{ code: 'KZ' }] };
  fetchSpy.mockResolvedValueOnce(Response.json(body));
  await expect(fetchBanshoDashboardData(query)).resolves.toEqual(body);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

it('stops the scan when the last badge is removed', async () => {
  const { getBanshoFindings, subscribeBanshoFindings } = await import('@/services/bansho-findings');
  const fetchSpy = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  }));
  vi.stubGlobal('fetch', fetchSpy);
  const unsubscribe = subscribeBanshoFindings(() => {});
  expect(getBanshoFindings().status).toBe('loading');
  unsubscribe();
  await vi.waitFor(() => expect(fetchSpy.mock.calls[0]![1].signal?.aborted).toBe(true));
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

it('shows the market finding from the panel request before the wire is fetched', async () => {
  const { fetchBanshoDashboardData } = await import('@/services/bansho-dashboard-data');
  const { IntelligenceFindingsBadge } = await import('@/components/IntelligenceGapBadge');
  vi.useFakeTimers();
  const body = {
    rows: [{ symbol: 'KZT=X', name: 'USD/KZT', z1d: 2.75, change1d: 2, asOf: Date.now() }],
  };
  const fetchSpy = vi.fn(async () => Response.json(body));
  vi.stubGlobal('fetch', fetchSpy);
  const panelRequest = fetchBanshoDashboardData('view=economy&cl=en');

  document.body.innerHTML = '<div class="header-right"></div>';
  const instance = new IntelligenceFindingsBadge();
  destroyBadge = () => instance.destroy();
  const badge = document.querySelector<HTMLButtonElement>('.intel-findings-badge')!;
  badge.click();
  await expect(panelRequest).resolves.toEqual(body);
  await instance.update();

  expect(badge.querySelector('.finding-type')?.textContent).toContain('USD/KZT');
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

it.each([
  ['none', 'No recent intelligence findings'],
  ['one', 'No findings in the available sources'],
  ['all', 'Findings sources are unavailable'],
])('finishes the zero-findings scan with %s failed sources', async (failed, message) => {
  const { IntelligenceFindingsBadge } = await import('@/components/IntelligenceGapBadge');
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const responses = {
    economy: { rows: [{ symbol: 'USD/KZT', z1d: 0.1 }] },
    wire: { events: [] },
    instability: { countries: [{ code: 'KZ', index: 50, coverage: 1 }] },
    geoscore: { points: [] },
  };
  const fetchSpy = vi.fn(async (input: string) => {
    const view = new URL(input, 'https://example.test').searchParams.get('view') as keyof typeof responses;
    if (failed === 'all' || (failed === 'one' && view === 'wire')) return Response.json({}, { status: 502 });
    return Response.json(responses[view]);
  });
  vi.stubGlobal('fetch', fetchSpy);
  document.body.innerHTML = '<div class="header-right"></div>';
  const instance = new IntelligenceFindingsBadge();
  destroyBadge = () => instance.destroy();
  const badge = document.querySelector<HTMLButtonElement>('.intel-findings-badge')!;
  badge.click();
  const emptyText = () => badge.querySelector('.findings-empty .empty-text')?.textContent;
  expect(emptyText()).toBe('Scanning for correlations and anomalies...');
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(8_100);
  await instance.update();
  expect(fetchSpy).toHaveBeenCalledTimes(4);
  expect(emptyText()).toBe(message);
  expect(badge.title).toBe(message);
});
