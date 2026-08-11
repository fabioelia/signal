// Builds the fog-of-war-filtered view of the match that one player is allowed
// to see. The server sends ONLY this to each client — the full state never
// leaves the server, so a modified client cannot peek through the fog.

import { REGIONS, NEIGHBORS } from './map.js';
import { RULES } from './constants.js';
import { enemyOf, botsIn, connectedSet } from './engine.js';

export function buildView(state, side) {
  const player = state.players[side];
  const enemy = enemyOf(side);
  const enemyPlayer = state.players[enemy];
  const sight = new Set(player.sight);
  const conn = connectedSet(state, side);

  const regions = {};
  for (const r of REGIONS) {
    const region = state.regions[r.id];
    const visible = region.owner === side || sight.has(r.id);
    const out = {
      id: r.id,
      name: r.name,
      x: r.x,
      y: r.y,
      owner: region.owner,          // topology and ownership are public
      isolated: region.isolated,    // quarantines are visible commitments
      reconnecting: region.reconnecting,
      neighbors: NEIGHBORS[r.id],
      visible,
      connected: region.owner === side ? conn.has(r.id) : null,
      starved: region.owner === side ? region.starved : null,
      nodes: null,
      garrison: null,
      intel: null,
    };
    if (visible) {
      out.nodes = region.nodes.map((n) => ({
        type: n.type,
        hp: n.hp,
        maxHp: n.type === 'CAP' ? RULES.combat.capitalHp : RULES.combat.nodeHp,
      }));
      out.garrison = region.owner ? botsIn(state, r.id, region.owner).length : 0;
    } else if (region.owner === enemy && player.intel[r.id]) {
      out.intel = player.intel[r.id];
    }
    regions[r.id] = out;
  }

  const units = [];
  for (const u of state.units) {
    const mine = u.owner === side;
    if (!mine) {
      if (u.type === 'worm' && !u.detectedBy?.[side]) continue; // stealth
      if (u.type !== 'worm' && !sight.has(u.region)) continue;
    }
    units.push({
      id: u.id,
      owner: u.owner,
      type: u.type,
      region: u.region,
      strength: u.strength ?? null,
      target: mine ? u.target ?? null : (u.type === 'worm' || sight.has(u.region) ? u.target ?? null : null),
      eta: mine || u.type === 'worm' || sight.has(u.region) ? u.path?.length ?? 0 : null,
      detected: u.type === 'worm' ? !!u.detectedBy?.[enemyOf(u.owner)] : null,
    });
  }

  // Satellites are big telegraphed public investments — both sides' orbits
  // are common knowledge. Satellite LAUNCHES in progress are public too;
  // other enemy builds only appear when their facility is inside your sight.
  const satellites = [
    ...player.satellites.map((s) => ({ ...s })),
    ...enemyPlayer.satellites.map((s) => ({ ...s })),
  ];
  const enemyBuilds = enemyPlayer.builds
    .filter((b) => b.kind === 'satellite' || sight.has(b.facility || b.region))
    .map((b) => ({
      kind: b.kind,
      region: b.region,
      target: b.kind === 'satellite' ? null : b.target ?? null, // where a sat will watch stays secret
      turnsLeft: b.turnsLeft,
    }));

  return {
    side,
    turn: state.turn,
    winner: state.winner,
    winReason: state.winReason,
    you: {
      name: player.name,
      funding: player.funding,
      income: player.income,
      negStreak: player.negStreak,
      capital: player.capital,
      capitalHp: (() => {
        const cap = state.regions[player.capital].nodes.find((n) => n.type === 'CAP');
        return cap ? cap.hp : 0;
      })(),
      builds: player.builds.map((b) => ({ ...b })),
      satellites: player.satellites.map((s) => ({ ...s })),
      sight: [...player.sight],
      detect: [...player.detect],
      alerts: player.alerts.map((a) => ({ ...a })),
    },
    opponent: {
      name: enemyPlayer.name,
      capital: enemyPlayer.capital,
      satellites: enemyPlayer.satellites.map((s) => ({ ...s })),
      builds: enemyBuilds,
    },
    regions,
    units,
    satellites,
  };
}
