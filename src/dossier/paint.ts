// Rebuilds a region only when what it shows has changed, and keeps the reader's
// place (keyboard focus and scroll position) when it does.

const painted = new WeakMap<Element, string>();

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]';

const byKey = (host: ParentNode, key: string) =>
  host.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);

/** Replaces content while keeping keyboard focus on the equivalent control. */
export function swap(host: HTMLElement, ...children: (Node | null)[]): void {
  const active = document.activeElement as HTMLElement | null;
  const inside = active !== null && active !== host && host.contains(active);
  const key = inside ? active.dataset.key : undefined;
  // Controls without a key are matched by their position among the focusables.
  const position = inside && !key ? [...host.querySelectorAll(FOCUSABLE)].indexOf(active) : -1;
  host.replaceChildren(...children.filter((c): c is Node => c !== null));
  if (!inside) return;
  const next = key ? byKey(host, key) : [...host.querySelectorAll<HTMLElement>(FOCUSABLE)][position];
  next?.focus({ preventScroll: true });
}

export function paint(host: HTMLElement, signature: unknown, build: () => (Node | null)[]): boolean {
  const next = JSON.stringify(signature) ?? '';
  if (painted.get(host) === next) return false;
  painted.set(host, next);
  swap(host, ...build());
  return true;
}

export const forget = (host: HTMLElement): void => {
  painted.delete(host);
};

/**
 * Runs a re-render without letting content move under the reader: the first
 * anchored element in view stays where it was.
 */
export function keepPlace(root: HTMLElement, offset: number, render: () => void): void {
  const x = window.scrollX;
  const y = window.scrollY;
  if (y <= 0) {
    render();
    return;
  }
  let key: string | undefined;
  let top = 0;
  for (const node of root.querySelectorAll<HTMLElement>('[data-anchor]')) {
    const box = node.getBoundingClientRect();
    if (box.height === 0 || box.top < offset) continue;
    if (box.top < window.innerHeight) {
      key = node.dataset.anchor;
      top = box.top;
    }
    break;
  }
  render();
  const again = key ? root.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(key)}"]`) : null;
  const box = again?.getBoundingClientRect();
  if (box && box.height > 0) window.scrollBy(0, box.top - top);
  else window.scrollTo(x, y);
}
