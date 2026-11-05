import type { Town } from './town.js';

/**
 * Text picture of a town, for eyeballing generated maps in a terminal.
 * Producers are the good's initial in capitals (M = milk producer), consumers in lower case
 * (m = milk consumer), # = empty depot site, . = empty lot, digits = each company's starting depot,
 * ~ = river, = = bridge.
 */
export function renderTown(town: Town): string {
  const SX = 4;
  const SY = 2;
  const { blocksX: W, blocksY: H } = town.cfg;
  const cols = W * SX + 1;
  const rows = H * SY + 1;
  const grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill(' '));
  const put = (x: number, y: number, ch: string) => {
    const c = Math.round(x * SX);
    const r = Math.round(y * SY);
    if (r >= 0 && r < rows && c >= 0 && c < cols) grid[r][c] = ch;
  };

  // River blocks first, so streets and bridges draw over them.
  for (const { i, j } of town.river)
    for (let r = j * SY; r <= (j + 1) * SY; r++)
      for (let c = i * SX; c <= (i + 1) * SX; c++) {
        const corner = r % SY === 0 && c % SX === 0;
        if (!corner && r < rows && c < cols) grid[r][c] = '~';
      }
  const bridgeKey = new Set(town.river.length ? town.bridges.map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`) : []);

  const { nodes, edges } = town.graph;
  for (const e of edges) {
    const a = nodes[e.a];
    const b = nodes[e.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx !== 0 && dy !== 0) {
      // Diagonal: one character per text row crossed, so it reads as a single line.
      const rowsCrossed = Math.abs(dy) * SY;
      for (let s = 1; s < rowsCrossed; s++) put(a.x + (dx * s) / rowsCrossed, a.y + (dy * s) / rowsCrossed, dx * dy > 0 ? '\\' : '/');
      continue;
    }
    const ch = bridgeKey.has(`${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}`) ? '=' : dy === 0 ? '-' : '|';
    const steps = Math.max(Math.abs(dx) * SX, Math.abs(dy) * SY);
    for (let s = 1; s < steps; s++) put(a.x + (dx * s) / steps, a.y + (dy * s) / steps, ch);
  }
  for (const n of nodes) if (Number.isInteger(n.x) && Number.isInteger(n.y)) put(n.x, n.y, '+');
  for (const l of town.locations) {
    let ch = l.kind === 'lot' ? '.' : '#';
    if (l.startCompany !== null) ch = String(l.startCompany);
    else if (l.kind === 'producer' || l.kind === 'consumer') {
      const initial = town.cfg.goods[l.good!][0];
      ch = l.kind === 'producer' ? initial.toUpperCase() : initial.toLowerCase();
    }
    put(l.x, l.y, ch);
  }
  return grid.map((r) => r.join('').trimEnd()).join('\n');
}
