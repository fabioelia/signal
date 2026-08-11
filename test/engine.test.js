import test from 'node:test';
import assert from 'node:assert/strict';
import { REGIONS, NEIGHBORS, adjacent, shortestPath } from '../shared/map.js';
import { RULES } from '../shared/constants.js';
import {
  createMatch, validateOrders, resolveTurn, connectedSet, botsIn, enemyOf,
} from '../shared/engine.js';

// Helper: run one turn with raw orders, validating them like the server does.
function turn(state, ordersA = [], ordersB = []) {
  const a = validateOrders(state, 'A', ordersA);
  const b = validateOrders(state, 'B', ordersB);
  assert.deepEqual(a.rejected, [], `A orders rejected: ${JSON.stringify(a.rejected)}`);
  assert.deepEqual(b.rejected, [], `B orders rejected: ${JSON.stringify(b.rejected)}`);
  return resolveTurn(state, { A: a.accepted, B: b.accepted });
}

function skipTurns(state, n) {
  for (let i = 0; i < n; i++) ({ state } = resolveTurn(state, { A: [], B: [] }));
  return state;
}

test('map: 24 regions, symmetric, fully connected', () => {
  assert.equal(REGIONS.length, 24);
  for (const r of REGIONS) assert.ok(NEIGHBORS[r.id].length >= 2, `${r.id} isolated`);
  // symmetry σ(row,col) = (3-row, 5-col) preserves adjacency
  const byPos = new Map(REGIONS.map((r) => [`${r.row},${r.col}`, r.id]));
  const sigma = (id) => {
    const r = REGIONS.find((x) => x.id === id);
    return byPos.get(`${3 - r.row},${5 - r.col}`);
  };
  for (const r of REGIONS) {
    const mirrored = NEIGHBORS[r.id].map(sigma).sort();
    assert.deepEqual([...NEIGHBORS[sigma(r.id)]].sort(), mirrored, `asymmetry at ${r.id}`);
  }
  // everything reachable from aldermoor
  for (const r of REGIONS) {
    assert.ok(shortestPath('aldermoor', r.id) !== null, `${r.id} unreachable`);
  }
  assert.ok(adjacent('vellmar', 'ilsmere'));
  assert.ok(!adjacent('vellmar', 'ostrey'), 'clusters should not touch directly');
});

test('start: mirrored economies, equal opening income', () => {
  let state = createMatch();
  assert.equal(state.regions.aldermoor.owner, 'A');
  assert.equal(state.regions.kestrave.owner, 'B');
  ({ state } = resolveTurn(state, { A: [], B: [] }));
  assert.equal(state.players.A.income, state.players.B.income);
  assert.ok(state.players.A.income > 0, 'opening income should be positive');
});

test('claiming a neutral region takes 2 turns and requires adjacency', () => {
  let state = createMatch();
  const bad = validateOrders(state, 'A', [{ kind: 'claim', region: 'kelbrey' }]);
  assert.equal(bad.accepted.length, 0, 'kelbrey does not border A');
  ({ state } = turn(state, [{ kind: 'claim', region: 'ilsmere' }]));
  assert.equal(state.regions.ilsmere.owner, null, 'not claimed after 1 turn');
  assert.equal(state.players.A.builds.length, 1);
  ({ state } = turn(state));
  assert.equal(state.regions.ilsmere.owner, 'A', 'claimed after 2 turns');
});

test('swarm: build, travel one link per turn, overwhelm a thin garrison, capture', () => {
  let state = createMatch();
  // A's OPS is at dunmere. Target ostrey (FIN+LNC, 1 bot).
  ({ state } = turn(state, [{ kind: 'build_swarm', target: 'ostrey' }]));
  assert.equal(state.units.filter((u) => u.type === 'swarm').length, 0, 'still building');
  ({ state } = turn(state));
  const swarm = state.units.find((u) => u.type === 'swarm');
  assert.ok(swarm, 'swarm deployed after 2 turns');
  assert.equal(swarm.region, 'dunmere');
  const travel = swarm.path.length;
  assert.ok(travel >= 2, 'ostrey is a few links away');
  state = skipTurns(state, travel);
  assert.equal(state.regions.ostrey.owner, 'A', 'captured');
  assert.equal(state.regions.ostrey.nodes.length, 0, 'nodes smashed on capture');
  assert.equal(botsIn(state, 'ostrey', 'B').length, 0);
  const survivor = state.units.find((u) => u.type === 'swarm');
  assert.ok(survivor.strength < RULES.combat.swarmStrength, 'garrison cost it something');
});

test('swarm loses badly to a concentrated garrison', () => {
  let state = createMatch();
  // Stack halbrook (B border region, 3 bots + INF node) with 3 more bots.
  ({ state } = turn(state, [{ kind: 'build_swarm', target: 'halbrook' }], [
    { kind: 'train_bots', region: 'halbrook', count: 3 },
  ]));
  state = skipTurns(state, 8);
  assert.equal(state.regions.halbrook.owner, 'B', 'held');
  assert.equal(state.units.filter((u) => u.type === 'swarm').length, 0, 'swarm destroyed');
});

test('worm: undetected run destroys a node; detection + garrison intercepts', () => {
  let state = createMatch();
  // Quarrow: B-owned FIN, 0 bots, and outside any B analyst coverage
  // (B analysts sit at umberly and pellhaven; quarrow borders pellhaven... check via engine)
  ({ state } = turn(state, [{ kind: 'build_worm', target: 'quarrow' }]));
  state = skipTurns(state, RULES.turns.worm - 1);
  const worm = state.units.find((u) => u.type === 'worm');
  assert.ok(worm, 'worm deployed');
  const travel = worm.path.length;
  state = skipTurns(state, travel);
  // quarrow borders pellhaven (analyst) — so this worm gets seen; but with no
  // garrison there interception is impossible and the payload still lands.
  assert.equal(state.regions.quarrow.nodes.filter((n) => n.type === 'FIN').length, 0, 'finance hub destroyed');

  // Now a detected worm walking into a garrisoned, covered region dies.
  let s2 = createMatch();
  ({ state: s2 } = turn(s2, [{ kind: 'build_worm', target: 'pellhaven' }]));
  s2 = skipTurns(s2, RULES.turns.worm - 1);
  const w2 = s2.units.find((u) => u.type === 'worm');
  assert.ok(w2);
  s2 = skipTurns(s2, w2.path.length);
  assert.equal(s2.units.filter((u) => u.type === 'worm').length, 0, 'worm intercepted');
  assert.equal(s2.regions.pellhaven.nodes.length, 2, 'pellhaven untouched');
});

test('malware sweep clears a lurking worm', () => {
  let state = createMatch();
  // Drop an enemy worm directly into A's ellwick (simulating a lurker).
  state.units.push({ id: state.nextId++, owner: 'B', type: 'worm', region: 'ellwick', target: 'ellwick', path: [], detectedBy: {} });
  ({ state } = turn(state, [{ kind: 'sweep', region: 'ellwick' }]));
  assert.equal(state.units.filter((u) => u.type === 'worm').length, 0);
});

test('isolation: blocks entry, kills income, reconnect takes 2 turns', () => {
  let state = createMatch();
  const baseline = resolveTurn(state, { A: [], B: [] }).state.players.A.income;
  ({ state } = turn(state, [{ kind: 'isolate', region: 'ellwick' }]));
  assert.equal(state.regions.ellwick.isolated, true);
  assert.equal(state.players.A.income, baseline - RULES.income.finance + RULES.upkeep.node, 'no FIN income, no node upkeep while cut off');

  // enemy worm bounces off the quarantine
  state.units.push({ id: state.nextId++, owner: 'B', type: 'worm', region: 'lowmarch', target: 'ellwick', path: ['ellwick'], detectedBy: {} });
  ({ state } = turn(state));
  const worm = state.units.find((u) => u.type === 'worm');
  assert.equal(worm.region, 'lowmarch', 'worm held outside');

  ({ state } = turn(state, [{ kind: 'reconnect', region: 'ellwick' }]));
  assert.equal(state.regions.ellwick.isolated, false);
  assert.equal(state.regions.ellwick.reconnecting, RULES.reconnectTurns);
  // during reconnection the enemy CAN come in, our reinforcements cannot
  const mv = validateOrders(state, 'A', [{ kind: 'move_bots', from: 'aldermoor', to: 'ellwick', count: 1 }]);
  assert.equal(mv.accepted.length, 0, 'no reinforcements during reconnection');
  ({ state } = turn(state));
  // The worm walks in during the vulnerable window; ellwick has no garrison,
  // so even though it was detected there is nobody to intercept — payload lands.
  assert.equal(state.units.filter((u) => u.type === 'worm').length, 0, 'worm resolved its payload');
  assert.equal(state.regions.ellwick.nodes.filter((n) => n.type === 'FIN').length, 0, 'finance hub destroyed');
  ({ state } = turn(state));
  assert.equal(state.regions.ellwick.reconnecting, 0, 'fully reconnected after 2 turns');
});

test('cutting the capital link starves a cluster (economy siege)', () => {
  let state = createMatch();
  // Sever corvale+vellmar from A by force: give them to B directly.
  state.regions.corvale.owner = 'B';
  state.regions.vellmar.owner = 'B';
  state.regions.brackwell.owner = 'B';
  state.units = state.units.filter((u) => !['corvale', 'vellmar', 'brackwell'].includes(u.region));
  // Now ellwick/fenmar still connect via... check engine's view.
  const conn = connectedSet(state, 'A');
  assert.ok(conn.has('aldermoor'));
  assert.ok(!conn.has('dunmere'), 'dunmere cut off from capital');
  state = skipTurns(state, RULES.starveGrace + 1);
  assert.ok(state.regions.dunmere.starved > RULES.starveGrace);
  assert.ok(
    state.regions.dunmere.nodes.every((n) => n.hp < RULES.combat.nodeHp),
    'starved nodes degrade'
  );
});

test('satellites are public, watch a footprint, and die to ASATs', () => {
  let state = createMatch();
  ({ state } = turn(state, [{ kind: 'build_satellite', target: 'halbrook' }]));
  assert.equal(state.players.A.builds.length, 1);
  state = skipTurns(state, RULES.turns.satellite - 1);
  assert.equal(state.players.A.satellites.length, 1, 'satellite in orbit');
  // A can now see contents of halbrook (B border region)
  assert.ok(state.players.A.sight.includes('halbrook'));
  assert.ok(state.players.A.intel.halbrook, 'fresh intel snapshot');
  assert.equal(state.players.A.intel.halbrook.age, 0);

  const satId = state.players.A.satellites[0].id;
  ({ state } = turn(state, [], [{ kind: 'build_asat', targetSat: satId }]));
  state = skipTurns(state, RULES.turns.asat - 1);
  assert.equal(state.players.A.satellites.length, 0, 'satellite shot down');
  // intel goes stale afterwards
  ({ state } = turn(state));
  assert.ok(state.players.A.intel.halbrook.age >= 1, 'intel aging after coverage lapse');
});

test('anomaly telegraph: covered target region warns about incoming builds', () => {
  let state = createMatch();
  // B builds a swarm aimed at fenmar; fenmar has A's analyst → anomaly for A.
  ({ state } = turn(state, [], [{ kind: 'build_swarm', target: 'fenmar' }]));
  const anomaly = state.players.A.alerts.find((a) => a.type === 'anomaly' || a.type === 'build');
  assert.ok(anomaly, 'A gets warned');
  assert.equal(anomaly.region, 'fenmar');
  assert.ok(anomaly.eta >= 1);
});

test('cancelling a build refunds half (the feint is economically real)', () => {
  let state = createMatch();
  ({ state } = turn(state, [{ kind: 'build_satellite', target: 'ostrey' }]));
  const funding = state.players.A.funding;
  const buildId = state.players.A.builds[0].id;
  ({ state } = turn(state, [{ kind: 'cancel_build', build: buildId }]));
  assert.equal(state.players.A.builds.length, 0);
  const expected = funding + Math.floor(RULES.costs.satellite * RULES.refundRate) + state.players.A.income;
  assert.equal(state.players.A.funding, expected);
});

test('capital siege ends the game', () => {
  let state = createMatch();
  // March overwhelming force straight at kestrave.
  state.units = state.units.filter((u) => u.owner === 'A'); // strip B's bots for speed
  for (let i = 0; i < 3; i++) {
    state.units.push({ id: state.nextId++, owner: 'A', type: 'swarm', region: 'kestrave', target: 'kestrave', path: [], strength: 12 });
  }
  ({ state } = turn(state));
  assert.equal(state.winner, 'A');
  assert.match(state.winReason, /capital/i);
});

test('economic collapse ends the game', () => {
  let state = createMatch();
  // Destroy all of B's finance hubs and capital income by isolating everything.
  for (const r of Object.values(state.regions)) {
    if (r.owner === 'B') r.nodes = r.nodes.filter((n) => n.type !== 'FIN');
  }
  // B still has capital income; add heavy upkeep via satellites.
  for (let i = 0; i < 6; i++) state.players.B.satellites.push({ id: state.nextId++, owner: 'B', region: 'kestrave' });
  for (let i = 0; i < RULES.collapseTurns; i++) {
    ({ state } = turn(state));
    if (state.winner) break;
  }
  assert.equal(state.winner, 'A');
  assert.match(state.winReason, /collapse/i);
});

test('determinism: same state + same orders → identical result', () => {
  const state = createMatch();
  const orders = {
    A: validateOrders(state, 'A', [
      { kind: 'build_swarm', target: 'ostrey' },
      { kind: 'claim', region: 'ilsmere' },
    ]).accepted,
    B: validateOrders(state, 'B', [{ kind: 'build_worm', target: 'vellmar' }]).accepted,
  };
  const r1 = resolveTurn(state, orders);
  const r2 = resolveTurn(state, orders);
  assert.deepEqual(r1.state, r2.state);
  assert.deepEqual(r1.logs, r2.logs);
});

test('fog: view hides what it should', async () => {
  const { buildView } = await import('../shared/view.js');
  let state = createMatch();
  // B builds a worm; A must not see the build or the worm.
  ({ state } = turn(state, [], [{ kind: 'build_worm', target: 'vellmar' }]));
  const viewA = buildView(state, 'A');
  assert.equal(viewA.opponent.builds.length, 0, 'hidden enemy build leaked');
  // kestrave (B capital) is out of A sight: no node/garrison data
  assert.equal(viewA.regions.kestrave.nodes, null);
  assert.equal(viewA.regions.kestrave.garrison, null);
  assert.equal(viewA.regions.kestrave.owner, 'B', 'ownership is public');
  // A's own regions fully visible
  assert.ok(viewA.regions.aldermoor.nodes.length === 3);
  // undetected enemy worms never appear in the unit list
  state = skipTurns(state, RULES.turns.worm - 1);
  const worm = state.units.find((u) => u.type === 'worm');
  assert.ok(worm, 'worm exists in truth');
  const viewA2 = buildView(state, 'A');
  assert.ok(!viewA2.units.some((u) => u.type === 'worm'), 'stealth worm leaked into view');
});
