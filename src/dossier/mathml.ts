// A few builders for native MathML, enough for the equations of the Model view.

const NS = 'http://www.w3.org/1998/Math/MathML';

/** A string is typeset as an identifier, number or operator by its content. */
export type Term = MathMLElement | string;

function el(tag: string, ...children: (Node | string)[]): MathMLElement {
  const node = document.createElementNS(NS, tag) as MathMLElement;
  node.append(...children);
  return node;
}

export const mi = (text: string): MathMLElement => el('mi', text);
export const mn = (text: string): MathMLElement => el('mn', text);
export const mo = (text: string): MathMLElement => el('mo', text);
export const mtext = (text: string): MathMLElement => el('mtext', text);

/** Upright multi-letter names such as ln, exp, VaR. */
export const fn = (name: string): MathMLElement => el('mi', name);

function token(term: Term): MathMLElement {
  if (typeof term !== 'string') return term;
  if (/^[0-9][0-9.,\s]*%?$/.test(term)) return mn(term);
  // One letter (Latin or Greek, with an optional combining mark) is a variable.
  if (/^\p{L}\p{M}*$/u.test(term)) return mi(term);
  if (/^[A-Za-z]{2,}$/.test(term)) return fn(term);
  return mo(term);
}

export const row = (...terms: Term[]): MathMLElement => el('mrow', ...terms.map(token));
export const sub = (base: Term, index: Term): MathMLElement => el('msub', token(base), token(index));
export const sup = (base: Term, power: Term): MathMLElement => el('msup', token(base), token(power));
export const subsup = (base: Term, index: Term, power: Term): MathMLElement =>
  el('msubsup', token(base), token(index), token(power));
export const frac = (top: Term, bottom: Term): MathMLElement => el('mfrac', token(top), token(bottom));
export const sqrt = (...terms: Term[]): MathMLElement => el('msqrt', ...terms.map(token));
export const under = (base: Term, below: Term): MathMLElement => el('munder', token(base), token(below));
export const underover = (base: Term, below: Term, above: Term): MathMLElement =>
  el('munderover', token(base), token(below), token(above));
export function over(base: Term, accent: string): MathMLElement {
  const node = el('mover', token(base), mo(accent));
  node.setAttribute('accent', 'true');
  return node;
}
/** Parenthesised group. */
export const paren = (...terms: Term[]): MathMLElement => row('(', ...terms, ')');
export const gap = (): MathMLElement => {
  const node = el('mspace');
  node.setAttribute('width', '1.2em');
  return node;
};

/** One display equation in its own horizontally scrollable line. */
export function equation(...terms: Term[]): HTMLElement {
  const math = el('math', row(...terms));
  math.setAttribute('display', 'block');
  const line = document.createElement('div');
  line.className = 'equation';
  line.tabIndex = 0;
  line.append(math);
  return line;
}
