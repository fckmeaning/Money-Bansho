// One quiet screen over the dashboard until the first news pass is drawn, so the
// page does not assemble piece by piece. It never stays longer than the limit.

const LIMIT_MS = 8_000;

let shown = false;
let node: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function showBootScreen(russian: boolean): void {
  if (shown || typeof document === 'undefined' || !document.body?.appendChild) return;
  shown = true;
  node = document.createElement('div');
  node.setAttribute('role', 'status');
  node.style.cssText =
    'position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;background:var(--bg,#0e1116);color:var(--text-dim,#8a95a5);font-size:13px;';
  const box = document.createElement('div');
  box.style.cssText = 'border:1px solid var(--border,#2f3845);padding:20px 28px;text-align:center;';
  box.textContent = russian ? 'Money Bansho. Загрузка ленты новостей и панелей' : 'Money Bansho. Loading the news stream and panels';
  node.appendChild(box);
  document.body.appendChild(node);
  timer = setTimeout(hideBootScreen, LIMIT_MS);
}

export function hideBootScreen(): void {
  clearTimeout(timer);
  node?.remove();
  node = null;
}
