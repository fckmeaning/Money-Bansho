// DOM, formula, table and live-data helpers of /pages.html. No innerHTML.
export type Lang = 'ru' | 'en';
/** A text in both interface languages. */
export type L = readonly [ru: string, en: string];

export const state: { lang: Lang } = { lang: 'ru' };
export const tr = (text: L): string => text[state.lang === 'ru' ? 0 : 1];

export type Child = Node | string | null | undefined;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children.filter((c): c is Node | string => c !== null && c !== undefined));
  return node;
}

export const a = (href: string, ...children: Child[]): HTMLAnchorElement => el('a', { href }, ...children);
export const p = (...children: Child[]): HTMLParagraphElement => el('p', {}, ...children);
export const h2 = (text: string): HTMLHeadingElement => el('h2', {}, text);
export const ul = (items: Child[]): HTMLUListElement => el('ul', {}, ...items.map((i) => el('li', {}, i)));
export const linkRow = (links: Array<[string, string]>): HTMLElement =>
  el('p', { class: 'pg-links' }, ...links.map(([href, text]) => a(href, text)));

export const cards = (items: Array<{ href: string; title: string; text: string }>): HTMLElement =>
  el('div', { class: 'pg-cards' }, ...items.map((c) =>
    el('a', { class: 'pg-card', href: c.href }, el('h3', {}, c.title), el('p', {}, c.text))));

export function table(head: string[], rows: Child[][]): HTMLElement {
  return el('div', { class: 'pg-scroll', tabindex: '0' },
    el('table', {},
      el('thead', {}, el('tr', {}, ...head.map((h) => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, ...rows.map((row) => el('tr', {}, ...row.map((cell) => el('td', {}, cell ?? '')))))));
}

export const noData = (reason = ''): HTMLElement =>
  el('p', { class: 'pg-nodata' }, tr(['нет данных', 'no data']) + (reason ? ` (${reason})` : ''));

export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const num = (v: unknown, digits = 2): string =>
  isNum(v) ? v.toLocaleString(state.lang === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: digits }) : tr(['нет данных', 'no data']);

/** Signed percent; colour is used only on price changes. */
export function change(v: unknown): HTMLElement {
  if (!isNum(v)) return el('span', { class: 'pg-muted' }, tr(['нет данных', 'no data']));
  return el('span', { class: v > 0 ? 'pg-up' : v < 0 ? 'pg-down' : '' }, `${v > 0 ? '+' : ''}${num(v)}%`);
}

export function external(url: unknown, text: string): Node {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return document.createTextNode(text);
  return el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text);
}

// ---- live data --------------------------------------------------------------

const cache = new Map<string, { at: number; value: Promise<unknown> }>();

export function api<T>(query: string): Promise<T> {
  const hit = cache.get(query);
  if (hit && Date.now() - hit.at < 30_000) return hit.value as Promise<T>;
  const value = fetch(`/api/dossier?${query}`, { signal: AbortSignal.timeout(30_000) }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<unknown>;
  });
  cache.set(query, { at: Date.now(), value });
  value.catch(() => cache.delete(query));
  return value as Promise<T>;
}

/** A block that loads on its own; a failure or an empty answer reads "no data". */
export function live<T>(query: string, render: (data: T) => Node | null): HTMLElement {
  const box = el('div', { class: 'pg-live', 'aria-live': 'polite' },
    el('p', { class: 'pg-muted' }, tr(['Загрузка…', 'Loading…'])));
  api<T>(query)
    .then((data) => box.replaceChildren(render(data) ?? noData()))
    .catch((error: unknown) => box.replaceChildren(noData(error instanceof Error ? error.message : '')));
  return box;
}

// ---- formulas: a small TeX subset rendered as MathML -------------------------

const MATH = 'http://www.w3.org/1998/Math/MathML';
const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', eta: 'η', theta: 'θ', kappa: 'κ', lambda: 'λ',
  mu: 'μ', nu: 'ν', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', chi: 'χ', omega: 'ω', Delta: 'Δ',
  Phi: 'Φ', Lambda: 'Λ', Gamma: 'Γ', sum: '∑', prod: '∏', cdot: '·', le: '≤', ge: '≥', approx: '≈',
  sim: '∼', to: '→', in: '∈', times: '×', pm: '±', max: 'max', min: 'min', ln: 'ln', exp: 'exp',
};

const node = (tag: string, ...children: Array<Node | string>): Element => {
  const out = document.createElementNS(MATH, tag);
  out.append(...children);
  return out;
};

function space(width: string): Element {
  const out = node('mspace');
  out.setAttribute('width', width);
  return out;
}

function parse(src: string): Element[] {
  const tokens = src.match(/\\[A-Za-z]+|\\[{}]|\d+(?:\.\d+)?|\S| /g) ?? [];
  let at = 0;
  const group = (): Element => {
    while (tokens[at] === ' ') at += 1;
    if (tokens[at] !== '{') return atom();
    at += 1;
    const items = sequence();
    at += 1;
    return node('mrow', ...items);
  };
  const raw = (): string => {
    while (tokens[at] === ' ') at += 1;
    at += 1; // {
    let text = '';
    while (at < tokens.length && tokens[at] !== '}') text += tokens[at++];
    at += 1;
    return text;
  };
  const atom = (): Element => {
    const t = tokens[at++] ?? '';
    if (t === '\\frac') { const top = group(); return node('mfrac', top, group()); }
    if (t === '\\sqrt') return node('msqrt', group());
    if (t === '\\text') return node('mtext', raw());
    if (t === '\\{' || t === '\\}') return node('mo', t.slice(1));
    if (t === '\\quad') return space('1.5em');
    if (t.startsWith('\\')) {
      const name = t.slice(1);
      // A function name keeps a thin gap before its argument.
      if (/^(ln|exp|max|min|logit)$/.test(name) && !/^[_^]$/.test(tokens[at] ?? '')) {
        return node('mrow', node('mi', name), space('0.2em'));
      }
      const symbol = SYMBOLS[name] ?? name;
      return /^[∑∏·≤≥≈∼→∈×±]$/.test(symbol) ? node('mo', symbol) : node('mi', symbol);
    }
    if (/^\d/.test(t)) return node('mn', t);
    if (/^\p{L}$/u.test(t)) return node('mi', t);
    return node('mo', t);
  };
  const sequence = (): Element[] => {
    const items: Element[] = [];
    while (at < tokens.length && tokens[at] !== '}') {
      const t = tokens[at];
      if (t === ' ') { at += 1; continue; }
      if (t === '_' || t === '^') {
        at += 1;
        const base = items.pop() ?? node('mrow');
        const first = group();
        const other = t === '_' ? '^' : '_';
        if (tokens[at] === other) {
          at += 1;
          const second = group();
          items.push(t === '_' ? node('msubsup', base, first, second) : node('msubsup', base, second, first));
        } else items.push(node(t === '_' ? 'msub' : 'msup', base, first));
        continue;
      }
      items.push(group());
    }
    return items;
  };
  return sequence();
}

export function formula(src: string): HTMLElement {
  const math = node('math', node('mrow', ...parse(src)));
  math.setAttribute('display', 'block');
  const box = el('div', { class: 'pg-math', tabindex: '0' });
  box.append(math);
  return box;
}

// ---- the markdown subset used by the backtest reports ------------------------

const plain = (s: string): string => s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*|`/g, '');
const cells = (line: string): string[] =>
  line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => plain(c.trim().replace(/\\\|/g, '|')));

export function markdown(src: string): HTMLElement {
  const out = el('div', { class: 'pg-report', lang: 'ru' });
  const lines = src.split('\n');
  let i = 0;
  const at = (): string => lines[i] ?? '';
  while (i < lines.length) {
    const line = at();
    if (!line.trim() || line.startsWith('# ')) { i += 1; continue; }
    if (line.startsWith('```') || line.startsWith('    ')) {
      const fenced = line.startsWith('```');
      const code: string[] = [];
      if (fenced) i += 1;
      while (i < lines.length && (fenced ? !at().startsWith('```') : at().startsWith('    '))) {
        code.push(fenced ? at() : at().slice(4));
        i += 1;
      }
      if (fenced) i += 1;
      out.append(el('pre', { tabindex: '0' }, code.join('\n')));
      continue;
    }
    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading) {
      out.append(el(heading[1] === '##' ? 'h2' : 'h3', {}, plain(heading[2] ?? '')));
      i += 1;
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[] = [];
      while (at().startsWith('|')) { rows.push(at()); i += 1; }
      out.append(table(cells(rows[0] ?? ''), rows.slice(2).map(cells)));
      continue;
    }
    const marker = /^(\*|-|\d+\.)\s+/;
    if (marker.test(line)) {
      const items: string[] = [];
      while (marker.test(at()) || (items.length && /^\s{2,}\S/.test(at()))) {
        if (marker.test(at())) items.push(at().replace(marker, ''));
        else items[items.length - 1] += ` ${at().trim()}`;
        i += 1;
      }
      out.append(ul(items.map(plain)));
      continue;
    }
    const text: string[] = [];
    while (at().trim() && !/^(#|\||```| {4}|\*\s|-\s|\d+\.\s)/.test(at())) { text.push(at().trim()); i += 1; }
    if (!text.length) { text.push(at().trim()); i += 1; }
    out.append(p(plain(text.join(' '))));
  }
  return out;
}
