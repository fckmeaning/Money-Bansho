// Measures of a weighted undirected graph and clustering of a correlation matrix.
// Pure ESM, no dependencies (edge safe), deterministic. The formulas are shown on
// the analytics screen (src/dossier/atlas/formulas.ts).

const EPS = 1e-12;
const round = (value, digits = 4) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

/** Mantegna distance of a correlation: 0 for rho = 1, sqrt(2) for 0, 2 for -1. */
export const distanceOf = (rho) => Math.sqrt(Math.max(0, 2 * (1 - rho)));

/**
 * Average-linkage (UPGMA) clustering of a correlation matrix. A missing correlation
 * counts as 0 for the ordering only. Returns the leaf order and the merges: ids below
 * n are leaves, id n + k is the cluster made by merge k.
 */
export function hierarchicalOrder(matrix) {
  const n = matrix.length;
  if (!n) return { order: [], merges: [] };
  const base = matrix.map((row, i) => row.map((v, j) => (i === j ? 0 : distanceOf(Number.isFinite(v) ? v : 0))));
  const clusters = new Map(base.map((_, i) => [i, [i]]));
  const link = new Map(base.map((row, i) => [i, new Map(row.map((d, j) => [j, d]))]));
  const merges = [];
  let next = n;
  while (clusters.size > 1) {
    let a = -1;
    let b = -1;
    let best = Number.POSITIVE_INFINITY;
    const ids = [...clusters.keys()];
    for (let x = 0; x < ids.length; x += 1) {
      for (let y = x + 1; y < ids.length; y += 1) {
        const d = link.get(ids[x]).get(ids[y]);
        if (d < best - EPS) {
          best = d;
          a = ids[x];
          b = ids[y];
        }
      }
    }
    const left = clusters.get(a);
    const right = clusters.get(b);
    // Turn the two halves so that the most similar ends become neighbours.
    const options = [
      [left, right],
      [[...left].reverse(), right],
      [left, [...right].reverse()],
      [[...left].reverse(), [...right].reverse()],
    ];
    let joined = options[0];
    let gap = Number.POSITIVE_INFINITY;
    for (const [l, r] of options) {
      const d = base[l[l.length - 1]][r[0]];
      if (d < gap - EPS) {
        gap = d;
        joined = [l, r];
      }
    }
    const row = new Map();
    for (const id of clusters.keys()) {
      if (id === a || id === b) continue;
      const d = (link.get(a).get(id) * left.length + link.get(b).get(id) * right.length) / (left.length + right.length);
      row.set(id, d);
      link.get(id).set(next, d);
    }
    clusters.delete(a);
    clusters.delete(b);
    clusters.set(next, [...joined[0], ...joined[1]]);
    link.set(next, row);
    merges.push({ a, b, height: round(best) });
    next += 1;
  }
  return { order: [...clusters.values()][0], merges };
}

/** Kruskal minimum spanning forest. `edges` are {a, b, d}; returns the chosen edges. */
export function minimumSpanningTree(n, edges) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const out = [];
  const sorted = [...edges].sort((x, y) => x.d - y.d || x.a - y.a || x.b - y.b);
  for (const edge of sorted) {
    const a = find(edge.a);
    const b = find(edge.b);
    if (a === b) continue;
    parent[a] = b;
    out.push(edge);
    if (out.length === n - 1) break;
  }
  return out;
}

function adjacency(n, edges) {
  const near = Array.from({ length: n }, () => []);
  for (const { a, b, w, d } of edges) {
    near[a].push({ to: b, w, d });
    near[b].push({ to: a, w, d });
  }
  return near;
}

/** Brandes betweenness on edge lengths d, normalised to [0, 1] by (n-1)(n-2)/2. */
export function betweenness(n, edges) {
  const near = adjacency(n, edges);
  const total = new Array(n).fill(0);
  for (let source = 0; source < n; source += 1) {
    const dist = new Array(n).fill(Number.POSITIVE_INFINITY);
    const paths = new Array(n).fill(0);
    const before = Array.from({ length: n }, () => []);
    const done = new Array(n).fill(false);
    const stack = [];
    dist[source] = 0;
    paths[source] = 1;
    for (;;) {
      let v = -1;
      for (let i = 0; i < n; i += 1) {
        if (!done[i] && Number.isFinite(dist[i]) && (v < 0 || dist[i] < dist[v])) v = i;
      }
      if (v < 0) break;
      done[v] = true;
      stack.push(v);
      for (const { to, d } of near[v]) {
        if (done[to]) continue;
        const through = dist[v] + d;
        if (through < dist[to] - 1e-9) {
          dist[to] = through;
          paths[to] = paths[v];
          before[to] = [v];
        } else if (Math.abs(through - dist[to]) <= 1e-9) {
          paths[to] += paths[v];
          before[to].push(v);
        }
      }
    }
    const dependency = new Array(n).fill(0);
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const w = stack[i];
      for (const v of before[w]) dependency[v] += (paths[v] / paths[w]) * (1 + dependency[w]);
      if (w !== source) total[w] += dependency[w];
    }
  }
  // Every unordered pair was counted from both ends.
  const pairs = (n - 1) * (n - 2);
  return total.map((value) => (pairs > 0 ? value / pairs : 0));
}

/** Harmonic closeness on hop counts: mean of 1 / hops over all other nodes. */
export function harmonicCloseness(n, edges) {
  const near = adjacency(n, edges);
  return Array.from({ length: n }, (_, source) => {
    const hops = new Array(n).fill(-1);
    hops[source] = 0;
    const queue = [source];
    let total = 0;
    for (let head = 0; head < queue.length; head += 1) {
      const v = queue[head];
      for (const { to } of near[v]) {
        if (hops[to] >= 0) continue;
        hops[to] = hops[v] + 1;
        total += 1 / hops[to];
        queue.push(to);
      }
    }
    return n > 1 ? total / (n - 1) : 0;
  });
}

/**
 * Weighted PageRank over the linked nodes (values sum to 1). Unlike eigenvector
 * centrality it stays informative when the graph falls into separate parts.
 * Nodes without a link get 0.
 */
export function pageRank(n, edges, damping = 0.85, iterations = 200) {
  const strength = new Array(n).fill(0);
  for (const { a, b, w } of edges) {
    strength[a] += w;
    strength[b] += w;
  }
  const linked = strength.filter((v) => v > 0).length;
  if (!linked) return new Array(n).fill(0);
  let x = strength.map((v) => (v > 0 ? 1 / linked : 0));
  for (let step = 0; step < iterations; step += 1) {
    const y = strength.map((v) => (v > 0 ? (1 - damping) / linked : 0));
    for (const { a, b, w } of edges) {
      if (!(w > 0)) continue;
      y[a] += (damping * w * x[b]) / strength[b];
      y[b] += (damping * w * x[a]) / strength[a];
    }
    const moved = y.reduce((total, v, i) => total + Math.abs(v - x[i]), 0);
    x = y;
    if (moved < 1e-12) break;
  }
  return x;
}

/** Share of existing links among the neighbours of each node; null below two neighbours. */
export function clusteringCoefficients(n, edges) {
  const sets = Array.from({ length: n }, () => new Set());
  for (const { a, b } of edges) {
    sets[a].add(b);
    sets[b].add(a);
  }
  return sets.map((set) => {
    const list = [...set];
    if (list.length < 2) return null;
    let links = 0;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) if (sets[list[i]].has(list[j])) links += 1;
    }
    return (2 * links) / (list.length * (list.length - 1));
  });
}

/** Newman modularity of a partition on weighted edges. */
export function modularity(n, edges, community) {
  const strength = new Array(n).fill(0);
  let m = 0;
  let inside = 0;
  for (const { a, b, w } of edges) {
    strength[a] += w;
    strength[b] += w;
    m += w;
    if (community[a] === community[b]) inside += w;
  }
  if (!(m > 0)) return null;
  const totals = new Map();
  for (let i = 0; i < n; i += 1) totals.set(community[i], (totals.get(community[i]) ?? 0) + strength[i]);
  let expected = 0;
  for (const total of totals.values()) expected += (total / (2 * m)) ** 2;
  return inside / m - expected;
}

/** One level of Louvain local moving on a graph given as neighbour maps (self loops allowed). */
function localMoves(near, self) {
  const n = near.length;
  const degree = near.map((map, i) => [...map.values()].reduce((sum, w) => sum + w, 0) + 2 * self[i]);
  const m2 = degree.reduce((sum, d) => sum + d, 0);
  const community = Array.from({ length: n }, (_, i) => i);
  const totals = [...degree];
  let improved = false;
  for (let pass = 0; pass < 50 && m2 > 0; pass += 1) {
    let moves = 0;
    for (let i = 0; i < n; i += 1) {
      const own = community[i];
      const weights = new Map([[own, 0]]);
      for (const [j, w] of near[i]) weights.set(community[j], (weights.get(community[j]) ?? 0) + w);
      totals[own] -= degree[i];
      let target = own;
      let best = weights.get(own) - (totals[own] * degree[i]) / m2;
      for (const [c, w] of [...weights].sort((x, y) => x[0] - y[0])) {
        const gain = w - (totals[c] * degree[i]) / m2;
        if (gain > best + 1e-10) {
          best = gain;
          target = c;
        }
      }
      totals[target] += degree[i];
      if (target !== own) {
        community[i] = target;
        moves += 1;
        improved = true;
      }
    }
    if (!moves) break;
  }
  return { community, improved };
}

/** Louvain communities (maximum modularity heuristic). Returns one label per node. */
export function louvain(n, edges) {
  let near = Array.from({ length: n }, () => new Map());
  for (const { a, b, w } of edges) {
    near[a].set(b, (near[a].get(b) ?? 0) + w);
    near[b].set(a, (near[b].get(a) ?? 0) + w);
  }
  let self = new Array(n).fill(0);
  let labels = Array.from({ length: n }, (_, i) => i);
  for (let level = 0; level < 20; level += 1) {
    const { community, improved } = localMoves(near, self);
    if (!improved) break;
    const ids = new Map();
    for (const c of community) if (!ids.has(c)) ids.set(c, ids.size);
    labels = labels.map((l) => ids.get(community[l]));
    const nextNear = Array.from({ length: ids.size }, () => new Map());
    const nextSelf = new Array(ids.size).fill(0);
    for (let i = 0; i < near.length; i += 1) {
      const a = ids.get(community[i]);
      nextSelf[a] += self[i];
      for (const [j, w] of near[i]) {
        const b = ids.get(community[j]);
        // An inner link is seen from both ends, so each end adds half of it.
        if (a === b) nextSelf[a] += w / 2;
        else nextNear[a].set(b, (nextNear[a].get(b) ?? 0) + w);
      }
    }
    near = nextNear;
    self = nextSelf;
  }
  return labels;
}

function components(n, edges) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (const { a, b } of edges) parent[find(a)] = find(b);
  return parent.map((_, i) => find(i));
}

/** Labels 1, 2, 3... by group size (largest first); null for nodes without a link. */
function rankLabels(labels, degree) {
  const sizes = new Map();
  labels.forEach((label, i) => {
    if (degree[i]) sizes.set(label, (sizes.get(label) ?? 0) + 1);
  });
  const order = [...sizes].sort((x, y) => y[1] - x[1] || x[0] - y[0]).map(([label]) => label);
  const rank = new Map(order.map((label, i) => [label, i + 1]));
  return { labels: labels.map((label, i) => (degree[i] ? rank.get(label) : null)), count: order.length };
}

/**
 * All measures of a graph with `n` nodes and edges {a, b, w, d}: w is the strength of a
 * link (larger is closer), d its length for shortest paths. Values are arrays by node.
 */
export function graphMetrics(n, edges) {
  const degree = new Array(n).fill(0);
  const strength = new Array(n).fill(0);
  for (const { a, b, w } of edges) {
    degree[a] += 1;
    degree[b] += 1;
    strength[a] += w;
    strength[b] += w;
  }
  const community = louvain(n, edges);
  const clustering = clusteringCoefficients(n, edges);
  const q = modularity(n, edges, community);
  const groups = rankLabels(community, degree);
  const parts = rankLabels(components(n, edges), degree);
  const known = clustering.filter((c) => c !== null);
  return {
    degree,
    strength: strength.map((v) => round(v, 3)),
    pagerank: pageRank(n, edges).map((v) => round(v, 5)),
    betweenness: betweenness(n, edges).map((v) => round(v, 4)),
    closeness: harmonicCloseness(n, edges).map((v) => round(v, 3)),
    clustering: clustering.map((v) => (v === null ? null : round(v, 3))),
    community: groups.labels,
    summary: {
      nodes: n,
      linked: degree.filter((d) => d > 0).length,
      edges: edges.length,
      density: n > 1 ? round((2 * edges.length) / (n * (n - 1)), 4) : null,
      clustering: known.length ? round(known.reduce((s, v) => s + v, 0) / known.length, 3) : null,
      modularity: q === null ? null : round(q, 3),
      communities: groups.count,
      components: parts.count,
    },
  };
}
