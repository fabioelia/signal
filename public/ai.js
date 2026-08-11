// The Daemon — the built-in opponent.
//
// Fair by construction: it reads ONLY its own fog-filtered view (the same
// object a human player's client receives) and its orders pass the same
// validation as everyone else's. Deterministic: no randomness, only
// heuristics keyed off the visible situation.
//
// v3 plays the game's actual strategic language (the design doc's §8
// interplay patterns), not just efficient macro:
//   · Economy siege — ownership is public, so it computes cut vertices:
//     enemy regions whose fall disconnects a cluster from their capital,
//     and weights its targeting toward them. The same math defensively
//     gives its own chokepoints (causeways, isthmuses) garrison floors.
//   · The feint — opening an assault, it may queue a swarm at a decoy the
//     defender can see coming (a region under the defender's own satellite),
//     let the anomaly land, then cancel for the refund and hit the real
//     target. The cancellation falls out of a general plan-correction pass.
//   · The orbital swing — if the defender's satellite covers its attack
//     corridor, it builds the satellite killer first and holds the wave
//     until the eyes are about to go dark.
//   · Multiple simultaneous threats — with enough red team dens it opens a
//     second front far from the first, so defense cannot cover both.
//   · Retreat — undersized assaults stop feeding; survivors peel off to
//     the softest reachable target instead of dying on a wall.
//
// Two levels: 'ruthless' (all of the above) and 'standard' (the gentler
// macro game only).

import { RULES } from '../shared/constants.js';
import { pathOn } from '../shared/map.js';

const mode = (arr) => {
  const counts = {};
  let best = null;
  for (const x of arr) {
    counts[x] = (counts[x] || 0) + 1;
    if (best === null || counts[x] > counts[best]) best = x;
  }
  return best;
};

// How many of `ownedSet`'s regions lose their connection to `capital` if
// `removeId` falls. Public information — ownership and links are open.
function cutValue(NB, ownedSet, capital, removeId) {
  if (!ownedSet.has(removeId)) return 0;
  if (removeId === capital) return ownedSet.size;
  const reach = new Set([capital]);
  const q = [capital];
  while (q.length) {
    for (const n of NB[q.shift()] || []) {
      if (reach.has(n) || !ownedSet.has(n) || n === removeId) continue;
      reach.add(n);
      q.push(n);
    }
  }
  return Math.max(0, ownedSet.size - reach.size - 1);
}

export function aiOrders(view, level = 'ruthless') {
  const ruthless = level !== 'standard';
  const orders = [];
  const c = RULES.costs;
  const me = view.side;
  let budget = view.you.funding;
  const spend = (cost) => (cost <= budget ? ((budget -= cost), true) : false);

  const NB = {};
  for (const [id, r] of Object.entries(view.regions)) NB[id] = r.neighbors;
  const dist = (a, b) => (pathOn(NB, a, b) || []).length || 99;

  const regions = Object.values(view.regions);
  const mine = regions.filter((r) => r.owner === me);
  const enemyRegions = regions.filter((r) => r.owner && r.owner !== me);
  const neutral = regions.filter((r) => !r.owner);
  const myCap = view.you.capital;
  const enemyCap = view.opponent.capital;
  const myOwned = new Set(mine.map((r) => r.id));
  const enemyOwned = new Set(enemyRegions.map((r) => r.id));

  const nodesIn = (r, t) => (r.nodes || []).filter((n) => n.type === t).length;
  const intelNodes = (r, t) => (r.intel?.nodes || []).filter((n) => n.type === t).length;
  const countNodes = (t) => mine.reduce((s, r) => s + nodesIn(r, t), 0);
  const defOf = (r) => (r.garrison || 0) * 2 + ((r.garrison || 0) > 0 ? nodesIn(r, 'INF') * 2 : 0);
  const enemyDefEstimate = (r) => {
    if (r.visible && r.garrison != null) return r.garrison * 2 + nodesIn(r, 'INF') * 2;
    if (r.intel) return (r.intel.garrison || 0) * 2 + intelNodes(r, 'INF') * 2 + (r.intel.age > 3 ? 2 : 0);
    return 6;
  };
  const enemySats = (view.satellites || []).filter((s) => s.owner !== me);
  const satFootprint = (s) => new Set([s.region, ...(NB[s.region] || [])]);

  // Bots available to redeploy this turn.
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
  const threats = {};
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

  // War chest before the economy planners get a say — but the war does not
  // get to starve the treasury forever: while the finance network is behind
  // the curve for the territory held, the chest takes a smaller cut.
  const finBuilt = countNodes('FIN')
    + view.you.builds.filter((b) => b.kind === 'build_node' && b.type === 'FIN').length;
  const finTarget = Math.min(Math.max(8, mine.length - 2), 3 + Math.floor(view.turn / 4));
  const chestCap = ruthless ? 4 * c.swarm : 3 * c.swarm;
  // Only ease off against an opponent still going concern-sized: a small or
  // collapsing enemy gets finished with the full chest instead.
  const chestShare = finBuilt < finTarget && enemyRegions.length > 7 ? 0.35 : ruthless ? 0.55 : 0.45;
  const warChest = view.turn >= 4 ? Math.min(Math.floor(budget * chestShare), chestCap) : 0;
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
  // Finance scales with territory: a fifteen-region network parked at eight
  // hubs loses the long game to a nine-region one that compounds.
  let finNeed = finTarget - finBuilt;
  for (const spot of safest.slice(0, 2)) {
    if (finNeed <= 0 || !spend(c.node.FIN)) break;
    orders.push({ kind: 'build_node', region: spot.id, type: 'FIN' });
    finNeed -= 1;
  }
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
  // Frontier & chokepoints: garrison floors scale with how much of my
  // network sits behind a region.
  const frontier = mine
    .filter((r) => r.neighbors.some((n) => view.regions[n] && view.regions[n].owner !== me))
    .map((r) => ({ ...r, cut: cutValue(NB, myOwned, myCap, r.id) }))
    .sort((a, b) => (b.cut - a.cut) || (dist(a.id, enemyCap) - dist(b.id, enemyCap)));
  const slots = (r) => r.connected && !r.isolated && !r.reconnecting && (r.nodes || []).length < RULES.maxNodesPerRegion;
  if (view.turn >= 3) {
    const bare = frontier.find((r) => !nodesIn(r, 'INF') && slots(r));
    if (bare && spend(c.node.INF)) orders.push({ kind: 'build_node', region: bare.id, type: 'INF' });
  }
  if (countNodes('ANL') < 2 + Math.floor(view.turn / 12)) {
    const spot = frontier.find((r) => !nodesIn(r, 'ANL') && slots(r));
    if (spot && spend(c.node.ANL)) orders.push({ kind: 'build_node', region: spot.id, type: 'ANL' });
  }
  const opsCount = countNodes('OPS');
  const opsWanted = ruthless
    ? (view.turn >= 14 ? 4 : view.turn >= 8 ? 3 : view.turn >= 4 ? 2 : 1)
    : (view.turn >= 12 ? 3 : view.turn >= 5 ? 2 : 1);
  if (opsCount < opsWanted) {
    const together = mine.find((r) => nodesIn(r, 'OPS') && slots(r));
    const spot = together || safest.find(slots);
    if (spot && spend(c.node.OPS)) orders.push({ kind: 'build_node', region: spot.id, type: 'OPS' });
  }

  // ---- Phase 3: military --------------------------------------------------
  budget += warChest;
  const capR = view.regions[myCap];
  if ((capR.garrison || 0) < 4 && nodesIn(capR, 'INF') && spend(c.bot * 2)) {
    orders.push({ kind: 'train_bots', region: myCap, count: 2 });
  }
  for (const r of frontier.slice(0, 3)) {
    const floor = 2 + Math.min(2, ruthless ? r.cut : 0); // chokepoints get real garrisons
    if ((avail[r.id] || 0) < floor && nodesIn(r, 'INF') && !r.isolated && !r.reconnecting) {
      const want = Math.min(2, floor - (avail[r.id] || 0));
      if (spend(c.bot * want)) orders.push({ kind: 'train_bots', region: r.id, count: want });
    }
  }

  const mySwarms = view.units.filter((u) => u.owner === me && u.type === 'swarm');
  const buildingSwarms = view.you.builds.filter((b) => b.kind === 'swarm');
  const buildingWorms = view.you.builds.filter((b) => b.kind === 'worm');
  const buildingAsat = view.you.builds.filter((b) => b.kind === 'asat');
  let opsFree = opsCount - buildingSwarms.length - buildingWorms.length;
  const committedTo = (id) => mySwarms.filter((u) => u.target === id).reduce((s, u) => s + (u.strength || 0), 0)
    + buildingSwarms.filter((b) => b.target === id).length * RULES.combat.swarmStrength;

  // Target scoring: soft defenses, finance value, capital pressure, and —
  // the economy siege — how much of their network a capture disconnects.
  // Committed strength adds stickiness so the plan doesn't thrash.
  // Collapse-first doctrine: strangle income (finance regions, cut vertices
  // that starve whole clusters) and only storm the capital once their
  // economy is visibly broken or their network is small.
  const knownEnemyFin = enemyRegions.reduce((s, r) => s + (r.visible ? nodesIn(r, 'FIN') : intelNodes(r, 'FIN')), 0);
  const goForThroat = enemyRegions.length <= 8 || knownEnemyFin <= 1 || view.turn >= 24;
  const scored = enemyRegions.map((r) => ({
    id: r.id,
    score: (ruthless ? cutValue(NB, enemyOwned, enemyCap, r.id) * 10 : 0)
      + (r.visible ? nodesIn(r, 'FIN') : intelNodes(r, 'FIN')) * 6
      + (r.id === enemyCap ? (goForThroat ? 14 : -8) : 0)
      - enemyDefEstimate(r)
      - dist(myCap, r.id) * 0.5
      + committedTo(r.id) / 2,
  })).sort((a, b) => b.score - a.score);
  let target = scored[0]?.id || null;
  if (!ruthless) {
    // Standard keeps the simpler v2 habit: continue what's in flight.
    target = [mode(mySwarms.map((u) => u.target).filter((id) => enemyOwned.has(id))), buildingSwarms[0]?.target]
      .find((id) => id && enemyOwned.has(id)) || target;
  }

  // Plan correction: swarm builds aimed at anything other than the chosen
  // target refund half and free the den — this is also how feints resolve.
  if (ruthless) {
    for (const b of buildingSwarms) {
      if (b.target !== target && b.turnsLeft >= 1) {
        orders.push({ kind: 'cancel_build', build: b.id });
        opsFree += 1;
      }
    }
  }

  if (target && view.turn >= 3) {
    for (const u of mySwarms) {
      const t = view.regions[u.target];
      if ((u.eta ?? 0) === 0 && u.region !== target && (!t || t.owner === me)) {
        orders.push({ kind: 'retarget', unit: u.id, target });
      }
    }
    const capitalPush = target === enemyCap;
    const targetDef = Math.max(enemyDefEstimate(view.regions[target]), capitalPush ? 12 : 0);
    const committed = committedTo(target);
    // A telegraphed wave gets answered: assume the defender adds garrison
    // during the travel time, and size the wave for the fight it will
    // actually face — not the one visible today.
    const den0 = mine.find((r) => nodesIn(r, 'OPS'));
    const travel = den0 ? dist(den0.id, target) : 3;
    const anticipation = ruthless ? Math.min(capitalPush ? 18 : 12, travel * 3) : 0;
    const required = targetDef + 7 + anticipation;

    // The orbital swing: if their satellite watches the corridor, kill the
    // eye first and hold the wave until it's about to come down.
    const den = mine.find((r) => nodesIn(r, 'OPS'));
    const corridor = new Set(den ? [target, ...(pathOn(NB, den.id, target) || [])] : [target]);
    const watching = enemySats.find((s) => [...satFootprint(s)].some((id) => corridor.has(id)));
    const lncFree = countNodes('LNC') - view.you.builds.filter((b) => b.kind === 'satellite' || b.kind === 'asat').length;
    let holdWave = false;
    if (ruthless && watching && committed === 0) {
      if (!buildingAsat.length && lncFree > 0 && spend(c.asat)) {
        orders.push({ kind: 'build_asat', targetSat: watching.id });
        holdWave = true;
      } else if (buildingAsat.length && buildingAsat[0].turnsLeft > RULES.turns.swarm) {
        holdWave = true; // let the killer catch up so the wave flies blind-side
      }
    }

    if (!holdWave && committed < required && opsFree > 0) {
      const need = Math.ceil((required - committed) / RULES.combat.swarmStrength);
      const volley = Math.min(need, opsFree, Math.floor(budget / c.swarm));
      // Volley discipline: launch in bursts that arrive together, never a
      // trickle the defender can out-train. Small top-ups only to finish.
      const minVolley = ruthless && targetDef > 4 ? Math.min(3, opsCount, need) : 1;
      if (volley >= minVolley) {
        for (let i = 0; i < volley; i++) {
          if (!spend(c.swarm)) break;
          orders.push({ kind: 'build_swarm', target });
          opsFree -= 1;
        }
      }
    }

    // Retreat: a wave that can no longer be funded to sufficiency stops
    // feeding the wall and takes the softest thing it can reach instead.
    if (committed > 0 && committed < required / 2 && opsFree === 0 && budget < c.swarm) {
      const soft = [...enemyRegions].sort((a, b) => enemyDefEstimate(a) - enemyDefEstimate(b))[0];
      if (soft && soft.id !== target) {
        for (const u of mySwarms.filter((x) => x.target === target)) {
          orders.push({ kind: 'retarget', unit: u.id, target: soft.id });
        }
      }
    }

    // The feint: opening an assault, spook a region the defender is watching
    // with their own satellite — the anomaly lands, the build cancels next
    // turn via plan correction, net cost is half a swarm.
    if (ruthless && committed === 0 && buildingSwarms.length === 0 && opsFree > 0 && budget > c.swarm * 2) {
      const decoy = enemyRegions.find((r) => r.id !== target
        && enemySats.some((s) => satFootprint(s).has(r.id)));
      if (decoy && spend(c.swarm)) {
        orders.push({ kind: 'build_swarm', target: decoy.id });
        opsFree -= 1;
      }
    }

    // The second front: with dens to spare, open a distant secondary threat
    // so the defense has to split.
    if (ruthless && goForThroat && opsFree > 0 && budget > 260) {
      const secondary = scored.find((s) => s.id !== target && dist(s.id, target) >= 3);
      if (secondary && spend(c.swarm)) {
        orders.push({ kind: 'build_swarm', target: secondary.id });
        opsFree -= 1;
      }
    }
  }

  // One stealth worm in play: aim at known finance (else the capital) and
  // route around the defender's public satellite coverage.
  const wormsAlive = view.units.filter((u) => u.owner === me && u.type === 'worm').length + buildingWorms.length;
  const wormCap = ruthless && (goForThroat || budget > 300) ? 2 : 1;
  if (wormsAlive < wormCap && view.turn >= 6 && opsFree > 0) {
    const pushingCapital = target === enemyCap && committedTo(enemyCap) > 0;
    // Deep finance first: frontier analysts watch the border, so the safest
    // worm lanes end far behind it.
    const finSpots = enemyRegions
      .filter((r) => (r.visible && nodesIn(r, 'FIN')) || intelNodes(r, 'FIN'))
      .sort((a, b) => dist(b.id, myCap) - dist(a.id, myCap));
    // During a capital push, the worm joins the kill instead of farming.
    const wTarget = pushingCapital ? enemyCap : (finSpots[0]?.id || enemyCap);
    if (spend(c.worm)) {
      const o = { kind: 'build_worm', target: wTarget, targetNode: wTarget === enemyCap ? 'CAP' : 'FIN' };
      const den = mine.find((r) => nodesIn(r, 'OPS'));
      if (enemySats.length && den) {
        const hot = new Set();
        for (const s of enemySats) for (const id of satFootprint(s)) hot.add(id);
        const route = pathOn(NB, den.id, wTarget, (id) => id !== wTarget && (hot.has(id) || view.regions[id]?.isolated));
        if (route) {
          o.facility = den.id;
          o.route = route;
        }
      }
      orders.push(o);
    }
  }

  // Orbit: recon over the assault target; shoot down satellites over my land.
  const lncBusy = view.you.builds.filter((b) => b.kind === 'satellite' || b.kind === 'asat').length;
  if (countNodes('LNC') - lncBusy > 0) {
    const nuisance = enemySats.find((s) => [...satFootprint(s)].some((id) => view.regions[id]?.owner === me));
    if (view.you.satellites.length === 0 && budget > 220 && spend(c.satellite)) {
      orders.push({ kind: 'build_satellite', target: target || enemyCap });
    } else if (nuisance && budget > 260 && spend(c.asat)) {
      orders.push({ kind: 'build_asat', targetSat: nuisance.id });
    }
  }

  return orders;
}
