// The Daemon — a modest built-in opponent for single-player games.
//
// It is deliberately fair: it reads ONLY its own fog-filtered view (the same
// object a human player's client receives), so it cannot see through the fog,
// and its orders go through the same validation as everyone else's. Anything
// silly it asks for is simply rejected by the engine.
//
// It is also deterministic: no randomness, just heuristics keyed off the turn
// number, so replays and tests stay reproducible.

import { RULES } from '../shared/constants.js';
import { shortestPath } from '../shared/map.js';

const dist = (a, b) => (shortestPath(a, b) || []).length || 99;

export function aiOrders(view) {
  const orders = [];
  const c = RULES.costs;
  let budget = view.you.funding;
  const spend = (cost) => {
    if (cost > budget) return false;
    budget -= cost;
    return true;
  };

  const me = view.side;
  const regions = Object.values(view.regions);
  const mine = regions.filter((r) => r.owner === me);
  const enemyRegions = regions.filter((r) => r.owner && r.owner !== me);
  const neutral = regions.filter((r) => !r.owner);
  const myCapital = view.you.capital;
  const enemyCapital = view.opponent.capital;
  const nodesIn = (r, type) => (r.nodes || []).filter((n) => n.type === type).length;
  const countNodes = (type) => mine.reduce((s, r) => s + nodesIn(r, type), 0);

  // --- 1. Emergencies -----------------------------------------------------
  // Sweep any worm we can see sitting in our territory.
  for (const u of view.units) {
    if (u.owner !== me && u.type === 'worm' && view.regions[u.region]?.owner === me) {
      if (spend(c.sweepFar)) orders.push({ kind: 'sweep', region: u.region });
    }
  }
  // Answer telegraphed threats: garrison up the targeted region.
  const threatened = new Set();
  for (const a of view.you.alerts) {
    if (!a.region || threatened.has(a.region)) continue;
    const r = view.regions[a.region];
    if (!r || r.owner !== me) continue;
    threatened.add(a.region);
    if (nodesIn(r, 'INF') && spend(c.bot * 2)) {
      orders.push({ kind: 'train_bots', region: a.region, count: 2 });
    } else {
      const src = mine
        .filter((x) => x.id !== a.region && (x.garrison || 0) > 1 && !x.isolated)
        .sort((x, y) => (y.garrison || 0) - (x.garrison || 0))[0];
      if (src) orders.push({ kind: 'move_bots', from: src.id, to: a.region, count: Math.min(2, (src.garrison || 1) - 1) });
    }
  }

  // --- 2. Economy ---------------------------------------------------------
  const buildable = mine.filter((r) => r.connected && !r.isolated && !r.reconnecting
    && (r.nodes || []).length < RULES.maxNodesPerRegion);
  const safest = [...buildable].sort((x, y) => dist(y.id, enemyCapital) - dist(x.id, enemyCapital));
  if (countNodes('FIN') < 5 && safest[0] && spend(c.node.FIN)) {
    orders.push({ kind: 'build_node', region: safest[0].id, type: 'FIN' });
  }
  // Fix anything badly damaged (never the capital — the engine forbids it anyway).
  for (const r of mine) {
    const hurt = (r.nodes || []).find((n) => n.type !== 'CAP' && n.hp < n.maxHp * 0.7);
    if (hurt && r.connected && !r.isolated && !r.reconnecting) {
      const cost = Math.max(5, Math.ceil((hurt.maxHp - hurt.hp) * RULES.repairPerHp));
      if (spend(cost)) orders.push({ kind: 'repair', region: r.id, type: hurt.type });
    }
  }
  // Expand toward the front, one claim at a time.
  if (!view.you.builds.some((b) => b.kind === 'claim')) {
    const target = neutral
      .filter((r) => r.neighbors.some((n) => view.regions[n]?.owner === me && view.regions[n]?.connected))
      .sort((x, y) => dist(x.id, enemyCapital) - dist(y.id, enemyCapital))[0];
    if (target && spend(c.claim)) orders.push({ kind: 'claim', region: target.id });
  }

  // --- 3. Force structure -------------------------------------------------
  if (!countNodes('OPS') && safest[0] && spend(c.node.OPS)) {
    orders.push({ kind: 'build_node', region: safest[0].id, type: 'OPS' });
  }
  // Keep a floor of defenders at the capital.
  const capRegion = view.regions[myCapital];
  if (capRegion && (capRegion.garrison || 0) < 3 && nodesIn(capRegion, 'INF') && spend(c.bot)) {
    orders.push({ kind: 'train_bots', region: myCapital, count: 1 });
  }

  // --- 4. Offense ---------------------------------------------------------
  const opsCapacity = countNodes('OPS');
  const opsBusy = view.you.builds.filter((b) => b.kind === 'swarm' || b.kind === 'worm').length;
  if (opsCapacity > opsBusy && view.turn >= 4 && enemyRegions.length) {
    // Hit the softest region we have (possibly stale) intel on; when blind,
    // probe the nearest enemy region.
    const known = enemyRegions
      .map((r) => ({ r, gar: r.visible ? r.garrison : r.intel ? r.intel.garrison : null }))
      .filter((k) => k.gar !== null)
      .sort((a, b) => a.gar - b.gar)[0];
    const target = known ? known.r
      : [...enemyRegions].sort((a, b) => dist(myCapital, a.id) - dist(myCapital, b.id))[0];
    if (view.turn % 3 === 0) {
      if (spend(c.worm)) orders.push({ kind: 'build_worm', target: target.id });
    } else if (spend(c.swarm)) {
      orders.push({ kind: 'build_swarm', target: target.id });
    }
  }

  // --- 5. Eyes ------------------------------------------------------------
  const lncCapacity = countNodes('LNC');
  const lncBusy = view.you.builds.filter((b) => b.kind === 'satellite' || b.kind === 'asat').length;
  if (lncCapacity > lncBusy) {
    const enemySat = view.opponent.satellites[0];
    if (view.you.satellites.length === 0 && budget > 250 && spend(c.satellite)) {
      orders.push({ kind: 'build_satellite', target: enemyCapital });
    } else if (enemySat && view.turn % 5 === 0 && spend(c.asat)) {
      orders.push({ kind: 'build_asat', targetSat: enemySat.id });
    }
  }

  return orders;
}
