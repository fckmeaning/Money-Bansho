import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  betweenness,
  clusteringCoefficients,
  distanceOf,
  graphMetrics,
  harmonicCloseness,
  hierarchicalOrder,
  louvain,
  minimumSpanningTree,
  modularity,
  pageRank,
} from './network.js';

const edge = (a, b, w = 1, d = 1) => ({ a, b, w, d });
const close = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`);

describe('correlation distance and ordering', () => {
  it('maps correlation to the Mantegna distance', () => {
    close(distanceOf(1), 0);
    close(distanceOf(0), Math.SQRT2);
    close(distanceOf(-1), 2);
  });

  it('puts correlated series next to each other', () => {
    // 0 and 2 move together, 1 and 3 move together.
    const matrix = [
      [1, 0, 0.9, 0.1],
      [0, 1, 0.1, 0.8],
      [0.9, 0.1, 1, null],
      [0.1, 0.8, null, 1],
    ];
    const { order, merges } = hierarchicalOrder(matrix);
    assert.deepEqual([...order].sort(), [0, 1, 2, 3]);
    assert.equal(Math.abs(order.indexOf(0) - order.indexOf(2)), 1);
    assert.equal(Math.abs(order.indexOf(1) - order.indexOf(3)), 1);
    assert.equal(merges.length, 3);
    assert.ok(merges[0].height <= merges[1].height && merges[1].height <= merges[2].height);
    assert.deepEqual(hierarchicalOrder([]), { order: [], merges: [] });
  });

  it('builds the minimum spanning tree', () => {
    const tree = minimumSpanningTree(4, [edge(0, 1, 1, 1), edge(1, 2, 1, 2), edge(0, 2, 1, 3), edge(2, 3, 1, 1), edge(0, 3, 1, 9)]);
    assert.equal(tree.length, 3);
    close(tree.reduce((sum, e) => sum + e.d, 0), 4);
  });
});

describe('graph measures', () => {
  const star = [edge(0, 1), edge(0, 2), edge(0, 3), edge(0, 4)];

  it('finds the centre of a star', () => {
    const between = betweenness(5, star);
    close(between[0], 1);
    close(between[1], 0);
    const near = harmonicCloseness(5, star);
    close(near[0], 1);
    close(near[1], (1 + 3 * 0.5) / 4);
    // Centre c and leaf l: c = 0.15/5 + 0.85 * 4 l and c + 4 l = 1.
    const rank = pageRank(5, star);
    close(rank[0], (0.03 + 0.85) / 1.85);
    close(rank.reduce((sum, v) => sum + v, 0), 1);
  });

  it('measures a path and respects edge lengths', () => {
    close(betweenness(3, [edge(0, 1), edge(1, 2)])[1], 1);
    // The direct link is longer than the way round, so node 1 lies on the shortest path.
    close(betweenness(3, [edge(0, 1, 1, 1), edge(1, 2, 1, 1), edge(0, 2, 1, 5)])[1], 1);
  });

  it('computes clustering coefficients', () => {
    const c = clusteringCoefficients(4, [edge(0, 1), edge(1, 2), edge(0, 2), edge(2, 3)]);
    close(c[0], 1);
    close(c[2], 1 / 3);
    assert.equal(c[3], null);
  });

  it('separates two cliques joined by one link', () => {
    const edges = [edge(0, 1), edge(0, 2), edge(1, 2), edge(3, 4), edge(3, 5), edge(4, 5), edge(2, 3)];
    const community = louvain(6, edges);
    assert.equal(new Set(community.slice(0, 3)).size, 1);
    assert.equal(new Set(community.slice(3)).size, 1);
    assert.notEqual(community[0], community[3]);
    close(modularity(6, edges, community), 6 / 7 - 0.5);
  });

  it('reports isolated nodes without a cluster', () => {
    const result = graphMetrics(4, [edge(0, 1, 0.5)]);
    assert.deepEqual(result.degree, [1, 1, 0, 0]);
    assert.deepEqual(result.community, [1, 1, null, null]);
    assert.equal(result.summary.linked, 2);
    assert.equal(result.summary.components, 1);
    close(result.summary.density, 1 / 6, 1e-3);
  });

  it('handles an empty graph without invented numbers', () => {
    const result = graphMetrics(3, []);
    assert.equal(result.summary.modularity, null);
    assert.equal(result.summary.clustering, null);
    assert.deepEqual(result.pagerank, [0, 0, 0]);
    assert.equal(result.summary.communities, 0);
  });
});
