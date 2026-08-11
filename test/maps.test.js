// Every map must be fair and playable: σ-symmetric (mirror starts), fully
// connected, and good enough terrain that the Daemon can actually fight a
// war on it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MAPS, pathOn } from '../shared/map.js';
import { createMatch, validateOrders, resolveTurn } from '../shared/engine.js';
import { buildView } from '../shared/view.js';
import { aiOrders } from '../public/ai.js';

for (const M of Object.values(MAPS)) {
  test(`map ${M.id}: symmetric, connected, valid starts`, () => {
    // σ-symmetry of the cell set and adjacency.
    const rows = Math.max(...M.regions.map((r) => r.row)) + 1;
    const cols = Math.max(...M.regions.map((r) => r.col)) + 1;
    const byPos = new Map(M.regions.map((r) => [`${r.row},${r.col}`, r.id]));
    const sigma = (id) => {
      const r = M.byId[id];
      return byPos.get(`${rows - 1 - r.row},${cols - 1 - r.col}`);
    };
    for (const r of M.regions) {
      assert.ok(sigma(r.id), `${M.id}: ${r.id} has no mirror cell`);
      const mirrored = M.neighbors[r.id].map(sigma).sort();
      assert.deepEqual([...M.neighbors[sigma(r.id)]].sort(), mirrored, `${M.id}: adjacency asymmetry at ${r.id}`);
    }
    // Fully connected.
    const first = M.regions[0].id;
    for (const r of M.regions) {
      assert.ok(pathOn(M.neighbors, first, r.id) !== null, `${M.id}: ${r.id} unreachable`);
    }
    // Starts: 7 mirrored slots, capitals present, all ids valid.
    assert.equal(M.start.cluster.length, 7);
    for (const [a, b] of M.start.cluster) {
      assert.ok(M.byId[a] && M.byId[b], `${M.id}: bad cluster ids ${a}/${b}`);
      assert.equal(sigma(a), b, `${M.id}: cluster pair ${a}/${b} is not mirrored`);
    }
    assert.equal(M.start.A.capital, M.start.cluster[0][0]);
    assert.equal(M.start.B.capital, M.start.cluster[0][1]);
    // No duplicate ids.
    assert.equal(new Set(M.regions.map((r) => r.id)).size, M.regions.length);
  });

  test(`map ${M.id}: a match runs and the Daemons fight on it`, () => {
    let state = createMatch({ A: 'A', B: 'B' }, M.id);
    assert.equal(state.map, M.id);
    assert.equal(state.players.A.income, state.players.B.income, 'mirrored economies');
    let sawCombatants = false;
    for (let t = 0; t < 20 && !state.winner; t++) {
      const a = validateOrders(state, 'A', aiOrders(buildView(state, 'A'))).accepted;
      const b = validateOrders(state, 'B', aiOrders(buildView(state, 'B'))).accepted;
      ({ state } = resolveTurn(state, { A: a, B: b }));
      if (state.units.some((u) => u.type === 'swarm' || u.type === 'worm')) sawCombatants = true;
    }
    assert.ok(sawCombatants, `${M.id}: no attacks in 20 turns`);
    const ownedA = Object.values(state.regions).filter((r) => r.owner === 'A').length;
    assert.ok(ownedA > 7 || state.winner, `${M.id}: no expansion happened`);
  });
}

test('straits geography: continents connect only through the causeways', () => {
  const M = MAPS.the_straits;
  const blockedCauseways = (id) => ['westford', 'westgate', 'eastford', 'eastgate'].includes(id);
  assert.equal(pathOn(M.neighbors, 'vailmoor', 'kestrelspire', blockedCauseways), null,
    'blocking both causeways must sever the continents');
  assert.ok(pathOn(M.neighbors, 'vailmoor', 'kestrelspire') !== null, 'normally reachable');
});

test('archipelago geography: the core links the islands', () => {
  const M = MAPS.archipelago;
  const core = ['kelpshoal', 'lagoonspire', 'quillreef', 'reefholm'];
  const blockedCore = (id) => core.includes(id);
  assert.equal(pathOn(M.neighbors, 'xebecbay', 'emberholm', blockedCore), null,
    'blocking the core must sever the home islands');
});
