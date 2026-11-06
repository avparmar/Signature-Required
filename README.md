# Signature Required

A real-time competitive logistics game: an RTS where players don't hunt each other, they hunt
customers. Players invest in delivery companies, steer the ones they control and earn through
dividends.

Status: playable prototype in the browser, solo against bots or online with friends.

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

## Playing online

There's no game server: the host's browser tab runs the game and everyone else connects to it
directly (the same approach as Bored of Pizza).

1. One person clicks **Play online**, enters a name and **Host a game**. They get a 4-letter
   room code and an invite link. The game uses the host's ⚙ settings.
2. Friends open the link (or click **Play online** and type the code). Up to 4 players; bots
   take any empty seats.
3. The host clicks **Start game**.

Things to know:
- **The host must keep their tab open** until the game ends: it runs everyone's game. Closing
  it ends the game for everyone.
- If a player leaves or loses connection (no contact for 10 s), a bot takes over their seat.
- Speed is fixed at 1× online. The host can pause; the help and settings cards don't pause
  online games.
- Browsers find each other through the free public PeerJS server, then talk directly (WebRTC).
  That works on most home networks; some strict networks (corporate, some mobile carriers)
  block direct connections, and a relay (TURN) server would fix that.
- Everything in the game is public, so the host's tab knows nothing the others can't see.
- To test locally without the internet: run a PeerJS server
  (`npx peerjs --port 9000 --host 127.0.0.1`) and add
  `?peerHost=127.0.0.1&peerPort=9000&peerPath=/` to the address.

**Deploying:** `.github/workflows/pages.yml` builds the client and publishes it to GitHub Pages
on every push to `main`. Turn it on under the repository's Settings → Pages (Source: GitHub
Actions).

Address options: `?seed=N` (replay a town), `?rivers=0|1|2`, `?watch=1` (watch the bots),
`?join=CODE` (join a room).
