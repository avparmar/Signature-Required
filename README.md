# Signature Required

A real-time competitive logistics game: an RTS where players don't hunt each other, they hunt
customers. Players invest in delivery companies, steer the ones they control and earn through
dividends.

Status: Stage 0 (headless economy simulation). Nothing playable yet.

## Development

Requires Node 22.12+.

```sh
npm install
npm test          # unit tests (Vitest)
npm run typecheck # TypeScript, all packages
npm run sim       # headless game runner
npm run dev       # play in the browser against bots (open the URL it prints)
```

## Layout

- `core/` game rules: pure and deterministic (seeded RNG, no DOM, no timers)
- `sim/` bots, the headless runner and balance experiments
- `client/` browser client (Vite + canvas)
