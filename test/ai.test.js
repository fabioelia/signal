// The Daemon plays headlessly through the real engine, seeing only its own
// fog-filtered view — exactly like in the browser. These tests pin down
// "harder": it must crush a passive opponent quickly, and two Daemons must
// fight a real war without generating garbage orders.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, validateOrders, resolveTurn } from '../shared/engine.js';
import { buildView } from '../shared/view.js';
import { aiOrders } from '../public/ai.js';

function aiTurn(state, side) {
  const view = buildView(state, side);
  const raw = aiOrders(view);
  const { accepted, rejected } = validateOrders(state, side, raw);
  return { accepted, rejectedCount: rejected.length, rawCount: raw.length };
}

test('the Daemon defeats a passive opponent well inside the target match length', () => {
  let state = createMatch({ A: 'Daemon', B: 'Idle' });
  let turns = 0;
  while (!state.winner && turns < 40) {
    const { accepted } = aiTurn(state, 'A');
    ({ state } = resolveTurn(state, { A: accepted, B: [] }));
    turns += 1;
  }
  assert.equal(state.winner, 'A', `no win after ${turns} turns`);
  assert.ok(turns <= 35, `took ${turns} turns — too slow for "harder"`);
});

test('Daemon vs Daemon: a real war, mostly-valid orders, no crashes', () => {
  let state = createMatch({ A: 'Daemon A', B: 'Daemon B' });
  let issued = 0;
  let rejected = 0;
  let sawAttack = false;
  let maxRegions = 7;
  for (let t = 0; t < 30 && !state.winner; t++) {
    const a = aiTurn(state, 'A');
    const b = aiTurn(state, 'B');
    issued += a.rawCount + b.rawCount;
    rejected += a.rejectedCount + b.rejectedCount;
    ({ state } = resolveTurn(state, { A: a.accepted, B: b.accepted }));
    if (state.units.some((u) => u.type === 'swarm' || u.type === 'worm')) sawAttack = true;
    const owned = Object.values(state.regions).filter((r) => r.owner === 'A').length;
    maxRegions = Math.max(maxRegions, owned);
  }
  assert.ok(maxRegions > 7, 'the Daemon expands beyond its starting cluster');
  assert.ok(sawAttack, 'the Daemons actually fight');
  assert.ok(issued > 50, `only ${issued} orders issued across the match`);
  assert.ok(rejected / issued < 0.25, `${rejected}/${issued} orders rejected — the Daemon is confused`);
});
