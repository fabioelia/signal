# SIGNAL DOMINION

A 2-player, online, head-to-head, turn-based cyber-strategy game. Two
governments conduct network operations against each other on a shared world
map: expand your network, read your opponent's telegraphed moves, hide your
own, and compromise their capital.

Turns are **simultaneous (WEGO)**: both players plan in private, then all
orders resolve together in a fixed, documented order. No randomness anywhere —
this is a game of position, information, and timing.

## Running it

```bash
npm install
npm start          # http://localhost:3000  (PORT env var to change)
```

Open the URL in two browser windows (or on two machines pointing at the same
server) to play head-to-head.

```bash
npm test           # headless engine tests + a two-socket end-to-end test
```

The only runtime dependency is [`ws`](https://github.com/websockets/ws).
No build step — the client is plain ES modules served statically.

## How two players connect / join a game

Everything runs over a single WebSocket per player. Three ways to get into a
match:

1. **Create + share a code.** Player 1 enters a name and clicks
   *Create match* (choosing pacing: *Live* with a 90-second planning timer, or
   *Relaxed* with no timer). The server creates the match, seats them as side
   A, and shows a **4-letter code** and a **shareable link**
   (`https://host/?code=XXXX`).
2. **Join with the code.** Player 2 opens the site (the link pre-fills the
   code), enters the code, and is seated as side B. Both players press
   *Start the match* (ready-up) and the game begins.
3. **Quick match.** Both players press *Quick match* and the server pairs the
   two most recent strangers in the queue into a fresh live match.

**Reconnection:** on joining, each seat receives a secret token
(`CODE.uuid`), stored in the browser's localStorage. Reloading the page or
dropping the connection re-attaches to the same seat with the full current
view; the opponent sees a "disconnected" indicator in the meantime. Matches
are held in server memory and garbage-collected after an hour of inactivity.

### Wire protocol (JSON over WebSocket)

Client → server:

| message | payload | meaning |
|---|---|---|
| `create` | `name`, `pacing` | create a match, seat as A |
| `join` | `name`, `code` | join a match by code, seat as B |
| `quick` | `name` | enter the quick-match queue |
| `rejoin` | `token` | re-attach to a seat after a disconnect |
| `ready` | `ready` | toggle readiness in the lobby |
| `lock` | `orders: [...]` | submit this turn's orders (final) |

Server → client: `joined` (seat + token), `waiting`, `error`, and `sync` — a
single self-describing snapshot containing the match phase, the planning
deadline, both players' lock/ready/connected flags, this player's
**fog-filtered view**, and the last turn's resolution log. The full game state
never leaves the server, so a modified client cannot peek through the fog.

A turn is exactly: *collect both order sets → resolve → notify*. In live
pacing the server enforces the deadline (unlocked players resolve with no
orders); in relaxed pacing the turn waits for both locks — which makes async
correspondence play work with no extra machinery.

## Architecture

```
shared/constants.js   rule numbers (costs, build times, income, combat)
shared/map.js         24-region hex map, links, symmetric starting clusters
shared/engine.js      createMatch / validateOrders / resolveTurn — pure + deterministic
shared/view.js        buildView(state, side) — the fog-of-war filter
server/index.js       static hosting + WebSocket lobby (create/join/quick/rejoin)
server/match.js       one match: seats, planning timer, lock → resolve → sync
public/               vanilla-JS client (implements the Claude Design handoff)
test/engine.test.js   headless rules tests (the §8 interplay patterns)
test/e2e.test.js      real server + two socket clients end to end
```

`resolveTurn(state, {A, B}) → {state, logs}` is a pure function — same input,
same output, no clocks, no randomness. The server, the tests, and any future
replay/spectator system all share it.

### Deterministic resolution order

Every turn resolves in the same order (shown to players in the resolution
overlay, and used as `step` numbers in the report):

1. Isolation toggles; reconnection countdowns tick
2. Movement — every unit in transit advances one link (worm detection checks
   happen on entry)
3. Combat and interception at contested regions; captures and capital sieges
4. Malware sweeps, then worm payloads
5. Build queues tick; completed claims/structures/units/launches appear
6. Economy — connectivity from the capital, starvation, income/upkeep, win
   checks
7. Vision — detection coverage recomputed, intel snapshots refreshed/aged,
   alerts raised

## Rules summary

- **Map:** 24 named regions on a hex graph ("Fractured Belt"). Topology and
  ownership are public; *contents* are not. Each player starts with a mirrored
  seven-region cluster (capitals: Aldermoor vs Kestrave).
- **Nodes** (structures, max 4 per region): Command centre (capital,
  win-condition anchor), Finance hub (income), Defender garrison (trains
  infantry bots), Analyst post (detection in region + neighbours, cheap
  sweeps), Cyber ops (builds swarms/worms), Launch facility (satellites/ASATs).
- **Units:** infantry **bots** (defence, move only within your network),
  **swarms** (cheap visible attackers, capture regions, besiege capitals),
  **worms** (expensive, invisible unless detected; payload destroys a node or
  damages a capital). Rock-paper-scissors: swarms beat thin defence →
  massed bots beat swarms → worms beat what can't see them → detection beats
  worms.
- **Fog & intel:** you fully see your regions, your units' locations, and
  everything inside analyst/satellite coverage. Everything else is a
  **snapshot** that ages ("scouted 3 turns ago").
- **Orbital layer:** satellite launches are public; a live satellite watches a
  region + neighbours anywhere on the map and reveals worms. ASATs are built
  quietly and destroy one chosen satellite.
- **Isolation:** cut a region off instantly — nothing in or out, no support.
  Reconnecting takes 2 turns during which the region is vulnerable *and*
  unsupported. Regions cut off from the capital (by isolation or by a severed
  link path) stop earning and start degrading after 2 turns — cutting
  connectivity is a real strategy.
- **Telegraphing:** offensive builds aimed at a region you have detection
  over raise an **anomaly** ("something is being built against Vellmar, ~3
  turns out — type unknown"); full sight of the enemy facility reveals the
  build itself. In-progress builds can be cancelled for a 50% refund, so
  feints are possible but cost real money.
- **Winning:** destroy the opponent's Command centre (walk swarms in, or worm
  it), or starve them — 5 consecutive turns of negative income is an economic
  collapse. Matches are tuned toward 20–40 turns.

## What's deliberately simplified (next steps)

- Worm routing: the engine supports explicit waypoint routes (and tests use
  them); the client currently always sends shortest-path. A "plot a route"
  UI would make detection-gap play richer.
- Combat resolves in one exchange per turn rather than multi-turn contested
  states.
- The resolution overlay is a summary, not an animated step-through replay.
- One map. The map module is data-driven — more maps are just more entries.
- Matches live in memory only (no persistence across server restarts).
