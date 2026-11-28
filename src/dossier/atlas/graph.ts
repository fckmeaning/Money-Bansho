// Interaction graph: a force-directed network of companies. Two kinds of links,
// both measured: correlation of returns and joint mentions in headlines. The
// layout is computed once per setting and then stays still; nodes can be dragged.
import {
  drag,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  select,
  zoom,
  zoomIdentity,
} from 'd3';
import type { SimulationLinkDatum, SimulationNodeDatum, ZoomTransform } from 'd3';
import { formatValue, fullDate, num, pct } from '../analytics/format';
import { empty, note, observeWidth, panel, picker, segmented } from '../analytics/ui';
import { companies } from '../companies';
import { h, link, s } from '../dom';
import { grid, markerPath, regionClass, regionKey, regionName, regionsOf, tickerLink } from './common';
import type { Context, GridColumn, GridState, Section } from './common';
import type { CoMentions, Frequency, GraphMetrics, MentionEdge, Nullable } from './data';
import { formulas } from './formulas';
import type { Key } from './strings';

type Kind = 'corr' | 'news';
type Mode = 'threshold' | 'tree';
type Size = 'turnover' | 'vol' | 'degree' | 'rank' | 'between' | 'mentions';

const SIZE_KEYS: [Size, Key][] = [
  ['turnover', 'sizeTurnover'],
  ['vol', 'sizeVol'],
  ['degree', 'sizeDegree'],
  ['rank', 'sizeRank'],
  ['between', 'sizeBetween'],
  ['mentions', 'sizeMentions'],
];

const memory = {
  kind: 'corr' as Kind,
  frequency: 'daily' as Frequency,
  mode: 'threshold' as Mode,
  corrLevel: 4,
  newsLevel: 0,
  size: 'turnover' as Size,
  node: '' as string,
  edge: null as [string, string] | null,
  sort: { sort: 'pagerank', dir: -1 } as GridState,
};

interface Dot extends SimulationNodeDatum {
  id: number;
  symbol: string;
  name: string;
  region: string;
  r: number;
}
interface Link extends SimulationLinkDatum<Dot> {
  a: number;
  b: number;
  /** Correlation, or the number of joint stories. */
  value: number;
  width: number;
}
interface Drawn {
  nodes: Dot[];
  links: Link[];
  metrics: GraphMetrics;
  symbols: string[];
}

const pairKey = (a: string, b: string) => [a, b].sort().join('|');

export function graphSection(context: Context): Section {
  const { atlas, lang, t, open } = context;
  const byRow = new Map(atlas.rows.map((r) => [r.symbol, r]));
  const listed = new Map(companies.map((c) => [c.symbol, c]));
  let news: CoMentions | null = null;
  let newsFailed = false;
  let newsRunning = false;
  let disposed = false;
  let drawn: Drawn | null = null;
  let width = 0;
  let transform: ZoomTransform = zoomIdentity;
  let paintSelection = () => {};
  let controls: { zoomBy(f: number): void; fit(): void } | null = null;

  const nameOfSymbol = (symbol: string) => byRow.get(symbol)?.name ?? listed.get(symbol)?.name ?? symbol;
  const regionOfSymbol = (symbol: string) => byRow.get(symbol)?.region ?? listed.get(symbol)?.region ?? 'other';

  // ---- data of the current setting ----------------------------------------

  const newsEdge = (a: string, b: string): MentionEdge | undefined => {
    if (!news) return undefined;
    const i = news.symbols.indexOf(a);
    const j = news.symbols.indexOf(b);
    return news.edges.find((e) => (e.a === i && e.b === j) || (e.a === j && e.b === i));
  };

  const corrOf = (a: string, b: string, frequency: Frequency): { rho: Nullable; n: Nullable } => {
    const i = atlas.rows.findIndex((r) => r.symbol === a);
    const j = atlas.rows.findIndex((r) => r.symbol === b);
    const overlap = frequency === 'daily' ? atlas.correlation.overlap : atlas.correlation.overlapWeekly;
    return { rho: atlas.correlation[frequency][i]?.[j] ?? null, n: overlap[i]?.[j] ?? null };
  };

  const current = (): { symbols: string[]; edges: { a: number; b: number; value: number }[]; metrics: GraphMetrics } | null => {
    if (memory.kind === 'corr') {
      const network = atlas.network[memory.frequency];
      const matrix = atlas.correlation[memory.frequency];
      const symbols = atlas.rows.map((r) => r.symbol);
      if (memory.mode === 'tree') {
        return {
          symbols,
          metrics: network.mst.metrics,
          edges: network.mst.edges.map(([a, b]) => ({ a, b, value: matrix[a]?.[b] ?? 0 })),
        };
      }
      const level = network.levels[Math.min(memory.corrLevel, network.levels.length - 1)];
      if (!level) return null;
      const edges: { a: number; b: number; value: number }[] = [];
      for (let a = 0; a < symbols.length; a += 1) {
        for (let b = a + 1; b < symbols.length; b += 1) {
          const rho = matrix[a]?.[b];
          if (typeof rho === 'number' && rho >= level.threshold) edges.push({ a, b, value: rho });
        }
      }
      return { symbols, edges, metrics: level.metrics };
    }
    if (!news) return null;
    const { network } = news;
    if (memory.mode === 'tree') {
      const counts = new Map(news.edges.map((e) => [`${e.a}:${e.b}`, e.count]));
      return {
        symbols: news.symbols,
        metrics: network.mst.metrics,
        edges: network.mst.edges.map(([a, b]) => ({ a, b, value: counts.get(`${Math.min(a, b)}:${Math.max(a, b)}`) ?? 1 })),
      };
    }
    const level = network.levels[Math.min(memory.newsLevel, network.levels.length - 1)];
    if (!level) return null;
    return {
      symbols: news.symbols,
      metrics: level.metrics,
      edges: news.edges.filter((e) => e.count >= level.threshold).map((e) => ({ a: e.a, b: e.b, value: e.count })),
    };
  };

  const sizeValue = (symbol: string, i: number, metrics: GraphMetrics): Nullable => {
    switch (memory.size) {
      case 'turnover':
        return byRow.get(symbol)?.values.turnoverUsd ?? null;
      case 'vol':
        return byRow.get(symbol)?.values.vol1y ?? null;
      case 'degree':
        return metrics.degree[i] ?? null;
      case 'rank':
        return metrics.pagerank[i] ?? null;
      case 'between':
        return metrics.betweenness[i] ?? null;
      default:
        return news ? (news.mentions[news.symbols.indexOf(symbol)] ?? null) : null;
    }
  };

  const radii = (symbols: string[], metrics: GraphMetrics): number[] => {
    const values = symbols.map((symbol, i) => sizeValue(symbol, i, metrics));
    const top = Math.max(...values.map((v) => v ?? 0), 1e-12);
    const small = width < 600 ? 0.8 : 1;
    return values.map((v) => (4 + 11 * Math.sqrt(Math.max(0, v ?? 0) / top)) * small);
  };

  // ---- nodes of the page ----------------------------------------------------

  const stage = h('div', { class: 'mbx-plot atl-stage' });
  const side = h('div', { class: 'atl-side', 'aria-live': 'polite' });
  const stats = h('dl', { class: 'atl-stats' });
  const isolated = h('div', { class: 'atl-isolated' });
  const caveat = h('p', { class: 'mbx-note atl-caveat' });
  const levelLabel = h('span', {});
  const levelHost = h('div', { class: 'atl-level' });
  const communities = h('div', {});

  const table = grid<number>({
    lang,
    caption: t('netTable'),
    noData: t('noData'),
    state: memory.sort,
    onOpen: (i) => {
      selectNode(drawn?.symbols[i] ?? '');
      stage.scrollIntoView({ block: 'nearest' });
    },
    selected: (i) => drawn?.symbols[i] === memory.node,
    limit: 15,
    more: (left) => t('more', { left, n: left }),
    className: 'atl-net',
  });

  // ---- selection panel ------------------------------------------------------

  const fact = (label: string, value: string | null) =>
    h('div', {}, h('dt', {}, label), h('dd', {}, value ?? h('span', { class: 'mbx-missing' }, t('noData'))));
  const metric = (v: Nullable | undefined, digits = 3) => (v === null || v === undefined ? null : num(v, lang, 0, digits));
  const rhoText = (v: Nullable) => (v === null ? null : formatValue(v, 'ratio', lang, true));

  const interval = (rho: Nullable, n: Nullable): string | null => {
    if (rho === null || n === null || n <= 3 || Math.abs(rho) >= 1) return null;
    const z = Math.atanh(rho);
    const half = 1.96 / Math.sqrt(n - 3);
    return `${rhoText(Math.tanh(z - half))} … ${rhoText(Math.tanh(z + half))}`;
  };

  const headlines = (edge: MentionEdge) =>
    h(
      'ul',
      { class: 'atl-news' },
      ...edge.items.map((item) =>
        h(
          'li',
          {},
          link(item.url, item.title, 'atl-headline'),
          h(
            'span',
            { class: 'mbx-count' },
            `${item.source} · ${fullDate(item.time, lang)}${item.copies > 1 ? ` · ${t('copies', { n: item.copies })}` : ''}`,
          ),
        ),
      ),
    );

  const clearButton = () =>
    h(
      'button',
      {
        type: 'button',
        class: 'mbx-button',
        onclick: () => {
          memory.node = '';
          memory.edge = null;
          refreshSelection();
        },
      },
      t('clear'),
    );

  const drawSide = () => {
    if (!drawn) {
      side.replaceChildren();
      return;
    }
    const show = (...parts: (Node | null)[]) => side.replaceChildren(...parts.filter((part): part is Node => part !== null));
    if (memory.edge) {
      const [a, b] = memory.edge;
      const daily = corrOf(a, b, 'daily');
      const weekly = corrOf(a, b, 'weekly');
      const joint = newsEdge(a, b);
      show(
        h('h4', {}, t('pairTitle', { a, b })),
        h('p', { class: 'mbx-count' }, `${nameOfSymbol(a)} — ${nameOfSymbol(b)}`),
        h(
          'dl',
          { class: 'atl-facts' },
          fact(t('rhoDaily'), rhoText(daily.rho)),
          fact(t('interval'), interval(daily.rho, daily.n)),
          fact(t('observations'), metric(daily.n, 0)),
          fact(t('rhoWeekly'), rhoText(weekly.rho)),
          fact(t('stories'), news ? String(joint?.count ?? 0) : null),
          ...(joint ? [fact(t('weight'), metric(joint.weight)), fact(t('jaccard'), metric(joint.jaccard)), fact(t('lift'), metric(joint.lift, 2))] : []),
        ),
        joint ? h('h5', {}, t('headlines')) : null,
        joint ? headlines(joint) : null,
        h(
          'div',
          { class: 'mbx-toolbar' },
          ...[a, b].map((symbol) =>
            h('button', { type: 'button', class: 'mbx-button', onclick: () => open(symbol) }, `${t('openDossier')}: ${symbol}`),
          ),
          clearButton(),
        ),
      );
      return;
    }
    const i = drawn.symbols.indexOf(memory.node);
    if (i < 0) {
      side.replaceChildren(h('h4', {}, t('selectedTitle')), h('p', { class: 'mbx-empty' }, t('selectHint')));
      return;
    }
    const symbol = memory.node;
    const { metrics } = drawn;
    const row = byRow.get(symbol);
    const near = drawn.links
      .filter((l) => l.a === i || l.b === i)
      .map((l) => ({ symbol: drawn?.symbols[l.a === i ? l.b : l.a] ?? '', value: l.value }))
      .sort((x, y) => y.value - x.value);
    side.replaceChildren(
      h('h4', {}, `${symbol} · ${nameOfSymbol(symbol)}`),
      h('p', { class: 'mbx-count' }, regionKey(regionOfSymbol(symbol), lang)),
      h(
        'dl',
        { class: 'atl-facts' },
        fact(t('degree'), metric(metrics.degree[i], 0)),
        fact(t('strength'), metric(metrics.strength[i])),
        fact(t('pagerank'), metric(metrics.pagerank[i], 4)),
        fact(t('betweenness'), metric(metrics.betweenness[i], 4)),
        fact(t('closeness'), metric(metrics.closeness[i])),
        fact(t('clustering'), metric(metrics.clustering[i])),
        fact(t('community'), metric(metrics.community[i], 0)),
        fact(t('mentions'), news ? metric(news.mentions[news.symbols.indexOf(symbol)], 0) : newsRunning ? '…' : null),
        fact(t('sizeVol'), row?.values.vol1y == null ? null : pct(row.values.vol1y, lang, false)),
        fact(t('sizeTurnover'), row?.values.turnoverUsd == null ? null : formatValue(row.values.turnoverUsd, 'money', lang)),
      ),
      h(
        'div',
        { class: 'mbx-toolbar' },
        h('button', { type: 'button', class: 'mbx-button atl-primary', onclick: () => open(symbol) }, t('openDossier')),
        clearButton(),
      ),
      h('h5', {}, t('neighbours', { n: near.length })),
      near.length
        ? h(
            'ul',
            { class: 'atl-near' },
            ...near.map((n) =>
              h(
                'li',
                {},
                h(
                  'button',
                  { type: 'button', onclick: () => selectEdge(symbol, n.symbol) },
                  h('b', {}, n.symbol),
                  h('span', {}, nameOfSymbol(n.symbol)),
                  h('i', {}, memory.kind === 'corr' ? (rhoText(n.value) ?? '') : String(n.value)),
                ),
              ),
            ),
          )
        : h('p', { class: 'mbx-empty' }, t('noLinks')),
    );
  };

  const refreshSelection = () => {
    paintSelection();
    drawSide();
    drawTable();
    find.select.value = memory.node;
  };
  const selectNode = (symbol: string) => {
    memory.node = symbol;
    memory.edge = null;
    refreshSelection();
  };
  const selectEdge = (a: string, b: string) => {
    memory.edge = [a, b];
    refreshSelection();
  };

  // ---- the picture ------------------------------------------------------------

  const picture = () => {
    controls = null;
    paintSelection = () => {};
    const state = drawn;
    if (!state || width < 40) return;
    const linked = new Set(state.links.flatMap((l) => [l.a, l.b]));
    const nodes = state.nodes.filter((n) => linked.has(n.id));
    if (!nodes.length) {
      stage.replaceChildren(empty(lang, t('noLinks')));
      return;
    }
    const height = width < 600 ? 430 : Math.max(520, Math.min(700, Math.round(width * 0.7)));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = state.links.map((l) => ({ ...l, source: byId.get(l.a) as Dot, target: byId.get(l.b) as Dot }));
    for (const n of nodes) {
      n.x = undefined;
      n.y = undefined;
      n.vx = 0;
      n.vy = 0;
    }
    const tree = memory.mode === 'tree';
    const dense = links.length / nodes.length;
    const simulation = forceSimulation<Dot>(nodes)
      .force(
        'link',
        forceLink<Dot, SimulationLinkDatum<Dot>>(links as unknown as SimulationLinkDatum<Dot>[])
          .distance(tree ? 42 : 48 + Math.min(40, dense * 8))
          .strength(tree ? 0.8 : Math.min(0.6, 1.2 / Math.max(1, dense))),
      )
      .force('charge', forceManyBody<Dot>().strength(tree ? -190 : -240))
      // Gravity keeps separate parts on screen; the wider side gets more room.
      .force('x', forceX<Dot>(0).strength(width < 600 ? 0.12 : 0.06))
      .force('y', forceY<Dot>(0).strength(width < 600 ? 0.07 : 0.1))
      .force('collide', forceCollide<Dot>((n) => n.r + 7))
      .stop();
    // Settled before it is shown: nothing moves on its own.
    simulation.tick(400);

    const svg = s('svg', {
      class: 'atl-graph',
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: 'group',
      'aria-label': t('graphAria', { n: nodes.length, m: links.length }),
    });
    const world = s('g', {});
    const edgeLayer = s('g', {});
    const nodeLayer = s('g', {});
    world.append(edgeLayer, nodeLayer);
    svg.append(world);

    const edgeNodes = links.map((l) => {
      const a = state.symbols[l.a] as string;
      const b = state.symbols[l.b] as string;
      const value = memory.kind === 'corr' ? (rhoText(l.value) ?? '') : String(l.value);
      const visible = s('line', { class: 'atl-edge', 'stroke-width': l.width });
      const hit = s('line', { class: 'atl-edge-hit', onclick: () => selectEdge(a, b) }, s('title', {}, `${a} — ${b}: ${value}`));
      edgeLayer.append(visible, hit);
      return { l, a, b, visible, hit };
    });
    const nodeNodes = nodes.map((n) => {
      const mark = s('path', { class: `atl-mark ${regionClass(n.region)}`, d: markerPath(n.region, n.r) });
      const label = s('text', { class: 'atl-label', y: n.r + 10, 'text-anchor': 'middle' }, n.symbol);
      const g = s(
        'g',
        {
          class: 'atl-node',
          tabindex: 0,
          role: 'button',
          'aria-label': `${n.symbol} ${n.name}`,
          onclick: () => selectNode(n.symbol),
          ondblclick: (event: Event) => {
            event.stopPropagation();
            open(n.symbol);
          },
          onkeydown: (event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              selectNode(n.symbol);
            }
          },
        },
        s('circle', { class: 'atl-halo', r: n.r + 4 }),
        mark,
        label,
        s('title', {}, `${n.symbol} · ${n.name}`),
      );
      nodeLayer.append(g);
      return { n, g, label };
    });

    const place = () => {
      for (const { l, visible, hit } of edgeNodes) {
        for (const line of [visible, hit]) {
          line.setAttribute('x1', (l.source.x ?? 0).toFixed(1));
          line.setAttribute('y1', (l.source.y ?? 0).toFixed(1));
          line.setAttribute('x2', (l.target.x ?? 0).toFixed(1));
          line.setAttribute('y2', (l.target.y ?? 0).toFixed(1));
        }
      }
      for (const { n, g } of nodeNodes) g.setAttribute('transform', `translate(${(n.x ?? 0).toFixed(1)},${(n.y ?? 0).toFixed(1)})`);
    };
    place();

    // On small pictures only the larger nodes and the selection keep their names.
    const ranked = [...nodes].sort((a, b) => b.r - a.r);
    const major = new Set(ranked.slice(0, width < 600 ? 14 : nodes.length).map((n) => n.symbol));
    const relabel = () => {
      const k = transform.k;
      const size = Math.max(5, Math.min(18, (width < 600 ? 10 : 11) / k));
      for (const { n, label } of nodeNodes) {
        label.setAttribute('font-size', size.toFixed(2));
        label.setAttribute('y', (n.r + size).toFixed(1));
        label.classList.toggle('minor', !major.has(n.symbol) && k < 1.4);
      }
    };

    const behaviour = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 6])
      .extent([[0, 0], [width, height]])
      .on('zoom', (event: { transform: ZoomTransform }) => {
        transform = event.transform;
        world.setAttribute('transform', transform.toString());
        relabel();
      });
    const target = select<SVGSVGElement, unknown>(svg);
    target.call(behaviour).on('dblclick.zoom', null);

    select<SVGGElement, unknown>(nodeLayer)
      .selectAll<SVGGElement, unknown>('g.atl-node')
      .data(nodes)
      .call(
        drag<SVGGElement, Dot>()
          .clickDistance(5)
          .container(() => world)
          .subject((_, n) => ({ x: n.x ?? 0, y: n.y ?? 0 }))
          .on('drag', (event: { x: number; y: number }, n) => {
            n.x = event.x;
            n.y = event.y;
            place();
          }) as never,
      );

    const fit = () => {
      const xs = nodes.map((n) => n.x ?? 0);
      const ys = nodes.map((n) => n.y ?? 0);
      const pad = 28;
      const [x0, x1, y0, y1] = [Math.min(...xs) - pad, Math.max(...xs) + pad, Math.min(...ys) - pad, Math.max(...ys) + pad];
      const k = Math.min(2, width / (x1 - x0), height / (y1 - y0));
      target.call(
        behaviour.transform,
        zoomIdentity.translate(width / 2 - (k * (x0 + x1)) / 2, height / 2 - (k * (y0 + y1)) / 2).scale(k),
      );
    };
    controls = { fit, zoomBy: (factor) => target.call(behaviour.scaleBy, factor) };

    paintSelection = () => {
      const chosen = memory.edge ? new Set(memory.edge) : memory.node ? new Set([memory.node]) : null;
      const focus = chosen && nodes.some((n) => chosen.has(n.symbol)) ? chosen : null;
      const near = new Set(focus ?? []);
      for (const { a, b, visible } of edgeNodes) {
        const on = memory.edge
          ? pairKey(a, b) === pairKey(...memory.edge)
          : Boolean(focus && (focus.has(a) || focus.has(b)));
        visible.classList.toggle('on', on);
        visible.classList.toggle('off', Boolean(focus) && !on);
        if (on) {
          near.add(a);
          near.add(b);
        }
      }
      for (const { n, g, label } of nodeNodes) {
        g.classList.toggle('on', Boolean(focus?.has(n.symbol)));
        g.classList.toggle('off', Boolean(focus) && !near.has(n.symbol));
        label.classList.toggle('near', Boolean(focus) && near.has(n.symbol));
      }
    };

    stage.replaceChildren(svg);
    fit();
    relabel();
    paintSelection();
  };

  // ---- tables under the picture ---------------------------------------------

  const drawStats = () => {
    const summary = drawn?.metrics.summary;
    if (!summary) {
      stats.replaceChildren();
      return;
    }
    stats.replaceChildren(
      fact(t('sNodes'), `${summary.linked} / ${summary.nodes}`),
      fact(t('sEdges'), num(summary.edges, lang)),
      fact(t('sDensity'), metric(summary.density, 4)),
      fact(t('sClustering'), metric(summary.clustering)),
      fact(t('sModularity'), metric(summary.modularity)),
      fact(t('sCommunities'), String(summary.communities)),
      fact(t('sComponents'), String(summary.components)),
    );
  };

  const drawTable = () => {
    if (!drawn) {
      table.set([], []);
      return;
    }
    const { symbols, metrics } = drawn;
    const symbol = (i: number) => symbols[i] as string;
    const column = (id: keyof Omit<GraphMetrics, 'summary'>, label: Key, digits: number): GridColumn<number> => ({
      id,
      label: t(label),
      numeric: true,
      value: (i) => metrics[id][i] ?? null,
      cell: (i) => metric(metrics[id][i], digits),
    });
    const columns: GridColumn<number>[] = [
      {
        id: 'symbol',
        label: t('symbol'),
        value: symbol,
        cell: (i) => tickerLink(symbol(i), open),
      },
      { id: 'company', label: t('company'), value: (i) => nameOfSymbol(symbol(i)) },
      {
        id: 'region',
        label: t('region'),
        value: (i) => regionName(regionOfSymbol(symbol(i)), lang),
        cell: (i) => regionKey(regionOfSymbol(symbol(i)), lang),
      },
      column('degree', 'degree', 0),
      column('strength', 'strength', 3),
      column('pagerank', 'pagerank', 4),
      column('betweenness', 'betweenness', 4),
      column('closeness', 'closeness', 3),
      column('clustering', 'clustering', 3),
      column('community', 'community', 0),
      {
        id: 'mentions',
        label: t('mentions'),
        numeric: true,
        value: (i) => (news ? (news.mentions[news.symbols.indexOf(symbol(i))] ?? null) : null),
      },
    ];
    table.set(columns, symbols.map((_, i) => i));
  };

  const drawCommunities = () => {
    if (!drawn || !drawn.metrics.summary.communities) {
      communities.replaceChildren(empty(lang, t('noLinks')));
      return;
    }
    const { metrics, symbols, links } = drawn;
    const groups = new Map<number, number[]>();
    metrics.community.forEach((c, i) => {
      if (c === null) return;
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c)?.push(i);
    });
    const rows = [...groups].sort((a, b) => a[0] - b[0]).map(([id, members]) => {
      const regions = new Map<string, number>();
      for (const i of members) {
        const region = regionOfSymbol(symbols[i] as string);
        regions.set(region, (regions.get(region) ?? 0) + 1);
      }
      const [region, count] = [...regions].sort((a, b) => b[1] - a[1])[0] as [string, number];
      const inner = links.filter((l) => metrics.community[l.a] === id && metrics.community[l.b] === id).map((l) => l.value);
      const mean = inner.length ? inner.reduce((sum, v) => sum + v, 0) / inner.length : null;
      return h(
        'tr',
        {},
        h('th', { scope: 'row', class: 'num' }, String(id)),
        h('td', { class: 'num' }, String(members.length)),
        h('td', {}, `${regionName(region, lang)} ${count}/${members.length}`),
        h('td', { class: 'num' }, metric(mean) ?? t('noData')),
        h(
          'td',
          { class: 'atl-members' },
          ...[...members]
            .sort((a, b) => (metrics.strength[b] ?? 0) - (metrics.strength[a] ?? 0))
            .map((i) =>
              h(
                'button',
                { type: 'button', class: 'mbx-link', title: nameOfSymbol(symbols[i] as string), onclick: () => { selectNode(symbols[i] as string); stage.scrollIntoView({ block: 'nearest' }); } },
                symbols[i] as string,
              ),
            ),
        ),
      );
    });
    const head = (label: Key, numeric = false) => h('th', { scope: 'col', class: numeric ? 'num' : '' }, t(label));
    communities.replaceChildren(
      h(
        'div',
        { class: 'mbx-scroll atl-scroll' },
        h(
          'table',
          { class: 'mbx-table' },
          h('caption', { class: 'mbx-sr' }, t('communitiesTitle')),
          h('thead', {}, h('tr', {}, head('community', true), head('size', true), head('mainRegion'), head('innerLink', true), head('members'))),
          h('tbody', {}, ...rows),
        ),
      ),
    );
  };

  const drawIsolated = () => {
    const list = drawn ? drawn.symbols.filter((_, i) => !drawn?.metrics.degree[i]) : [];
    isolated.replaceChildren();
    if (!list.length) return;
    isolated.append(
      h('span', { class: 'mbx-count' }, `${t('isolated', { n: list.length })}:`),
      ...list.map((symbol) =>
        h('button', { type: 'button', class: 'mbx-link', title: nameOfSymbol(symbol), onclick: () => selectNode(symbol) }, symbol),
      ),
    );
  };

  const drawCaveat = () => {
    if (memory.kind === 'corr') caveat.textContent = t('corrNote');
    else if (news) {
      caveat.textContent = t('newsNote', {
        headlines: news.sample.headlines,
        days: news.windowDays,
        searched: news.sample.searched,
        published: news.sample.published,
        ok: news.sample.feedsAnswered,
        asked: news.sample.feedsAsked,
        linking: news.linkingStories,
      });
    } else caveat.textContent = '';
  };

  /** Rebuilds everything after a change of the setting or new data. */
  const rebuild = () => {
    const next = current();
    if (!next) {
      drawn = null;
      controls = null;
      const waiting = memory.kind === 'news' && !newsFailed;
      stage.replaceChildren(
        waiting
          ? empty(lang, t('loadingNews'))
          : h(
              'div',
              { class: 'mbx-empty' },
              `${t('failed')} `,
              h('button', { type: 'button', class: 'mbx-button', onclick: () => { newsFailed = false; needNews(); rebuild(); } }, t('retry')),
            ),
      );
    } else {
      const r = radii(next.symbols, next.metrics);
      const top = Math.max(...next.edges.map((e) => e.value), 1e-9);
      drawn = {
        symbols: next.symbols,
        metrics: next.metrics,
        nodes: next.symbols.map((symbol, id) => ({
          id,
          symbol,
          name: nameOfSymbol(symbol),
          region: regionOfSymbol(symbol),
          r: r[id] as number,
        })),
        links: next.edges.map((e) => ({
          ...e,
          source: e.a,
          target: e.b,
          width:
            memory.kind === 'corr'
              ? 0.6 + 4 * Math.max(0, (e.value - 0.2) / 0.8)
              : 0.8 + 4.2 * Math.sqrt(e.value / top),
        })),
      };
      transform = zoomIdentity;
      picture();
    }
    drawCaveat();
    drawStats();
    drawIsolated();
    drawSide();
    drawTable();
    drawCommunities();
    drawLevel();
  };

  const needNews = () => {
    if (news || newsRunning) return;
    newsRunning = true;
    context.news().then(
      (value) => {
        newsRunning = false;
        news = value;
        if (disposed) return;
        if (memory.kind === 'news' || memory.size === 'mentions') rebuild();
        else {
          drawSide();
          drawTable();
        }
      },
      (error) => {
        newsRunning = false;
        newsFailed = true;
        console.error('[atlas] co-mentions failed', error);
        if (!disposed && memory.kind === 'news') rebuild();
      },
    );
  };

  // ---- controls ---------------------------------------------------------------

  const frequency = segmented<Frequency>(t('frequency'), [['daily', t('daily')], ['weekly', t('weekly')]], memory.frequency, (v) => {
    memory.frequency = v;
    rebuild();
  });

  const drawLevel = () => {
    levelHost.hidden = memory.mode === 'tree';
    frequency.hidden = memory.kind !== 'corr';
    if (memory.kind === 'corr') {
      const levels = atlas.network[memory.frequency].levels;
      const value = levels[Math.min(memory.corrLevel, levels.length - 1)]?.threshold;
      levelLabel.textContent = t('thresholdCorr', { v: value === undefined ? t('noData') : num(value, lang, 2, 2) });
      if (levelHost.dataset.kind !== 'corr') {
        const range = h('input', {
          type: 'range',
          min: 0,
          max: levels.length - 1,
          step: 1,
          value: memory.corrLevel,
          'aria-label': t('modeThreshold'),
          oninput: () => {
            memory.corrLevel = Number(range.value);
            rebuild();
          },
        });
        levelHost.replaceChildren(levelLabel, range);
        levelHost.dataset.kind = 'corr';
      }
    } else if (levelHost.dataset.kind !== 'news' && news) {
      levelLabel.textContent = t('thresholdNews');
      levelHost.replaceChildren(
        levelLabel,
        segmented(
          t('thresholdNews'),
          news.network.levels.map((l, i) => [String(i), String(l.threshold)] as const),
          String(memory.newsLevel),
          (v) => {
            memory.newsLevel = Number(v);
            rebuild();
          },
        ),
      );
      levelHost.dataset.kind = 'news';
    } else if (!news) {
      levelHost.hidden = true;
    }
  };

  const size = picker(t('sizeBy'), (v) => {
    memory.size = v as Size;
    if (memory.size === 'mentions') needNews();
    if (!drawn) return;
    const r = radii(drawn.symbols, drawn.metrics);
    drawn.nodes.forEach((n, i) => {
      n.r = r[i] as number;
    });
    picture();
  });
  size.set(SIZE_KEYS.map(([id, key]) => [id, t(key)] as const), memory.size);

  const find = picker(t('find'), (v) => {
    selectNode(v);
  });
  find.set(
    [
      ['', t('nobody')],
      ...[...companies]
        .sort((a, b) => a.symbol.localeCompare(b.symbol))
        .map((c) => [c.symbol, `${c.symbol} · ${c.name}`] as const),
    ],
    memory.node,
  );

  const zoomButton = (label: string, body: string, run: () => void) =>
    h('button', { type: 'button', class: 'mbx-button atl-zoom', 'aria-label': label, title: label, onclick: run }, body);

  const toolbar = h(
    'div',
    { class: 'mbx-toolbar atl-controls' },
    segmented<Kind>(t('edgeType'), [['corr', t('edgeCorr')], ['news', t('edgeNews')]], memory.kind, (v) => {
      memory.kind = v;
      memory.edge = null;
      if (v === 'news') needNews();
      rebuild();
    }),
    segmented<Mode>(t('modeLabel'), [['threshold', t('modeThreshold')], ['tree', t('modeTree')]], memory.mode, (v) => {
      memory.mode = v;
      memory.edge = null;
      rebuild();
    }),
    frequency,
    levelHost,
    size.el,
    find.el,
    h(
      'div',
      { class: 'atl-zoombar' },
      zoomButton(t('zoomIn'), '+', () => controls?.zoomBy(1.4)),
      zoomButton(t('zoomOut'), '−', () => controls?.zoomBy(1 / 1.4)),
      zoomButton(t('zoomFit'), t('zoomFit'), () => controls?.fit()),
    ),
  );

  const el = h(
    'div',
    { class: 'mbx-stack' },
    panel(
      t('graphTitle'),
      toolbar,
      h('div', { class: 'mbx-legend atl-legend' }, ...regionsOf(atlas).map((r) => regionKey(r, lang))),
      stats,
      h('div', { class: 'atl-graphrow' }, h('div', { class: 'atl-graphcell' }, stage, isolated), side),
      note(t('graphHelp')),
      caveat,
      formulas('network', lang),
    ),
    panel(
      t('netTable'),
      h(
        'div',
        { class: 'mbx-toolbar atl-bar' },
        h('button', { type: 'button', class: 'mbx-button', onclick: () => table.csv('bansho-network.csv') }, t('exportCsv')),
      ),
      table.el,
    ),
    panel(t('communitiesTitle'), communities),
  );

  const stopObserving = observeWidth(stage, (w) => {
    const first = !width;
    width = w;
    if (!drawn) return;
    const r = radii(drawn.symbols, drawn.metrics);
    drawn.nodes.forEach((n, i) => {
      n.r = r[i] as number;
    });
    if (first || stage.querySelector('svg')) picture();
  });

  rebuild();
  // The headlines also fill the mentions column and the pair panel.
  needNews();

  return {
    el,
    dispose: () => {
      disposed = true;
      stopObserving();
    },
  };
}
