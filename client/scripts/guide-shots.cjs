// Captures the walkthrough pictures for the How to play card.
// Usage (with `npx vite preview --port 4173` running in client/):
//   node client/scripts/guide-shots.cjs "http://localhost:4173/?seed=5" <out-dir>
// then convert the PNGs to client/public/guide/*.webp (max 900px wide; crop overview to the town itself,
// leaving off the empty page either side, since it shares its row with the diagram).
// It plays your seat directly, and hands you shares and cash for the pictures.
const { chromium } = require('playwright');
const out = process.argv[3];
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(process.argv[2]);
  await p.waitForTimeout(400);
  await p.click('#st-play');
  // No pop-up messages in the pictures (e.g. "your bid was outbid" from the opening round).
  await p.addStyleTag({ content: '#toasts { display: none !important; }' });
  const tick = (sec = 0.05) => p.evaluate((sec) => { const s = window.sr.session; s.paused = false; for (let t = 0; t < sec; t += 0.1) s.update(Math.min(0.1, sec - t)); s.paused = true; }, sec);
  const shot = async (name, clip) => p.screenshot({ path: `${out}/${name}.png`, clip });
  const el = async (name, sel) => {
    await p.evaluate(() => (window.sr.session.paused = true));
    for (let k = 0; k < 6; k++) { try { await p.locator(sel).first().screenshot({ path: `${out}/${name}.png`, timeout: 2000 }); return; } catch (e) { if (k === 5) throw e; await p.waitForTimeout(150); } }
  };

  // 1. Opening sale: bid once on the first company, in its card along the bottom.
  await p.evaluate(() => {
    const s = window.sr.session; s.paused = false;
    for (let i = 0; i < 200 && !s.obs().sales.length; i++) s.update(0.1);
    s.update(3);
    s.act({ type: 'bid', company: 0, amount: 8 }); s.update(0.1);
    s.paused = true;
  });
  await p.mouse.move(5, 5);
  await p.waitForTimeout(400);
  await el('auction', '#companies .co.pinned');

  // Win companies 0 and 1, let the rest go.
  await p.evaluate(() => {
    const s = window.sr.session; s.paused = false;
    for (let i = 0; i < 4000 && s.obs().phase !== 'running'; i++) {
      const o = s.obs(); const sale = o.sales[0];
      if (sale && sale.company <= 1) {
        const bid = o.books[sale.company].bid;
        if (!bid || (bid.player !== o.me && bid.price + 2 <= 48)) s.act({ type: 'bid', company: sale.company, amount: Math.max(40, (bid?.price ?? 0) + 2) });
      }
      s.update(0.1);
    }
    const g = s.game;
    // For the pictures only: you hold three shares of each, and they have some money.
    for (const co of [0, 1]) { g.companies[co].shares = [0, 0, 0, null, null]; g.companies[co].treasury += 60; }
    for (let i = 0; i < 2; i++) s.act({ type: 'buyTruck', company: 0, depot: g.town.locations.find((l) => l.startCompany === 0).id });
    // Company 1 gets on with it, so the map has some life.
    const d1 = g.town.locations.find((l) => l.startCompany === 1);
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    for (let i = 0; i < 3; i++) s.act({ type: 'buyTruck', company: 1, depot: d1.id });
    s.update(0.2);
    // (They route themselves.)
    for (let i = 0; i < 400; i++) s.update(0.1);
    s.paused = true;
  });

  // Zoom in on company 1's factory... (company 0 = you, "Company 1" in the UI).
  const pts = await p.evaluate(() => {
    const s = window.sr.session; const g = s.game; const t = g.town;
    const home = t.locations.find((l) => l.startCompany === 0);
    const dd = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    // A producer and shop of the same good near the factory, not too close together.
    let best = null;
    for (const pr of t.locations.filter((l) => l.kind === 'producer'))
      for (const c of t.locations.filter((l) => l.kind === 'consumer' && l.good === pr.good)) {
        const score = dd(pr, home) + dd(c, home) + Math.abs(dd(pr, c) - 4);
        if (dd(pr, c) >= 3 && (!best || score < best.score)) best = { pr, c, score };
      }
    const free = t.locations.filter((l) => l.kind === 'depot' && s.obs().depots[l.id] === undefined).sort((a, b) => dd(a, home) - dd(b, home))[0];
    return { home: { x: home.x, y: home.y }, pr: { x: best.pr.x, y: best.pr.y }, c: { x: best.c.x, y: best.c.y, id: best.c.id }, free: { x: free.x, y: free.y } };
  });
  const toScreen = (w) => p.evaluate((w) => { const r = window.sr.renderer; const box = document.getElementById('map').getBoundingClientRect(); return { x: box.left + r.X(w.x), y: box.top + r.Y(w.y) }; }, w);
  const centre = { x: (pts.home.x + pts.pr.x + pts.c.x) / 3, y: (pts.home.y + pts.pr.y + pts.c.y) / 3 };
  let cs = await toScreen(centre);
  for (let i = 0; i < 3; i++) { await p.mouse.move(cs.x, cs.y); await p.mouse.wheel(0, -250); await p.waitForTimeout(60); }
  // Drag the map so the three buildings sit in the middle of the view.
  {
    const mb = await (await p.$('#map-wrap')).boundingBox();
    const from = await toScreen({ x: (Math.min(pts.home.x, pts.pr.x, pts.c.x) + Math.max(pts.home.x, pts.pr.x, pts.c.x)) / 2, y: (Math.min(pts.home.y, pts.pr.y, pts.c.y) + Math.max(pts.home.y, pts.pr.y, pts.c.y)) / 2 });
    const to = { x: mb.x + mb.width / 2, y: mb.y + mb.height * 0.45 };
    await p.mouse.move(from.x, from.y); await p.mouse.down();
    for (let k = 1; k <= 10; k++) { await p.mouse.move(from.x + ((to.x - from.x) * k) / 10, from.y + ((to.y - from.y) * k) / 10); await p.waitForTimeout(16); }
    await p.mouse.up();
  }
  await p.mouse.move(5, 5); await tick();
  const sp = await toScreen(pts.pr), sc = await toScreen(pts.c), sh = await toScreen(pts.home);
  const box = await (await p.$('#map-wrap')).boundingBox();
  const pad = 130;
  const clipAround = (...q) => {
    const x0 = Math.max(box.x, Math.min(...q.map((v) => v.x)) - pad), x1 = Math.min(box.x + box.width, Math.max(...q.map((v) => v.x)) + pad);
    const y0 = Math.max(box.y, Math.min(...q.map((v) => v.y)) - pad), y1 = Math.min(box.y + box.height, Math.max(...q.map((v) => v.y)) + pad);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  };
  const hintBox = await (await p.$('#hint')).boundingBox();
  const routeClip = clipAround(sp, sc, sh);
  routeClip.height = Math.min(routeClip.height, hintBox.y - 8 - routeClip.y); // keep the hint out

  // 2. Your company's trucks at work on routes they picked themselves.
  await tick(20); await p.waitForTimeout(400);
  await shot('routes', routeClip);
  // 3. Editing its delivery area: some blocks round its factory, and a focused shop.
  const edit = await p.evaluate(() => {
    const s = window.sr.session; const g = s.game; const W = g.cfg.town.blocksX;
    const home = g.town.locations.find((l) => l.startCompany === 0);
    const blocks = [];
    for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 2; dy++) {
      const x = Math.floor(home.x) + dx, y = Math.floor(home.y) + dy;
      if (x >= 0 && y >= 0 && x < W && y < g.cfg.town.blocksY && !(dx === 2 && dy === -1)) blocks.push(x + y * W);
    }
    s.act({ type: 'setArea', company: 0, blocks });
    const shop = g.town.locations.filter((l) => l.kind === 'consumer' && !blocks.includes(Math.floor(l.x) + Math.floor(l.y) * W))
      .sort((a, b) => Math.hypot(a.x - home.x, a.y - home.y) - Math.hypot(b.x - home.x, b.y - home.y))[0];
    s.act({ type: 'setFocus', company: 0, location: shop.id, on: true });
    return { shop: { x: shop.x, y: shop.y } };
  });
  await tick(1);
  await p.locator('[data-area="0"]').dispatchEvent('pointerdown');
  await tick(); await p.waitForTimeout(300);
  const sfo = await toScreen(edit.shop);
  const barBox = await (await p.$('#area-bar')).boundingBox();
  const areaClip = clipAround(sp, sc, sh, sfo, { x: barBox.x + 20, y: barBox.y + 120 }, { x: barBox.x + barBox.width - 20, y: barBox.y + 120 });
  areaClip.y = Math.min(areaClip.y, barBox.y - 6); areaClip.height = Math.min(hintBox.y - 8, areaClip.y + areaClip.height + 40) - areaClip.y;
  await shot('area', areaClip);
  await p.locator('#area-done').click(); await tick();
  await p.mouse.move(5, 5);

  // 5. A free factory site: hover it for the subsidy meters and prices.
  await tick(240);
  await p.waitForTimeout(3800); // let any payday banner fade
  // The free site where some company is furthest along: zoom in on it so its meter has something to show.
  const best = await p.evaluate(() => {
    const o = window.sr.session.obs(); const t = window.sr.session.game.town;
    let b = null, bp = Infinity;
    for (const [site, pr] of Object.entries(o.depotPrices)) { const m = Math.min(...Object.values(pr)); if (m < bp) { bp = m; b = t.locations[Number(site)]; } }
    window.sr.renderer.fit();
    return { x: b.x, y: b.y };
  });
  await tick();
  { const q = await toScreen(best); for (let i = 0; i < 3; i++) { await p.mouse.move(q.x, q.y); await p.mouse.wheel(0, -250); await p.waitForTimeout(60); } }
  const sf = await toScreen(best);
  await p.mouse.move(sf.x, sf.y); await tick(); await p.waitForTimeout(400);
  const tip = await (await p.$('#tooltip')).boundingBox();
  const fx0 = Math.max(box.x, Math.min(sf.x - 80, tip.x) - 10), fy0 = Math.max(box.y, Math.min(sf.y - 80, tip.y) - 10);
  const fx1 = Math.min(box.x + box.width, Math.max(sf.x + 80, tip.x + tip.width) + 10), fy1 = Math.min(box.y + box.height, Math.max(sf.y + 80, tip.y + tip.height) + 10);
  await shot('factory', { x: fx0, y: fy0, width: fx1 - fx0, height: fy1 - fy0 });
  await p.mouse.move(5, 5);

  // 6. Pick on map: sites you can buy light up with your price.
  await p.evaluate(() => window.sr.renderer.fit()); await tick();
  { const h = await toScreen(pts.home); for (let i = 0; i < 2; i++) { await p.mouse.move(h.x, h.y); await p.mouse.wheel(0, -250); await p.waitForTimeout(60); } }
  await p.mouse.move(5, 5); await tick();
  await (await p.$('#mycos [data-depot]')).dispatchEvent('pointerdown', { button: 0 });
  await tick(); await p.waitForTimeout(400);
  await shot('buy', { x: box.x, y: box.y, width: box.width, height: hintBox.y - 8 - box.y });
  await p.keyboard.press('Escape'); await tick();

  // 7. Shares: your holdings and a company card.
  await el('shares', '#me');
  // A company card, open (hovered), with its market.
  await p.locator('#companies .co').first().hover(); await tick(); await p.waitForTimeout(300);
  await el('company', '#companies .co');
  await p.mouse.move(5, 5);
  // 7b. A share sale: start one in that card, and let the bots bid.
  await p.evaluate(() => { const s = window.sr.session; s.act({ type: 'startSale', company: 0 }); s.paused = false; s.update(0.1); const g = s.game; g.players[1].cash = Math.max(g.players[1].cash, 60); g.act(1, { type: 'bid', company: 0, amount: g.minPrice(0) + 9 }); for (let i = 0; i < 40; i++) s.update(0.1); s.paused = true; });
  await p.locator('#companies .co').first().hover(); await p.waitForTimeout(400);
  await el('sale', '#companies .co');
  await p.mouse.move(5, 5);
  // 8. The whole town, for the welcome page.
  await p.evaluate(() => window.sr.renderer.fit()); await p.mouse.move(5, 5); await tick(); await p.waitForTimeout(300);
  await shot('overview', { x: box.x, y: box.y, width: box.width, height: hintBox.y - 8 - box.y });
  console.log(JSON.stringify(errs));
  await b.close();
})();
