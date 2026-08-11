// SIGNAL DOMINION — shared rule constants.
// Used by the server engine, the headless tests, and the browser client
// (served statically at /shared/constants.js).

export const VERSION = '0.8.0';

export const NODE_META = {
  CAP: { label: 'Command centre', color: '#e8b53f', tint: '#fbf1d6' },
  FIN: { label: 'Finance hub', color: '#3f9c78', tint: '#dff2ea' },
  INF: { label: 'Defender garrison', color: '#4a7fe0', tint: '#e2ebfb' },
  ANL: { label: 'Analyst post', color: '#8f5fc7', tint: '#eee4f8' },
  OPS: { label: 'Red team den', color: '#d8624f', tint: '#fae0da' },
  LNC: { label: 'Uplink station', color: '#c48a1e', tint: '#f8eed6' },
};

export const RULES = {
  costs: {
    claim: 70,
    node: { FIN: 80, INF: 60, ANL: 70, OPS: 90, LNC: 140 },
    bot: 30,
    swarm: 60,
    worm: 120,
    satellite: 150,
    asat: 110,
    sweep: 25,      // with analyst coverage of the region
    sweepFar: 50,   // without analyst coverage
    moveSat: 60,
  },
  turns: {
    claim: 2,
    node: { FIN: 3, INF: 2, ANL: 2, OPS: 3, LNC: 4 },
    bot: 1,
    swarm: 2,
    worm: 3,
    satellite: 4,
    asat: 3,
    moveSat: 2,
  },
  refundRate: 0.5,      // cancelling an in-progress build
  demolishRefund: 0.25, // decommissioning a finished structure
  repairPerHp: 0.5,     // §1 per 2 HP restored (command centres can't be repaired)
  income: { capital: 20, finance: 25 },
  upkeep: { node: 2, bot: 2, swarm: 4, worm: 4, satellite: 6 },
  combat: {
    botPower: 2,        // each infantry bot defends with this strength
    infBonus: 2,        // each INF node adds this while at least one bot defends
    swarmStrength: 6,   // strength of a freshly built swarm group
    wormCapitalDamage: 12,
    wormNodeDamage: 100, // non-capital payload destroys the node
    capitalHp: 30,
    nodeHp: 100,
  },
  reconnectTurns: 2,   // isolation lifts after this many turns of "reconnecting"
  starveGrace: 2,      // turns cut off before degradation starts
  starveNodeDamage: 10,
  collapseTurns: 5,    // consecutive negative-income turns before economic collapse
  maxNodesPerRegion: 4,
  planningSeconds: 90,
  startingFunding: 200,
};

// Deterministic resolution order — documented, always the same. The numbers
// are referenced by log entries and shown in the resolution overlay.
export const RESOLUTION_STEPS = [
  { n: 1, label: 'Regions cut off or reconnected' },
  { n: 2, label: 'Everything on the move takes a step' },
  { n: 3, label: 'Fights happen where sides meet' },
  { n: 4, label: 'Worms that got through do their damage' },
  { n: 5, label: 'Builds tick forward' },
  { n: 6, label: 'Money comes in, upkeep goes out' },
  { n: 7, label: 'You see what you can now see' },
];

export const WORM_TARGET_PRIORITY = ['CAP', 'FIN', 'OPS', 'LNC', 'ANL', 'INF'];
