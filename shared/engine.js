// SIGNAL DOMINION — deterministic game engine.
//
// The whole game is a pure function: resolveTurn(state, {A: orders, B: orders})
// returns the next state plus per-player logs. No randomness, no clocks — the
// same state and orders always produce the same result, so the server, tests
// and any future replay system all share this file.
//
// Resolution order within a turn (documented, always identical):
//   1. isolation toggles and reconnection countdowns
//   2. unit movement (one link per turn)
//   3. combat and interception at contested regions
//   4. malware sweeps, then worm payloads
//   5. build queues tick forward (new builds, claims, launches complete)
//   6. economy: connectivity, starvation, income and upkeep, win checks
//   7. detection and vision update (intel snapshots, staleness, alerts)

import { REGIONS, NEIGHBORS, START, adjacent, shortestPath } from './map.js';
import { RULES, WORM_TARGET_PRIORITY } from './constants.js';

const SIDES = ['A', 'B'];
export const enemyOf = (side) => (side === 'A' ? 'B' : 'A');

const clone = (v) => structuredClone(v);

// ---------------------------------------------------------------------------
// State construction
// ---------------------------------------------------------------------------

export function createMatch(names = { A: 'Player A', B: 'Player B' }) {
  const state = {
    turn: 1,
    nextId: 1,
    regions: {},
    units: [],
    players: {},
    winner: null,
    winReason: null,
  };

  for (const r of REGIONS) {
    state.regions[r.id] = {
      id: r.id,
      owner: null,
      nodes: [],
      isolated: false,
      reconnecting: 0,
      starved: 0,
    };
  }

  for (const side of SIDES) {
    state.players[side] = {
      side,
      name: names[side] || `Player ${side}`,
      capital: START[side].capital,
      funding: RULES.startingFunding,
      income: 0,
      negStreak: 0,
      satellites: [],
      builds: [],
      intel: {},
      alerts: [],
      sight: [],
      detect: [],
    };
  }

  for (const [ra, rb, nodes, garrison] of START.cluster) {
    for (const [side, id] of [['A', ra], ['B', rb]]) {
      const region = state.regions[id];
      region.owner = side;
      region.nodes = nodes.map((type) => ({
        type,
        hp: type === 'CAP' ? RULES.combat.capitalHp : RULES.combat.nodeHp,
      }));
      for (let i = 0; i < garrison; i++) {
        state.units.push({ id: state.nextId++, owner: side, type: 'bot', region: id });
      }
    }
  }

  for (const side of SIDES) {
    const v = computeVision(state, side);
    state.players[side].sight = [...v.sight];
    state.players[side].detect = [...v.detect];
  }
  refreshIntel(state);
  refreshAlerts(state);
  return state;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function nodesOf(region, type) {
  return region.nodes.filter((n) => n.type === type && n.hp > 0);
}

export function unitsIn(state, regionId, fn = () => true) {
  return state.units.filter((u) => u.region === regionId && fn(u));
}

export function botsIn(state, regionId, side) {
  return unitsIn(state, regionId, (u) => u.type === 'bot' && u.owner === side);
}

export function capitalNode(state, side) {
  const region = state.regions[state.players[side].capital];
  return region.nodes.find((n) => n.type === 'CAP') || null;
}

// Regions receiving support: reachable from the capital through owned regions
// that are neither isolated nor reconnecting.
export function connectedSet(state, side) {
  const capId = state.players[side].capital;
  const cap = state.regions[capId];
  const set = new Set();
  if (cap.owner !== side || cap.isolated || cap.reconnecting > 0) return set;
  const queue = [capId];
  set.add(capId);
  while (queue.length) {
    for (const next of NEIGHBORS[queue.shift()]) {
      const r = state.regions[next];
      if (set.has(next) || r.owner !== side || r.isolated || r.reconnecting > 0) continue;
      set.add(next);
      queue.push(next);
    }
  }
  return set;
}

// sight: regions whose full contents you can see (except stealth worms).
// detect: regions where stealthy worms are revealed (analysts + satellites).
export function computeVision(state, side) {
  const sight = new Set();
  const detect = new Set();
  const cover = (id) => {
    sight.add(id);
    detect.add(id);
    for (const n of NEIGHBORS[id]) {
      sight.add(n);
      detect.add(n);
    }
  };
  for (const r of REGIONS) {
    const region = state.regions[r.id];
    if (region.owner === side) {
      sight.add(r.id);
      if (nodesOf(region, 'ANL').length) cover(r.id);
    }
  }
  for (const u of state.units) {
    if (u.owner === side) sight.add(u.region);
  }
  for (const sat of state.players[side].satellites) cover(sat.region);
  return { sight, detect };
}

function analystNearby(state, side, regionId) {
  const ids = [regionId, ...NEIGHBORS[regionId]];
  return ids.some((id) => {
    const r = state.regions[id];
    return r.owner === side && nodesOf(r, 'ANL').length > 0;
  });
}

function entryBlocked(state, unitOwner, regionId) {
  const r = state.regions[regionId];
  if (r.isolated) return true; // hard quarantine: nothing gets in
  if (r.reconnecting > 0 && r.owner === unitOwner) return true; // no support yet
  return false;
}

function facilityLoad(state, side, kind) {
  // How many in-progress builds occupy each facility region.
  const wantsOps = kind === 'OPS';
  const load = {};
  for (const b of state.players[side].builds) {
    const usesOps = b.kind === 'swarm' || b.kind === 'worm';
    const usesLnc = b.kind === 'satellite' || b.kind === 'asat';
    if ((wantsOps && usesOps) || (!wantsOps && usesLnc)) {
      load[b.facility] = (load[b.facility] || 0) + 1;
    }
  }
  return load;
}

function pickFacility(state, side, nodeType, nearTarget, extraLoad) {
  // Idle facility of the given type, closest to the target (stable tie-break).
  const load = facilityLoad(state, side, nodeType);
  let best = null;
  let bestDist = Infinity;
  for (const r of REGIONS) {
    const region = state.regions[r.id];
    if (region.owner !== side) continue;
    const capacity = nodesOf(region, nodeType).length;
    if (capacity === 0) continue;
    const used = (load[r.id] || 0) + (extraLoad[r.id] || 0);
    if (used >= capacity) continue;
    const dist = nearTarget ? (shortestPath(r.id, nearTarget) || []).length : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = r.id;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Order validation
// ---------------------------------------------------------------------------
// Returns { accepted, rejected } where accepted orders are normalized copies
// (facility assignment and final cost attached). The server calls this when a
// player locks in; the resolver assumes orders passed through here.

export function validateOrders(state, side, orders) {
  const accepted = [];
  const rejected = [];
  const player = state.players[side];
  let budget = player.funding;
  const extraOps = {};
  const extraLnc = {};
  const movesFrom = {};
  const claimed = new Set();
  const reject = (order, reason) => rejected.push({ order, reason });

  for (const raw of Array.isArray(orders) ? orders : []) {
    const o = clone(raw);
    const region = o.region ? state.regions[o.region] : null;
    const costOf = (c) => {
      if (c > budget) return false;
      budget -= c;
      o.cost = c;
      return true;
    };

    switch (o.kind) {
      case 'isolate': {
        if (!region || region.owner !== side) { reject(o, 'not your region'); continue; }
        if (region.isolated) { reject(o, 'already cut off'); continue; }
        if (unitsIn(state, o.region, (u) => u.owner !== side).length) {
          reject(o, 'enemy units are inside — clear them first'); continue;
        }
        o.cost = 0;
        break;
      }
      case 'reconnect': {
        if (!region || region.owner !== side) { reject(o, 'not your region'); continue; }
        if (!region.isolated) { reject(o, 'not cut off'); continue; }
        o.cost = 0;
        break;
      }
      case 'move_bots': {
        const from = state.regions[o.from];
        const to = state.regions[o.to];
        if (!from || !to || from.owner !== side || to.owner !== side) { reject(o, 'both regions must be yours'); continue; }
        if (!adjacent(o.from, o.to)) { reject(o, 'regions are not linked'); continue; }
        if (from.isolated) { reject(o, 'nothing gets out of a cut-off region'); continue; }
        if (to.isolated || to.reconnecting > 0) { reject(o, 'that region cannot receive units yet'); continue; }
        const avail = botsIn(state, o.from, side).length - (movesFrom[o.from] || 0);
        o.count = Math.max(1, Math.min(o.count || 1, avail));
        if (avail < 1) { reject(o, 'no defenders available there'); continue; }
        movesFrom[o.from] = (movesFrom[o.from] || 0) + o.count;
        o.cost = 0;
        break;
      }
      case 'claim': {
        if (!region || region.owner !== null) { reject(o, 'region is not unclaimed'); continue; }
        if (claimed.has(o.region) || player.builds.some((b) => b.kind === 'claim' && b.region === o.region)) {
          reject(o, 'already being claimed'); continue;
        }
        const conn = connectedSet(state, side);
        const border = NEIGHBORS[o.region].some((n) => conn.has(n));
        if (!border) { reject(o, 'must border your connected network'); continue; }
        if (!costOf(RULES.costs.claim)) { reject(o, 'not enough funding'); continue; }
        claimed.add(o.region);
        break;
      }
      case 'build_node': {
        if (!region || region.owner !== side) { reject(o, 'not your region'); continue; }
        if (!RULES.costs.node[o.type]) { reject(o, 'unknown structure'); continue; }
        if (region.isolated || region.reconnecting > 0) { reject(o, 'region is cut off'); continue; }
        const queued = player.builds.filter((b) => b.kind === 'node' && b.region === o.region).length;
        if (region.nodes.length + queued >= RULES.maxNodesPerRegion) { reject(o, 'region is full'); continue; }
        if (unitsIn(state, o.region, (u) => u.owner !== side).length) { reject(o, 'region is contested'); continue; }
        if (!costOf(RULES.costs.node[o.type])) { reject(o, 'not enough funding'); continue; }
        break;
      }
      case 'train_bots': {
        if (!region || region.owner !== side) { reject(o, 'not your region'); continue; }
        if (!nodesOf(region, 'INF').length) { reject(o, 'needs a defender garrison here'); continue; }
        if (region.isolated || region.reconnecting > 0) { reject(o, 'region is cut off'); continue; }
        o.count = Math.max(1, Math.min(o.count || 1, 5));
        if (!costOf(RULES.costs.bot * o.count)) { reject(o, 'not enough funding'); continue; }
        break;
      }
      case 'sweep': {
        if (!region || region.owner !== side) { reject(o, 'you can only sweep your own regions'); continue; }
        const cost = analystNearby(state, side, o.region) ? RULES.costs.sweep : RULES.costs.sweepFar;
        if (!costOf(cost)) { reject(o, 'not enough funding'); continue; }
        break;
      }
      case 'build_swarm':
      case 'build_worm': {
        const target = state.regions[o.target];
        if (!target) { reject(o, 'pick a target region'); continue; }
        if (target.owner === side) { reject(o, 'that region is already yours'); continue; }
        const facility = pickFacility(state, side, 'OPS', o.target, extraOps);
        if (!facility) { reject(o, 'every cyber ops centre is busy (or you have none)'); continue; }
        if (o.route) {
          let prev = facility;
          const ok = Array.isArray(o.route) && o.route.length &&
            o.route.every((id) => { const a = adjacent(prev, id); prev = id; return a && state.regions[id]; }) &&
            o.route[o.route.length - 1] === o.target;
          if (!ok) { reject(o, 'route is not a linked path to the target'); continue; }
        }
        const cost = o.kind === 'build_swarm' ? RULES.costs.swarm : RULES.costs.worm;
        if (!costOf(cost)) { reject(o, 'not enough funding'); continue; }
        o.facility = facility;
        extraOps[facility] = (extraOps[facility] || 0) + 1;
        break;
      }
      case 'build_satellite': {
        if (!o.target || !state.regions[o.target]) { reject(o, 'pick a region to watch'); continue; }
        const facility = pickFacility(state, side, 'LNC', null, extraLnc);
        if (!facility) { reject(o, 'every launch facility is busy (or you have none)'); continue; }
        if (!costOf(RULES.costs.satellite)) { reject(o, 'not enough funding'); continue; }
        o.facility = facility;
        extraLnc[facility] = (extraLnc[facility] || 0) + 1;
        break;
      }
      case 'build_asat': {
        const sat = state.players[enemyOf(side)].satellites.find((s) => s.id === o.targetSat);
        if (!sat) { reject(o, 'that satellite is not up there'); continue; }
        const facility = pickFacility(state, side, 'LNC', null, extraLnc);
        if (!facility) { reject(o, 'every launch facility is busy (or you have none)'); continue; }
        if (!costOf(RULES.costs.asat)) { reject(o, 'not enough funding'); continue; }
        o.facility = facility;
        extraLnc[facility] = (extraLnc[facility] || 0) + 1;
        break;
      }
      case 'move_satellite': {
        const sat = player.satellites.find((s) => s.id === o.sat);
        if (!sat) { reject(o, 'no such satellite'); continue; }
        if (!o.target || !state.regions[o.target]) { reject(o, 'pick a region to watch'); continue; }
        if (player.builds.some((b) => b.kind === 'moveSat' && b.satId === o.sat)) {
          reject(o, 'already repositioning'); continue;
        }
        if (!costOf(RULES.costs.moveSat)) { reject(o, 'not enough funding'); continue; }
        break;
      }
      case 'cancel_build': {
        const build = player.builds.find((b) => b.id === o.build);
        if (!build) { reject(o, 'no such build'); continue; }
        o.cost = 0;
        break;
      }
      default:
        reject(o, 'unknown order');
        continue;
    }
    accepted.push(o);
  }
  return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// Turn resolution
// ---------------------------------------------------------------------------

export function resolveTurn(prevState, orders) {
  const state = clone(prevState);
  const logs = { A: [], B: [] };
  const log = (who, step, title, detail, color) => {
    const entry = { step, title, detail, color };
    if (who === 'both') { logs.A.push(entry); logs.B.push(clone(entry)); }
    else logs[who].push(entry);
  };
  const bySide = { A: orders.A || [], B: orders.B || [] };
  const name = (side) => state.players[side].name;
  const regionName = (id) => REGIONS.find((r) => r.id === id)?.name || id;

  // -- Step 0: pay for orders and enqueue builds ---------------------------
  const sweeps = [];
  const isolations = [];
  const reconnections = [];
  const botMoves = [];
  for (const side of SIDES) {
    const player = state.players[side];
    for (const o of bySide[side]) {
      if (o.cost) player.funding = Math.max(0, player.funding - o.cost);
      switch (o.kind) {
        case 'isolate': isolations.push([side, o]); break;
        case 'reconnect': reconnections.push([side, o]); break;
        case 'move_bots': botMoves.push([side, o]); break;
        case 'sweep': sweeps.push([side, o]); break;
        case 'claim':
          player.builds.push({ id: state.nextId++, kind: 'claim', region: o.region, cost: o.cost, turnsLeft: RULES.turns.claim, totalTurns: RULES.turns.claim });
          break;
        case 'build_node':
          player.builds.push({ id: state.nextId++, kind: 'node', type: o.type, region: o.region, cost: o.cost, turnsLeft: RULES.turns.node[o.type], totalTurns: RULES.turns.node[o.type] });
          break;
        case 'train_bots':
          player.builds.push({ id: state.nextId++, kind: 'bots', count: o.count, region: o.region, cost: o.cost, turnsLeft: RULES.turns.bot, totalTurns: RULES.turns.bot });
          break;
        case 'build_swarm':
          player.builds.push({ id: state.nextId++, kind: 'swarm', facility: o.facility, region: o.facility, target: o.target, route: o.route || null, cost: o.cost, turnsLeft: RULES.turns.swarm, totalTurns: RULES.turns.swarm });
          break;
        case 'build_worm':
          player.builds.push({ id: state.nextId++, kind: 'worm', facility: o.facility, region: o.facility, target: o.target, targetNode: o.targetNode || null, route: o.route || null, cost: o.cost, turnsLeft: RULES.turns.worm, totalTurns: RULES.turns.worm });
          break;
        case 'build_satellite':
          player.builds.push({ id: state.nextId++, kind: 'satellite', facility: o.facility, region: o.facility, target: o.target, cost: o.cost, turnsLeft: RULES.turns.satellite, totalTurns: RULES.turns.satellite });
          log('both', 5, `${name(side)} started a satellite launch`, `Building at ${regionName(o.facility)} — big launches are impossible to hide. ${RULES.turns.satellite} turns to orbit.`, '#c48a1e');
          break;
        case 'build_asat':
          player.builds.push({ id: state.nextId++, kind: 'asat', facility: o.facility, region: o.facility, targetSat: o.targetSat, cost: o.cost, turnsLeft: RULES.turns.asat, totalTurns: RULES.turns.asat });
          break;
        case 'move_satellite':
          player.builds.push({ id: state.nextId++, kind: 'moveSat', satId: o.sat, target: o.target, cost: o.cost, turnsLeft: RULES.turns.moveSat, totalTurns: RULES.turns.moveSat });
          break;
        case 'cancel_build': {
          const i = player.builds.findIndex((b) => b.id === o.build);
          if (i >= 0) {
            const [b] = player.builds.splice(i, 1);
            const refund = Math.floor((b.cost || 0) * RULES.refundRate);
            player.funding += refund;
            log(side, 5, `Cancelled: ${describeBuild(b)}`, `You got §${refund} back.`, '#8d99ab');
          }
          break;
        }
      }
    }
  }

  // -- Step 1: isolation ----------------------------------------------------
  for (const r of REGIONS) {
    const region = state.regions[r.id];
    if (region.reconnecting > 0) {
      region.reconnecting -= 1;
      if (region.owner) {
        if (region.reconnecting === 0) {
          log(region.owner, 1, `${r.name} is back on your network`, 'Funding, reinforcements and new builds flow again.', '#e8b53f');
        } else {
          log(region.owner, 1, `${r.name} is still reconnecting`, `${region.reconnecting} more turn${region.reconnecting === 1 ? '' : 's'} — vulnerable and unsupported until then.`, '#e8b53f');
        }
      }
    }
  }
  for (const [side, o] of isolations) {
    const region = state.regions[o.region];
    if (region.owner !== side || region.isolated) continue;
    if (unitsIn(state, o.region, (u) => u.owner !== side).length) {
      log(side, 1, `Could not cut off ${regionName(o.region)}`, 'Enemy units are already inside.', '#e8b53f');
      continue;
    }
    region.isolated = true;
    region.reconnecting = 0;
    log(side, 1, `${regionName(o.region)} is cut off`, 'Nothing gets in or out. Reconnecting later will take 2 turns.', '#e8b53f');
  }
  for (const [side, o] of reconnections) {
    const region = state.regions[o.region];
    if (region.owner !== side || !region.isolated) continue;
    region.isolated = false;
    region.reconnecting = RULES.reconnectTurns;
    log(side, 1, `${regionName(o.region)} is reconnecting`, `Takes ${RULES.reconnectTurns} turns. Until then it is vulnerable but receives no support.`, '#e8b53f');
  }

  // -- Step 2: movement -----------------------------------------------------
  for (const [side, o] of botMoves) {
    const from = state.regions[o.from];
    const to = state.regions[o.to];
    if (!from || !to || from.owner !== side || to.owner !== side || !adjacent(o.from, o.to)) continue;
    if (from.isolated || entryBlocked(state, side, o.to)) {
      log(side, 2, `Defenders held at ${regionName(o.from)}`, `${regionName(o.to)} cannot be entered right now.`, '#4a7fe0');
      continue;
    }
    const bots = botsIn(state, o.from, side).slice(0, o.count);
    for (const b of bots) b.region = o.to;
    if (bots.length) {
      log(side, 2, `${bots.length} defender${bots.length === 1 ? '' : 's'} moved to ${regionName(o.to)}`, `From ${regionName(o.from)}.`, '#4a7fe0');
    }
  }
  for (const u of state.units) {
    if (!u.path || !u.path.length) continue;
    const next = u.path[0];
    if (entryBlocked(state, u.owner, next)) {
      log(u.owner, 2, `Your ${u.type} is held near ${regionName(next)}`, 'The way in is cut off. It will resume when the region reopens.', '#4a7fe0');
      continue;
    }
    u.region = next;
    u.path.shift();
  }

  // Worm detection on entry (before interception and payloads, so a worm seen
  // arriving can still be caught).
  const detectSets = {};
  for (const side of SIDES) detectSets[side] = computeVision(state, side).detect;
  for (const u of state.units) {
    if (u.type !== 'worm') continue;
    const enemy = enemyOf(u.owner);
    if (!u.detectedBy?.[enemy] && detectSets[enemy].has(u.region)) {
      u.detectedBy = { ...u.detectedBy, [enemy]: true };
      log(enemy, 2, `Worm detected at ${regionName(u.region)}`, 'Your coverage picked up a stealth worm. Defenders can now intercept it.', '#8f5fc7');
      log(u.owner, 2, `Your worm was spotted at ${regionName(u.region)}`, 'It is no longer hidden from them.', '#8f5fc7');
    }
  }

  // -- Step 3: combat -------------------------------------------------------
  const removeUnits = (ids) => { state.units = state.units.filter((u) => !ids.has(u.id)); };
  for (const r of REGIONS) {
    const region = state.regions[r.id];
    const here = unitsIn(state, r.id);
    const swarmsOf = (side) => here.filter((u) => u.type === 'swarm' && u.owner === side);

    if (region.owner) {
      const defSide = region.owner;
      const atkSide = enemyOf(defSide);
      const attackers = swarmsOf(atkSide);
      if (!attackers.length) continue;
      const defBots = here.filter((u) => u.type === 'bot' && u.owner === defSide);
      const defSwarms = swarmsOf(defSide);
      const infBonus = defBots.length ? nodesOf(region, 'INF').length * RULES.combat.infBonus : 0;
      const defPower = defBots.length * RULES.combat.botPower + infBonus + defSwarms.reduce((s, u) => s + u.strength, 0);
      const atkPower = attackers.reduce((s, u) => s + u.strength, 0);
      if (defPower > 0) {
        const dead = new Set();
        let dmgToAtk = defPower;
        for (const u of attackers) {
          const hit = Math.min(u.strength, dmgToAtk);
          u.strength -= hit;
          dmgToAtk -= hit;
          if (u.strength <= 0) dead.add(u.id);
        }
        let dmgToDef = atkPower;
        const botsLost = Math.min(defBots.length, Math.floor(dmgToDef / RULES.combat.botPower));
        for (let i = 0; i < botsLost; i++) dead.add(defBots[i].id);
        dmgToDef -= botsLost * RULES.combat.botPower;
        if (botsLost >= defBots.length) {
          for (const u of defSwarms) {
            const hit = Math.min(u.strength, dmgToDef);
            u.strength -= hit;
            dmgToDef -= hit;
            if (u.strength <= 0) dead.add(u.id);
          }
        }
        removeUnits(dead);
        const atkLeft = unitsIn(state, r.id, (u) => u.type === 'swarm' && u.owner === atkSide)
          .reduce((s, u) => s + u.strength, 0);
        log(defSide, 3, `Fighting at ${r.name}`, `You lost ${botsLost} defender${botsLost === 1 ? '' : 's'}. ${atkLeft > 0 ? 'Enemy swarms are still there.' : 'The attack was wiped out.'}`, '#d8624f');
        log(atkSide, 3, `Fighting at ${r.name}`, atkLeft > 0 ? `Your swarms broke through — strength ${atkLeft} remains.` : 'Your swarms were wiped out by the garrison.', '#d8624f');
      }
    } else {
      // Neutral ground: opposing swarms grind each other down.
      const a = swarmsOf('A');
      const b = swarmsOf('B');
      if (!a.length || !b.length) continue;
      const powerA = a.reduce((s, u) => s + u.strength, 0);
      const powerB = b.reduce((s, u) => s + u.strength, 0);
      const dead = new Set();
      let dmg = powerB;
      for (const u of a) { const hit = Math.min(u.strength, dmg); u.strength -= hit; dmg -= hit; if (u.strength <= 0) dead.add(u.id); }
      dmg = powerA;
      for (const u of b) { const hit = Math.min(u.strength, dmg); u.strength -= hit; dmg -= hit; if (u.strength <= 0) dead.add(u.id); }
      removeUnits(dead);
      log('both', 3, `Swarms clashed at ${r.name}`, 'Both sides took losses on neutral ground.', '#d8624f');
    }
  }

  // Capture / siege: attacking swarms standing at their target with no
  // defenders left. Capitals are besieged (Command centre takes damage);
  // other regions flip and their structures are smashed.
  for (const r of REGIONS) {
    const region = state.regions[r.id];
    if (!region.owner) continue;
    const defSide = region.owner;
    const atkSide = enemyOf(defSide);
    const attackers = unitsIn(state, r.id, (u) => u.type === 'swarm' && u.owner === atkSide && (!u.path || !u.path.length) && u.target === r.id);
    if (!attackers.length) continue;
    const defended = unitsIn(state, r.id, (u) => u.owner === defSide && (u.type === 'bot' || u.type === 'swarm')).length > 0;
    if (defended) continue;
    const cap = region.nodes.find((n) => n.type === 'CAP' && n.hp > 0);
    if (cap) {
      const dmg = attackers.reduce((s, u) => s + u.strength, 0);
      cap.hp -= dmg;
      log(defSide, 3, `Your capital is under siege at ${r.name}`, `Command centre took ${dmg} damage — ${Math.max(0, cap.hp)} remaining.`, '#d8624f');
      log(atkSide, 3, `Sieging their capital at ${r.name}`, `Dealt ${dmg} damage — ${Math.max(0, cap.hp)} remaining.`, '#d8624f');
    } else {
      region.owner = atkSide;
      region.isolated = false;
      region.reconnecting = 0;
      region.starved = 0;
      const smashed = region.nodes.length;
      region.nodes = [];
      const defP = state.players[defSide];
      defP.builds = defP.builds.filter((b) => b.region !== r.id && b.facility !== r.id);
      log(atkSide, 3, `You took ${r.name}`, smashed ? `Their structures there were destroyed (${smashed}).` : 'The region is yours.', '#d8624f');
      log(defSide, 3, `You lost ${r.name}`, smashed ? `Everything built there was destroyed (${smashed}).` : 'Enemy swarms overran it.', '#d8624f');
    }
  }

  // Interception: detected worms in a garrisoned enemy region are neutralized.
  {
    const dead = new Set();
    for (const u of state.units) {
      if (u.type !== 'worm' || dead.has(u.id)) continue;
      const region = state.regions[u.region];
      const defSide = region.owner;
      if (!defSide || defSide === u.owner) continue;
      if (u.detectedBy?.[defSide] && botsIn(state, u.region, defSide).length > 0) {
        dead.add(u.id);
        log(defSide, 3, `A worm was stopped at ${regionName(u.region)}`, 'Your defenders neutralized it before it could do anything.', '#8f5fc7');
        log(u.owner, 3, `Your worm was destroyed at ${regionName(u.region)}`, 'It was detected and their defenders were waiting.', '#8f5fc7');
      }
    }
    removeUnits(dead);
  }

  // -- Step 4: sweeps, then worm payloads ----------------------------------
  for (const [side, o] of sweeps) {
    const found = unitsIn(state, o.region, (u) => u.type === 'worm' && u.owner !== side);
    removeUnits(new Set(found.map((u) => u.id)));
    log(side, 4, `Swept ${regionName(o.region)} for malware`, found.length ? `Found and destroyed ${found.length} worm${found.length === 1 ? '' : 's'}.` : 'Found nothing hiding there.', '#8f5fc7');
    for (const w of found) {
      log(w.owner, 4, `Your worm was destroyed at ${regionName(o.region)}`, 'A malware sweep cleaned it out.', '#8f5fc7');
    }
  }
  {
    const dead = new Set();
    for (const u of state.units) {
      if (u.type !== 'worm' || dead.has(u.id)) continue;
      if ((u.path && u.path.length) || u.region !== u.target) continue;
      const region = state.regions[u.region];
      if (region.owner !== enemyOf(u.owner)) continue; // nothing to attack (yet)
      const defSide = region.owner;
      const alive = region.nodes.filter((n) => n.hp > 0);
      let targetNode = u.targetNode ? alive.find((n) => n.type === u.targetNode) : null;
      if (!targetNode) {
        for (const t of WORM_TARGET_PRIORITY) {
          targetNode = alive.find((n) => n.type === t);
          if (targetNode) break;
        }
      }
      dead.add(u.id);
      if (!targetNode) {
        log(u.owner, 4, `Your worm found nothing at ${regionName(u.region)}`, 'No structures left to hit. It burned itself out.', '#8f5fc7');
        continue;
      }
      if (targetNode.type === 'CAP') {
        targetNode.hp -= RULES.combat.wormCapitalDamage;
        log(defSide, 4, `A worm hit your capital at ${regionName(u.region)}`, `Command centre took ${RULES.combat.wormCapitalDamage} damage — ${Math.max(0, targetNode.hp)} remaining.`, '#8f5fc7');
        log(u.owner, 4, `Your worm hit their capital`, `Dealt ${RULES.combat.wormCapitalDamage} damage at ${regionName(u.region)}.`, '#8f5fc7');
      } else {
        targetNode.hp = 0;
        region.nodes = region.nodes.filter((n) => n.hp > 0);
        const label = targetNode.type;
        log(defSide, 4, `A worm destroyed your ${label} at ${regionName(u.region)}`, 'It slipped through undetected.', '#8f5fc7');
        log(u.owner, 4, `Your worm resolved its payload`, `Destroyed their ${label} at ${regionName(u.region)}.`, '#8f5fc7');
      }
    }
    removeUnits(dead);
  }

  // -- Step 5: builds tick --------------------------------------------------
  for (const side of SIDES) {
    const player = state.players[side];
    const remaining = [];
    for (const b of player.builds) {
      b.turnsLeft -= 1;
      if (b.turnsLeft > 0) { remaining.push(b); continue; }
      completeBuild(state, side, b, log, regionName, name);
    }
    player.builds = remaining;
  }

  // -- Step 6: economy ------------------------------------------------------
  for (const side of SIDES) {
    const player = state.players[side];
    const conn = connectedSet(state, side);
    let starvedNote = 0;
    for (const r of REGIONS) {
      const region = state.regions[r.id];
      if (region.owner !== side) continue;
      const supported = conn.has(r.id);
      region.starved = supported ? 0 : region.starved + 1;
      if (region.starved > RULES.starveGrace) {
        starvedNote++;
        for (const n of region.nodes) {
          if (n.type === 'CAP') continue; // capitals starve the player, not themselves
          n.hp -= RULES.starveNodeDamage;
        }
        const before = region.nodes.length;
        region.nodes = region.nodes.filter((n) => n.hp > 0);
        const lost = before - region.nodes.length;
        const bot = botsIn(state, r.id, side)[0];
        if (bot) state.units = state.units.filter((u) => u.id !== bot.id);
        if (lost || bot) {
          log(side, 6, `${r.name} is degrading`, `Cut off from funding${lost ? ` — ${lost} structure${lost === 1 ? '' : 's'} failed` : ''}${bot ? ' — a defender went dark' : ''}.`, '#e8b53f');
        }
      }
    }
    let income = 0;
    if (conn.has(player.capital) && capitalNode(state, side)) income += RULES.income.capital;
    for (const id of conn) {
      income += nodesOf(state.regions[id], 'FIN').length * RULES.income.finance;
    }
    let upkeep = player.satellites.length * RULES.upkeep.satellite;
    for (const id of conn) {
      upkeep += state.regions[id].nodes.filter((n) => n.type !== 'CAP').length * RULES.upkeep.node;
    }
    for (const u of state.units) {
      if (u.owner !== side) continue;
      if (u.type === 'bot') {
        if (conn.has(u.region)) upkeep += RULES.upkeep.bot;
      } else {
        upkeep += RULES.upkeep[u.type];
      }
    }
    const net = income - upkeep;
    player.income = net;
    player.funding = Math.max(0, player.funding + net);
    player.negStreak = net < 0 ? player.negStreak + 1 : 0;
    log(side, 6, `Income ${net >= 0 ? '+' : ''}${net}`, `§${income} came in, upkeep took §${upkeep}.${starvedNote ? ` ${starvedNote} region${starvedNote === 1 ? '' : 's'} contributed nothing while cut off.` : ''}${net < 0 ? ` Running negative for ${player.negStreak} turn${player.negStreak === 1 ? '' : 's'} — collapse at ${RULES.collapseTurns}.` : ''}`, '#3f9c78');
  }

  // Win checks.
  if (!state.winner) {
    const capDead = {};
    for (const side of SIDES) {
      const cap = capitalNode(state, side);
      capDead[side] = !cap || cap.hp <= 0;
    }
    if (capDead.A && capDead.B) { state.winner = 'draw'; state.winReason = 'Both capitals fell in the same turn.'; }
    else if (capDead.A) { state.winner = 'B'; state.winReason = `${name('A')}'s capital was compromised.`; }
    else if (capDead.B) { state.winner = 'A'; state.winReason = `${name('B')}'s capital was compromised.`; }
    else {
      const collapsed = SIDES.filter((s) => state.players[s].negStreak >= RULES.collapseTurns);
      if (collapsed.length === 2) { state.winner = 'draw'; state.winReason = 'Both economies collapsed.'; }
      else if (collapsed.length === 1) {
        state.winner = enemyOf(collapsed[0]);
        state.winReason = `${name(collapsed[0])}'s network was starved into collapse.`;
      }
    }
    if (state.winner) {
      log('both', 6, state.winner === 'draw' ? 'The match is a draw' : `${name(state.winner)} wins`, state.winReason, '#e8b53f');
    }
  }

  // -- Step 7: vision -------------------------------------------------------
  for (const side of SIDES) {
    const prevSight = new Set(state.players[side].sight);
    const v = computeVision(state, side);
    state.players[side].sight = [...v.sight];
    state.players[side].detect = [...v.detect];
    for (const id of prevSight) {
      if (!v.sight.has(id) && state.regions[id].owner === enemyOf(side)) {
        log(side, 7, `You lost sight of ${regionName(id)}`, 'Coverage lapsed. What you see there now will go stale.', '#8d99ab');
      }
    }
  }
  refreshIntel(state);
  refreshAlerts(state);

  state.turn += 1;
  return { state, logs };
}

function describeBuild(b) {
  switch (b.kind) {
    case 'claim': return 'claim';
    case 'node': return b.type;
    case 'bots': return 'defender training';
    case 'swarm': return 'swarm build';
    case 'worm': return 'worm build';
    case 'satellite': return 'satellite launch';
    case 'asat': return 'satellite killer';
    case 'moveSat': return 'satellite repositioning';
    default: return b.kind;
  }
}

function completeBuild(state, side, b, log, regionName, name) {
  const player = state.players[side];
  switch (b.kind) {
    case 'claim': {
      const region = state.regions[b.region];
      if (region.owner !== null) {
        log(side, 5, `Claim on ${regionName(b.region)} failed`, 'Someone got there first.', '#3f9c78');
        return;
      }
      region.owner = side;
      region.starved = 0;
      log(side, 5, `${regionName(b.region)} joined your network`, 'You can build here now.', '#3f9c78');
      log(enemyOf(side), 5, `${name(side)} claimed ${regionName(b.region)}`, 'Their network is growing.', '#3f9c78');
      return;
    }
    case 'node': {
      const region = state.regions[b.region];
      if (region.owner !== side || region.nodes.length >= RULES.maxNodesPerRegion) {
        log(side, 5, `Build at ${regionName(b.region)} failed`, 'The region was lost before it finished.', '#3f9c78');
        return;
      }
      region.nodes.push({ type: b.type, hp: RULES.combat.nodeHp });
      log(side, 5, `New ${b.type} online at ${regionName(b.region)}`, 'Finished building.', '#3f9c78');
      return;
    }
    case 'bots': {
      const region = state.regions[b.region];
      if (region.owner !== side || !nodesOf(region, 'INF').length) {
        log(side, 5, `Training at ${regionName(b.region)} failed`, 'The garrison there is gone.', '#3f9c78');
        return;
      }
      for (let i = 0; i < b.count; i++) {
        state.units.push({ id: state.nextId++, owner: side, type: 'bot', region: b.region });
      }
      log(side, 5, `${b.count} new defender${b.count === 1 ? '' : 's'} at ${regionName(b.region)}`, 'Ready to fight or move out.', '#3f9c78');
      return;
    }
    case 'swarm':
    case 'worm': {
      const region = state.regions[b.facility];
      if (region.owner !== side || !nodesOf(region, 'OPS').length) {
        log(side, 5, `${b.kind === 'swarm' ? 'Swarm' : 'Worm'} build lost`, `The ops centre at ${regionName(b.facility)} is gone.`, '#3f9c78');
        return;
      }
      const path = b.route ? [...b.route] : shortestPath(b.facility, b.target) || [];
      const unit = {
        id: state.nextId++,
        owner: side,
        type: b.kind,
        region: b.facility,
        target: b.target,
        path,
      };
      if (b.kind === 'swarm') unit.strength = RULES.combat.swarmStrength;
      else {
        unit.targetNode = b.targetNode || null;
        unit.detectedBy = {};
      }
      state.units.push(unit);
      log(side, 5, `${b.kind === 'swarm' ? 'Swarm' : 'Worm'} deployed from ${regionName(b.facility)}`, `Heading for ${regionName(b.target)} — ${path.length} turn${path.length === 1 ? '' : 's'} of travel.`, '#3f9c78');
      return;
    }
    case 'satellite': {
      const region = state.regions[b.facility];
      if (region.owner !== side || !nodesOf(region, 'LNC').length) {
        log(side, 5, 'Satellite launch lost', `The launch facility at ${regionName(b.facility)} is gone.`, '#3f9c78');
        return;
      }
      const sat = { id: state.nextId++, owner: side, region: b.target };
      player.satellites.push(sat);
      log('both', 5, `${name(side)}'s satellite reached orbit`, `It now watches ${regionName(b.target)} and its neighbours.`, '#c48a1e');
      return;
    }
    case 'asat': {
      const enemy = state.players[enemyOf(side)];
      const i = enemy.satellites.findIndex((s) => s.id === b.targetSat);
      if (i < 0) {
        log(side, 5, 'Satellite killer wasted', 'Its target was already gone.', '#c48a1e');
        return;
      }
      const [sat] = enemy.satellites.splice(i, 1);
      log(side, 5, 'Enemy satellite destroyed', `Their eye over ${regionName(sat.region)} is gone.`, '#c48a1e');
      log(enemyOf(side), 5, `Your satellite over ${regionName(sat.region)} was shot down`, 'A satellite killer found it. Your coverage there is gone.', '#c48a1e');
      return;
    }
    case 'moveSat': {
      const sat = player.satellites.find((s) => s.id === b.satId);
      if (!sat) return;
      sat.region = b.target;
      log('both', 5, `${name(side)}'s satellite repositioned`, `It now watches ${regionName(b.target)} and its neighbours.`, '#c48a1e');
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Intel & alerts (recomputed at the end of every turn)
// ---------------------------------------------------------------------------

function refreshIntel(state) {
  for (const side of SIDES) {
    const player = state.players[side];
    const enemy = enemyOf(side);
    const sight = new Set(player.sight);
    for (const r of REGIONS) {
      const region = state.regions[r.id];
      if (region.owner !== enemy) {
        delete player.intel[r.id];
        continue;
      }
      if (sight.has(r.id)) {
        player.intel[r.id] = {
          age: 0,
          nodes: region.nodes.map((n) => ({
            type: n.type,
            hpPct: Math.round((n.hp / (n.type === 'CAP' ? RULES.combat.capitalHp : RULES.combat.nodeHp)) * 100),
          })),
          garrison: botsIn(state, r.id, enemy).length,
        };
      } else if (player.intel[r.id]) {
        player.intel[r.id].age += 1;
      }
    }
  }
}

function refreshAlerts(state) {
  for (const side of SIDES) {
    const player = state.players[side];
    const enemy = enemyOf(side);
    const sight = new Set(player.sight);
    const detect = new Set(player.detect);
    const alerts = [];
    for (const u of state.units) {
      if (u.owner !== enemy) continue;
      if (u.type === 'swarm' && u.target && state.regions[u.target].owner === side && sight.has(u.region)) {
        alerts.push({ type: 'swarm', region: u.target, at: u.region, eta: u.path?.length ?? 0, strength: u.strength });
      }
      if (u.type === 'worm' && u.detectedBy?.[side]) {
        alerts.push({ type: 'worm', region: u.target, at: u.region, eta: u.path?.length ?? 0 });
      }
      if (u.type !== 'worm' && state.regions[u.region].owner === side) {
        alerts.push({ type: 'siege', region: u.region });
      }
    }
    for (const b of state.players[enemy].builds) {
      if ((b.kind === 'swarm' || b.kind === 'worm') && b.target && state.regions[b.target].owner === side) {
        const dist = (shortestPath(b.facility, b.target) || []).length;
        if (sight.has(b.facility)) {
          alerts.push({ type: 'build', buildType: b.kind, region: b.target, eta: b.turnsLeft + dist });
        } else if (detect.has(b.target)) {
          alerts.push({ type: 'anomaly', region: b.target, eta: b.turnsLeft + dist });
        }
      }
    }
    player.alerts = alerts;
  }
}
