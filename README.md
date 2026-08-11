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

## GitHub Pages (static build)

GitHub Pages serves the `main` branch directly (Settings → Pages → deploy
from branch `main`, root) — live at **https://fabioelia.github.io/signal/**.
The root `index.html` is the Pages entry point; it loads the same client
out of `public/` and `shared/`, so every push to `main` redeploys the site
with no build step.

GitHub Pages can only serve static files — it cannot run the WebSocket
server — so the Pages build offers:

- **Pass-and-play (hot-seat):** the full game running entirely in the page.
  The same `Match` class the server uses runs in-browser with two in-page
  "sockets"; players hand the device back and forth and a full-screen cover
  keeps each side's fog private between turns.
- **Online play against a hosted server:** point the static client at any
  deployed instance of this repo's server with
  `…/?server=wss://your-server.example`. (Deploy `npm start` to any Node
  host — Fly, Railway, Render, a VPS — and Pages becomes a free frontend
  for it.)


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
shared/match.js       one match: seats, planning timer, lock → resolve → sync
                      (no Node dependencies: the server runs it for online play,
                      the browser runs it for pass-and-play)
server/index.js       static hosting + WebSocket lobby (create/join/quick/rejoin)
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
- **Managing the treasury:** the Funds tab itemizes every § of income and
  upkeep. Finished structures can be **decommissioned** (25% of their cost
  back, upkeep stops) and units **disbanded**; swarms and worms can be
  **redirected** mid-route, and you choose which ops centre builds them when
  more than one is idle.
- **Winning:** destroy the opponent's Command centre (walk swarms in, or worm
  it), or starve them — 5 consecutive turns of negative income is an economic
  collapse. Matches are tuned toward 20–40 turns.

## Changelog

**v0.5.0** — sound & vision:
- **Music and sound effects, fully synthesized in WebAudio** (no audio
  files, no licensing): a generative dark-ambient bed — drifting minor pads
  over a deep root pulse with sparse echoing blips — plus a kit of effects
  for orders, lock-in, turn resolution, combat, worm detection, threats and
  win/loss. Speaker toggle in the top bar, preference remembered.
- **Hand-drawn SVG icon set**: distinct glyphs for all six structures
  (star command core, coin-stack finance, shield garrison, eye analyst,
  crosshair red team, dish uplink) plus swarm/worm/satellite marks — on the
  map tiles, in the region panel, the build menu and unit badges.
- **Visual polish**: a proper SIGNAL DOMINION logo mark and favicon, subtle
  circuit-grid backdrop with a slow scan band, hex tiles with light/shade
  depth and hover response.

**v0.4.0** — third playtest feedback round:
- **Route lines on the map**: dashed lines show where your units are
  heading, the routes your queued/under-construction attacks will take, and
  the estimated path of visible incoming threats.
- **Auto-train**: garrisoned regions get an "Auto-train every turn" toggle
  (↻) that queues a defender automatically each planning phase until
  stopped.
- *Bug fix:* action submenus (reinforce sources, build list, origin picker)
  no longer collapse after every click — you can hammer "+1" repeatedly.
- "Train a defender" is always visible, with an inline reason when there's
  no garrison to do the training.

**v0.3.0** — second playtest feedback round:
- *Bug fix:* units now route **around** sealed-off regions instead of walking
  into the quarantine border and jamming; if the map changes mid-journey they
  re-route on their own. (A worm whose *target* is quarantined still bounces
  at the border — that's the point of isolation.)
- Defenders can be sent from **anywhere in your network**, travelling one
  region per turn; the reinforce menu lists sources network-wide with ETAs.
- **Repair** damaged structures (§1 per 2 HP, 1 turn) — capitals excluded.
- **Play vs the Daemon**: a built-in AI opponent for single-player (fair: it
  reads only its own fog-filtered view). Works on the static Pages build.
- Local games **auto-save every turn** (localStorage) — reload and resume;
  saves can be **exported/imported as JSON files**.
- Map scales up to fill the screen; tiles show your in-progress builds (⚒)
  without clicking; red team den / uplink station busy-or-idle status in the
  region panel; worm strikes can be **aimed at a specific structure**.
- Naming pass: Cyber ops → **Red team den**, Launch facility →
  **Uplink station**.

**v0.2.0** — first playtest feedback round: Funds tab (itemized income/
upkeep, assets, builds, field units), decommission/disband/redirect orders,
swarm origin choice, build-menu effect descriptions, "held — way in is cut
off" and decay indicators, remaining-funds display in the order bar,
resolution overlay leads back to the map (with a lock-without-looking
nudge), and a visible version number.

## What's deliberately simplified (next steps)

- Worm routing: the engine supports explicit waypoint routes (and tests use
  them); the client currently always sends shortest-path. A "plot a route"
  UI would make detection-gap play richer.
- Combat resolves in one exchange per turn rather than multi-turn contested
  states.
- The resolution overlay is a summary, not an animated step-through replay.
- One map. The map module is data-driven — more maps are just more entries.
- Matches live in memory only (no persistence across server restarts).
