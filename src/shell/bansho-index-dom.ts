// DOM helpers shared by the index card and its proof block. Text nodes only.
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export type TableCell = string | { text: string; cls: string; span?: number };

/** A table in its own horizontally scrollable box; a cell may carry a class and a span. */
export function table(head: string[], rows: TableCell[][]): HTMLElement {
  const node = el('table', 'bx-table');
  const header = el('tr');
  for (const title of head) header.append(el('th', '', title));
  node.append(header);
  for (const cells of rows) {
    const line = el('tr');
    for (const value of cells) {
      if (typeof value === 'string') {
        line.append(el('td', '', value));
        continue;
      }
      const cell = el('td', value.cls, value.text);
      if (value.span) cell.colSpan = value.span;
      line.append(cell);
    }
    node.append(line);
  }
  const box = el('div', 'bx-scroll');
  box.tabIndex = 0;
  box.append(node);
  return box;
}
