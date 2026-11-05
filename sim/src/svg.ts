// Draws a generated town as SVG, for eyeballing maps (rivers, bridges, starts).
// Usage: npx tsx sim/src/svg.ts <seed> <rivers> > town.svg
import { generateTown, makeTownConfig, type Town } from '@sr/core';

const COMPANY = ['#d1495b', '#2e86ab', '#edae49', '#66a182', '#8e6c8a', '#f18f01'];
const GOOD = ['#f4f1de', '#c98b4b', '#5b5f97'];

export function townSvg(town: Town, title = ''): string {
  const S = 40;
  const M = 20;
  const { blocksX: W, blocksY: H, goods } = town.cfg;
  const X = (x: number) => M + x * S;
  const Y = (y: number) => M + 26 + y * S;
  const out: string[] = [];
  const w = W * S + 2 * M;
  const h = H * S + 2 * M + 26 + 30;
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Helvetica, Arial, sans-serif">`);
  out.push(`<rect width="${w}" height="${h}" fill="#e9e4d4"/>`);
  out.push(`<text x="${M}" y="${M + 6}" font-size="15" font-weight="bold" fill="#333">${title}</text>`);
  // Blocks (green), then water.
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) out.push(`<rect x="${X(i) + 4}" y="${Y(j) + 4}" width="${S - 8}" height="${S - 8}" rx="3" fill="#cfd8b8"/>`);
  for (const { i, j } of town.river) out.push(`<rect x="${X(i) - 4}" y="${Y(j) - 4}" width="${S + 8}" height="${S + 8}" fill="#6fa8dc"/>`);
  // Roads.
  const { nodes, edges } = town.graph;
  const key = (a: number, b: number) => `${Math.min(a, b)}-${Math.max(a, b)}`;
  const bridges = new Set(town.bridges.map(([a, b]) => key(a, b)));
  for (const e of edges) {
    const a = nodes[e.a];
    const b = nodes[e.b];
    const bridge = bridges.has(key(e.a, e.b));
    if (bridge) out.push(`<line x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(b.x)}" y2="${Y(b.y)}" stroke="#5a4632" stroke-width="10"/>`);
    out.push(`<line x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(b.x)}" y2="${Y(b.y)}" stroke="${bridge ? '#b08d63' : '#8a8a8a'}" stroke-width="5" stroke-linecap="round"/>`);
  }
  // Locations.
  for (const l of town.locations) {
    const cx = X(l.x);
    const cy = Y(l.y);
    if (l.kind === 'lot') out.push(`<circle cx="${cx}" cy="${cy}" r="3" fill="#fff" stroke="#999"/>`);
    else if (l.kind === 'depot') {
      const fill = l.startCompany !== null ? COMPANY[l.startCompany] : '#fff';
      out.push(`<rect x="${cx - 8}" y="${cy - 8}" width="16" height="16" fill="${fill}" stroke="#333" stroke-width="1.5"/>`);
      if (l.startCompany !== null) out.push(`<text x="${cx}" y="${cy + 4}" font-size="11" font-weight="bold" text-anchor="middle" fill="#fff">${l.startCompany}</text>`);
    } else {
      const g = GOOD[l.good! % GOOD.length];
      const letter = goods[l.good!][0];
      if (l.kind === 'producer') out.push(`<circle cx="${cx}" cy="${cy}" r="9" fill="${g}" stroke="#333" stroke-width="1.5"/>`);
      else out.push(`<polygon points="${cx},${cy - 10} ${cx + 10},${cy + 8} ${cx - 10},${cy + 8}" fill="${g}" stroke="#333" stroke-width="1.5"/>`);
      const txt = l.good === 0 ? '#333' : '#fff';
      out.push(`<text x="${cx}" y="${cy + (l.kind === 'producer' ? 4 : 6)}" font-size="10" font-weight="bold" text-anchor="middle" fill="${txt}">${l.kind === 'producer' ? letter.toUpperCase() : letter}</text>`);
    }
  }
  // Legend.
  const ly = Y(H) + 26;
  out.push(
    `<text x="${M}" y="${ly}" font-size="12" fill="#333">● producer   ▲ consumer   (M/B/F = milk, bread, fuel)   ■ depot (numbered = company start)   ○ empty lot   brown = bridge</text>`,
  );
  out.push('</svg>');
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seed = Number(process.argv[2] ?? 1);
  const rivers = Number(process.argv[3] ?? 1);
  const t = generateTown(makeTownConfig({ seed, rivers }));
  console.log(townSvg(t, `Seed ${seed}, ${rivers ? `${rivers} river, ${t.bridges.length} bridges` : 'no river'}`));
}
