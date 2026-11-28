// Derivative-free minimisation (Nelder-Mead). Pure ESM (edge safe).

/**
 * @param {(x: number[]) => number} f non-finite values are treated as +Infinity
 * @param {number[]} start
 * @returns {{x: number[], value: number, iterations: number, converged: boolean}}
 */
export function nelderMead(f, start, { step = 0.5, tolerance = 1e-8, maxIterations = 600 } = {}) {
  const score = (x) => {
    const value = f(x);
    return Number.isFinite(value) ? value : Infinity;
  };
  const vertex = (x) => ({ x, value: score(x) });
  const n = start.length;
  const simplex = [vertex([...start])];
  for (let i = 0; i < n; i += 1) {
    const x = [...start];
    x[i] += step;
    simplex.push(vertex(x));
  }
  let iterations = 0;
  let converged = false;
  for (; iterations < maxIterations; iterations += 1) {
    simplex.sort((a, b) => a.value - b.value);
    const best = simplex[0];
    const worst = simplex[n];
    const spread = Math.max(...simplex.slice(1).map((v) => Math.max(...v.x.map((xi, i) => Math.abs(xi - best.x[i])))));
    if (Math.abs(worst.value - best.value) <= tolerance && spread <= Math.sqrt(tolerance)) {
      converged = true;
      break;
    }
    const centroid = best.x.map((_, i) => simplex.slice(0, n).reduce((s, v) => s + v.x[i], 0) / n);
    const along = (k) => vertex(centroid.map((c, i) => c + k * (c - worst.x[i])));
    const reflected = along(1);
    if (reflected.value < best.value) {
      const expanded = along(2);
      simplex[n] = expanded.value < reflected.value ? expanded : reflected;
    } else if (reflected.value < simplex[n - 1].value) {
      simplex[n] = reflected;
    } else {
      const contracted = along(reflected.value < worst.value ? 0.5 : -0.5);
      if (contracted.value < Math.min(worst.value, reflected.value)) {
        simplex[n] = contracted;
      } else {
        for (let k = 1; k <= n; k += 1) simplex[k] = vertex(simplex[k].x.map((xi, i) => best.x[i] + 0.5 * (xi - best.x[i])));
      }
    }
  }
  simplex.sort((a, b) => a.value - b.value);
  return { x: simplex[0].x, value: simplex[0].value, iterations, converged };
}
