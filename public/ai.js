// The Daemon — the built-in opponent.
//
// Fair by construction: it reads ONLY its own fog-filtered view (the same
// object a human player's client receives) and its orders pass the same
// validation as everyone else's. Deterministic: no randomness, only
// heuristics keyed off the visible situation and the turn number.
//
// Doctrine, in priority order:
//   1. Survive — read each telegraphed threat's strength and ETA, close the
//      defense gap (train, then pull bots network-wide), and when a worm is
//      about to land on an ungarrisoned region, take the quarantine trade
//      and cut it off. Reconnect when things are quiet.
//   2. Grow — scale finance with the game, claim toward the front (two at a
//      time when rich), put garrisons and analysts on the frontier, add red
//      team dens for bigger waves.
//   3. Strike — mass or don't bother: pick one target, compare committed
//      strength against estimated defense, and queue enough simultaneous
//      swarms to actually win the fight. Worms aim at finance/capitals and
//      route around the opponent's (public) satellite footprints.

import { RULES } from '../shared/constants.js';
import { shortestPath } from '../shared/map.js';

const dist = (a, b) => (shortestPath(a, b) || []).length || 99;
const mode = (arr) => {
  const counts = {};
  let best = null;
  for (const x of arr) {
    counts[x] = (counts[x] || 0) + 1;
    if (best === null || counts[x] > counts[best]) best = x;
  }
  return best;
};

export function aiOrders(view) {
  const orders = [];
  const c = RULES.costs;
  const me = view.side;
  let budget = view.you.funding;
  const spend = (cost) => (cost <= budget ? ((budget -= cost), true) : false);

  const regions = Object.values(view.regions);
  const mine = regions.filter((r) => r.owner === me);
  const enemyRegions = regions.filter((r) => r.owner && r.owner !== me);
  const neutral = regions.filter((r) => !r.owner);
  const myCap = view.you.capital;
  const enemyCap = view.opponent.capital;

  const nodesIn = (r, t) => (r.nodes || []).filter((n) => n.type === t).length;
  const intelNodes = (r, t) => (r.intel?.nodes || []).filter((n) => n.type === t).length;
  const countNodes = (t) => mine.reduce((s, r) => s + nodesIn(r, t), 0);
  const defOf = (r) => (r.garrison || 0) * 2 + ((r.garrison || 0) > 0 ? nodesIn(r, 'INF') * 2 : 0);
  const enemyDefEstimate = (r) => {
    if (r.visible && r.garrison != null) return r.garrison * 2 + nodesIn(r, 'INF') * 2;
    if (r.intel) return (r.intel.garrison || 0) * 2 + intelNodes(r, 'INF') * 2 + (r.intel.age > 3 ? 2 : 0);
    return 6; // never scouted: assume a modest garrison
  };

  // Bots available to redeploy this turn (don't double-assign, keep reserves).
  const avail = {};
  for (const r of mine) avail[r.id] = r.garrison || 0;
  const reserveOf = (id) => (id === myCap ? 3 : 1);
  const sendBots = (to, botsNeeded) => {
    let remaining = botsNeeded;
    const sources = mine
      .filter((x) => x.id !== to && !x.isolated && avail[x.id] > reserveOf(x.id))
      .sort((a, b) => dist(a.id, to) - dist(b.id, to));
    for (const s of sources) {
      if (remaining <= 0) break;
      const give = Math.min(avail[s.id] - reserveOf(s.id), remaining);
      if (give > 0) {
        orders.push({ kind: 'move_bots', from: s.id, to, count: give });
        avail[s.id] -= give;
        remaining -= give;
      }
    }
    return botsNeeded - remaining;
  };

  // ---- Phase 1: survival --------------------------------------------------
  for (const u of view.units) {
    if (u.owner !== me && u.type === 'worm' && view.regions[u.region]?.owner === me) {
      if (spend(c.sweepFar)) orders.push({ kind: 'sweep', region: u.region });
    }
  }
  const threats = {}; // region -> { strength, eta, worm }
  for (const a of view.you.alerts) {
    if (!a.region || view.regions[a.region]?.owner !== me) continue;
    const t = (threats[a.region] ??= { strength: 0, eta: 9, worm: false });
    t.eta = Math.min(t.eta, a.eta ?? 9);
    t.worm = t.worm || a.type === 'worm';
    t.strength += a.strength ?? (a.type === 'siege' ? 8 : 6);
  }
  for (const [rid, t] of Object.entries(threats)) {
    const r = view.regions[rid];
    let gap = t.strength + 2 - defOf(r);
    if (gap > 0 && nodesIn(r, 'INF') && !r.isolated && !r.reconnecting) {
      const train = Math.min(5, Math.ceil(gap / 2));
      if (spend(c.bot * train)) {
        orders.push({ kind: 'train_bots', region: rid, count: train });
        gap -= train * 2;
      }
    }
    if (gap > 0 && !r.isolated && r.reconnecting === 0) {
      gap -= sendBots(rid, Math.ceil(gap / 2)) * 2;
    }
    // Quarantine trades: a worm about to land with nobody to intercept, or a
    // wave we cannot possibly stop, on a region worth saving.
    const valuable = (r.nodes || []).length >= 2;
    if (!r.isolated && rid !== myCap) {
      if (t.worm && (r.garrison || 0) === 0 && t.eta <= 1) {
        orders.push({ kind: 'isolate', region: rid });
      } else if (gap > 4 && t.eta <= 1 && valuable) {
        orders.push({ kind: 'isolate', region: rid });
      }
    }
  }
  if (Object.keys(threats).length === 0) {
    const iso = mine.find((r) => r.isolated);
    if (iso) orders.push({ kind: 'reconnect', region: iso.id });
  }

  // War chest: once the opening is done, keep money back from the economy
  // planners so the military phase can actually field waves.
  const warChest = view.turn >= 4 ? Math.min(Math.floor(budget * 0.55), 4 * c.swarm) : 0;
  budget -= warChest;

  // ---- Phase 2: economy ---------------------------------------------------
  for (const r of mine) {
    const hurt = (r.nodes || []).find((n) => n.type !== 'CAP' && n.hp < n.maxHp * 0.65);
    if (hurt && r.connected && !r.isolated && !r.reconnecting) {
      const cost = Math.max(5, Math.ceil((hurt.maxHp - hurt.hp) * RULES.repairPerHp));
      if (spend(cost)) orders.push({ kind: 'repair', region: r.id, type: hurt.type });
    }
  }
  const buildable = mine.filter((r) => r.connected && !r.isolated && !r.reconnecting
    && (r.nodes || []).length < RULES.maxNodesPerRegion);
  const safest = [...buildable].sort((a, b) => dist(b.id, enemyCap) - dist(a.id, enemyCap));
  const finTarget = Math.min(8, 3 + Math.floor(view.turn / 4));
  if (countNodes('FIN') < finTarget && safest[0] && spend(c.node.FIN)) {
    orders.push({ kind: 'build_node', region: safest[0].id, type: 'FIN' });
  }
  // Expansion: keep one claim going, two when flush.
  let claims = view.you.builds.filter((b) => b.kind === 'claim').length;
  const claimable = neutral
    .filter((r) => r.neighbors.some((n) => view.regions[n]?.owner === me && view.regions[n]?.connected))
    .sort((a, b) => dist(a.id, enemyCap) - dist(b.id, enemyCap));
  const wantClaims = budget > 260 ? 2 : 1;
  for (const target of claimable) {
    if (claims >= wantClaims) break;
    if (!spend(c.claim)) break;
    orders.push({ kind: 'claim', region: target.id });
    claims += 1;
  }
  // Frontier infrastructure.
  const frontier = mine
    .filter((r) => r.neighbors.some((n) => view.regions[n] && view.regions[n].owner !== me))
    .sort((a, b) => dist(a.id, enemyCap) - dist(b.id, enemyCap));
  const slots = (r) => r.connected && !r.isolated && !r.reconnecting && (r.nodes || []).length < RULES.maxNodesPerRegion;
  if (view.turn >= 3) {
    const bare = frontier.find((r) => !nodesIn(r, 'INF') && slots(r));
    if (bare && spend(c.node.INF)) orders.push({ kind: 'build_node', region: bare.id, type: 'INF' });
  }
  if (countNodes('ANL') < 2 + Math.floor(view.turn / 12)) {
    const spot = frontier.find((r) => !nodesIn(r, 'ANL') && slots(r));
    if (spot && spend(c.node.ANL)) orders.push({ kind: 'build_node', region: spot.id, type: 'ANL' });
  }
  // Red team dens: scale with the game; co-locate for synchronized waves.
  const opsCount = countNodes('OPS');
  const opsWanted = view.turn >= 12 ? 3 : view.turn >= 5 ? 2 : 1;
  if (opsCount < opsWanted) {
    const together = mine.find((r) => nodesIn(r, 'OPS') && slots(r));
    const spot = together || safest.find(slots);
    if (spot && spend(c.node.OPS)) orders.push({ kind: 'build_node', region: spot.id, type: 'OPS' });
  }

  // ---- Phase 3: military --------------------------------------------------
  budget += warChest; // everything left is for the war
  const capR = view.regions[myCap];
  if ((capR.garrison || 0) < 4 && nodesIn(capR, 'INF') && spend(c.bot * 2)) {
    orders.push({ kind: 'train_bots', region: myCap, count: 2 });
  }
  for (const r of frontier.slice(0, 4)) {
    if ((avail[r.id] || 0) < 2 && nodesIn(r, 'INF') && !r.isolated && !r.reconnecting) {
      if (spend(c.bot)) orders.push({ kind: 'train_bots', region: r.id, count: 1 });
    }
  }

  // Offense: one concerted assault at a time. Continue the current one if it
  // exists, otherwise open one against the weakest known enemy region.
  const mySwarms = view.units.filter((u) => u.owner === me && u.type === 'swarm');
  const buildingSwarms = view.you.builds.filter((b) => b.kind === 'swarm');
  const buildingWorms = view.you.builds.filter((b) => b.kind === 'worm');
  let opsFree = opsCount - buildingSwarms.length - buildingWorms.length;
  const stillEnemy = (id) => id && view.regions[id]?.owner && view.regions[id].owner !== me;
  let target = [mode(mySwarms.map((u) => u.target).filter(stillEnemy)), buildingSwarms[0]?.target]
    .find(stillEnemy) || null;
  if (!target && enemyRegions.length) {
    if (view.turn >= 12) {
      target = enemyCap; // mid-game: stop nibbling, go for the throat
    } else {
      const ranked = enemyRegions
        .map((r) => ({
          r,
          d: enemyDefEstimate(r),
          fin: r.visible ? nodesIn(r, 'FIN') : intelNodes(r, 'FIN'),
        }))
        .sort((a, b) => (a.d - b.d) || (b.fin - a.fin) || (dist(a.r.id, myCap) - dist(b.r.id, myCap)));
      target = ranked[0]?.r.id || null;
    }
  }
  if (target && view.turn >= 3) {
    // Rally idle survivors of finished fights into the current assault.
    for (const u of mySwarms) {
      const t = view.regions[u.target];
      if ((u.eta ?? 0) === 0 && u.region !== target && (!t || t.owner === me)) {
        orders.push({ kind: 'retarget', unit: u.id, target });
      }
    }
    const capitalPush = target === enemyCap;
    const targetDef = Math.max(enemyDefEstimate(view.regions[target]), capitalPush ? 12 : 0);
    const committed = mySwarms.filter((u) => u.target === target).reduce((s, u) => s + (u.strength || 0), 0)
      + buildingSwarms.filter((b) => b.target === target).length * RULES.combat.swarmStrength;
    const required = targetDef + 7;
    if (committed < required && opsFree > 0) {
      const toQueue = Math.min(Math.ceil((required - committed) / RULES.combat.swarmStrength), opsFree);
      for (let i = 0; i < toQueue; i++) {
        if (!spend(c.swarm)) break;
        orders.push({ kind: 'build_swarm', target });
        opsFree -= 1;
      }
    }
  }
  // One stealth worm in play at a time: aim at known finance, else the
  // capital, and route around the opponent's public satellite coverage.
  const wormsAlive = view.units.filter((u) => u.owner === me && u.type === 'worm').length + buildingWorms.length;
  if (wormsAlive === 0 && view.turn >= 6 && opsFree > 0) {
    const finSpots = enemyRegions
      .filter((r) => (r.visible && nodesIn(r, 'FIN')) || intelNodes(r, 'FIN'))
      .sort((a, b) => dist(a.id, myCap) - dist(b.id, myCap));
    const wTarget = finSpots[0]?.id || enemyCap;
    if (spend(c.worm)) {
      const o = { kind: 'build_worm', target: wTarget, targetNode: wTarget === enemyCap ? 'CAP' : 'FIN' };
      const enemySats = (view.satellites || []).filter((s) => s.owner !== me);
      const den = mine.find((r) => nodesIn(r, 'OPS'));
      if (enemySats.length && den) {
        const hot = new Set();
        for (const s of enemySats) {
          hot.add(s.region);
          for (const n of view.regions[s.region]?.neighbors || []) hot.add(n);
        }
        const route = shortestPath(den.id, wTarget, (id) => id !== wTarget && (hot.has(id) || view.regions[id]?.isolated));
        if (route) {
          o.facility = den.id;
          o.route = route;
        }
      }
      orders.push(o);
    }
  }
  // Orbit: recon the assault target first; shoot down satellites parked
  // over our territory.
  const lncBusy = view.you.builds.filter((b) => b.kind === 'satellite' || b.kind === 'asat').length;
  if (countNodes('LNC') - lncBusy > 0) {
    const nuisance = (view.satellites || []).find((s) => s.owner !== me
      && [s.region, ...(view.regions[s.region]?.neighbors || [])].some((id) => view.regions[id]?.owner === me));
    if (view.you.satellites.length === 0 && budget > 220 && spend(c.satellite)) {
      orders.push({ kind: 'build_satellite', target: target || enemyCap });
    } else if (nuisance && budget > 260 && spend(c.asat)) {
      orders.push({ kind: 'build_asat', targetSat: nuisance.id });
    }
  }

  return orders;
}
