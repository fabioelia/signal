// Maps. Regions on a pointy-top hex grid (odd rows shifted right — "odd-r"
// offset), links = hex adjacency; nothing moves between unlinked regions.
//
// Fairness by construction: every map is exactly symmetric under the 180°
// rotation σ(row,col) = (rows-1-row, cols-1-col). With an EVEN number of
// rows, σ is a true isometry of the odd-r grid (row parity flips, matching
// the half-hex shift), so adjacency is preserved and the two starting
// clusters are perfect mirror images. Map authors define only the top half
// of the cells and the A-side start; the builder mirrors the rest.

export const HEX = { w: 132, h: 150, dx: 134, dy: 112, oddOffset: 67 };

// Every cluster uses the same opening template, applied to 7 region slots
// (slot 0 is the capital):
const START_TEMPLATE = [
  [['CAP', 'INF', 'FIN'], 4],
  [['INF'], 3],
  [['FIN', 'ANL'], 1],
  [['OPS'], 1],
  [['FIN'], 0],
  [['ANL', 'INF'], 2],
  [['FIN', 'LNC'], 1],
];

function neighborCoords(row, col) {
  const east = [row, col + 1];
  const west = [row, col - 1];
  if (row % 2 === 0) {
    return [east, west, [row - 1, col], [row - 1, col - 1], [row + 1, col], [row + 1, col - 1]];
  }
  return [east, west, [row - 1, col + 1], [row - 1, col], [row + 1, col + 1], [row + 1, col]];
}

const idOf = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

function buildMap({ id, name, blurb, rows, cols, halfCells, names, clusterA }) {
  if (rows % 2 !== 0) throw new Error(`${id}: rows must be even for σ-symmetry`);
  const sigma = ([r, c]) => [rows - 1 - r, cols - 1 - c];
  const cellSet = new Set();
  for (const cell of halfCells) {
    cellSet.add(cell.join(','));
    cellSet.add(sigma(cell).join(','));
  }
  const cells = [...cellSet]
    .map((s) => s.split(',').map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (cells.length !== names.length) {
    throw new Error(`${id}: ${cells.length} cells but ${names.length} names`);
  }
  const regions = cells.map(([row, col], i) => ({
    id: idOf(names[i]),
    name: names[i],
    row,
    col,
    x: col * HEX.dx + (row % 2) * HEX.oddOffset,
    y: row * HEX.dy,
  }));
  // Normalize x so maps with empty left columns still hug the origin.
  const minX = Math.min(...regions.map((r) => r.x));
  for (const r of regions) r.x -= minX;

  const byPos = new Map(regions.map((r) => [`${r.row},${r.col}`, r.id]));
  const byId = Object.fromEntries(regions.map((r) => [r.id, r]));
  const neighbors = {};
  for (const r of regions) {
    neighbors[r.id] = neighborCoords(r.row, r.col)
      .map(([row, col]) => byPos.get(`${row},${col}`))
      .filter(Boolean);
  }
  const cluster = clusterA.map((cell, i) => {
    const a = byPos.get(cell.join(','));
    const b = byPos.get(sigma(cell).join(','));
    if (!a || !b) throw new Error(`${id}: cluster slot ${i} is not on the map`);
    return [a, b, START_TEMPLATE[i][0], START_TEMPLATE[i][1]];
  });
  return {
    id,
    name,
    blurb,
    regions,
    byId,
    neighbors,
    start: { A: { capital: cluster[0][0] }, B: { capital: cluster[0][1] }, cluster },
    size: {
      w: Math.max(...regions.map((r) => r.x)) + HEX.w,
      h: Math.max(...regions.map((r) => r.y)) + HEX.h,
    },
  };
}

// --------------------------------------------------------------------------
// The maps
// --------------------------------------------------------------------------

const fracturedBelt = buildMap({
  id: 'fractured_belt',
  name: 'Fractured Belt',
  blurb: '24 regions of open ground — every front is live.',
  rows: 4,
  cols: 6,
  halfCells: Array.from({ length: 12 }, (_, i) => [Math.floor(i / 6), i % 6]),
  names: [
    'Redmoss', 'Sablecote', 'Thistlow', 'Umberly', 'Halbrook', 'Kestrave',
    'Lowmarch', 'Marnow', 'Norvane', 'Ostrey', 'Pellhaven', 'Quarrow',
    'Ellwick', 'Fenmar', 'Vellmar', 'Ilsmere', 'Jarveth', 'Kelbrey',
    'Aldermoor', 'Brackwell', 'Corvale', 'Dunmere', 'Greyholt', 'Harrow',
  ],
  clusterA: [[3, 0], [3, 1], [3, 2], [3, 3], [2, 0], [2, 1], [2, 2]],
});

const theStraits = buildMap({
  id: 'the_straits',
  name: 'The Straits',
  blurb: '32 regions: two continents, two causeways — hold the crossings.',
  rows: 6,
  cols: 7,
  halfCells: [
    // North continent (mirrored to the south one)
    ...Array.from({ length: 7 }, (_, c) => [0, c]),
    ...Array.from({ length: 7 }, (_, c) => [1, c]),
    // The causeways across the strait (σ adds their southern halves)
    [2, 1], [2, 5],
  ],
  names: [
    'Nordhaven', 'Skarholm', 'Brimcliff', 'Vasterby', 'Kolgrim', 'Eisfjord', 'Kestrelspire',
    'Rimegate', 'Stormwatch', 'Frosthollow', 'Galeport', 'Hallowmere', 'Ironshore', 'Nordvik',
    'Westford', 'Eastford',
    'Westgate', 'Eastgate',
    'Suderby', 'Palegrove', 'Quellmarsh', 'Redsand', 'Saltmere', 'Tidewell', 'Umberreach',
    'Vailmoor', 'Warrenholt', 'Yarrowfen', 'Zephyrhead', 'Ashdune', 'Brackenshore', 'Coralstead',
  ],
  clusterA: [[5, 0], [5, 1], [5, 2], [4, 0], [4, 1], [4, 2], [5, 3]],
});

const archipelago = buildMap({
  id: 'archipelago',
  name: 'Archipelago',
  blurb: '28 regions: island homes around a contested core — the center is everything.',
  rows: 6,
  cols: 7,
  halfCells: [
    // North-west isle
    [0, 0], [0, 1], [1, 0], [1, 1],
    // North-east home island
    [0, 4], [0, 5], [0, 6], [1, 4], [1, 5], [1, 6], [2, 5], [2, 6],
    // Northern half of the contested core
    [2, 2], [2, 3],
  ],
  names: [
    'Ashen Cay', 'Bracken Cay', 'Corsair Rock', 'Driftmoor', 'Emberholm',
    'Fogbank', 'Gullwatch', 'Harrow Isle', 'Islet Kray', 'Jettystrand',
    'Kelpshoal', 'Lagoonspire', 'Mistcay', 'Nautichead',
    'Oarwick', 'Pearlgate', 'Quillreef', 'Reefholm',
    'Saltcairn', 'Tidegrasp', 'Umbershoal', 'Vortexbank', 'Wrackline',
    'Xebec Bay', 'Yawlport', 'Zealshoal', 'Anchorfall', 'Coveend',
  ],
  clusterA: [[5, 0], [5, 1], [5, 2], [4, 0], [4, 1], [4, 2], [3, 0]],
});

export const MAPS = {
  [fracturedBelt.id]: fracturedBelt,
  [theStraits.id]: theStraits,
  [archipelago.id]: archipelago,
};
export const DEFAULT_MAP = fracturedBelt.id;
export function mapDef(id) {
  return MAPS[id] || MAPS[DEFAULT_MAP];
}

// Deterministic BFS shortest path over an adjacency table (stable
// tie-breaking by insertion order). Returns the path EXCLUDING `from`,
// or null if unreachable.
export function pathOn(neighbors, from, to, blocked = () => false) {
  if (from === to) return [];
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of neighbors[cur] || []) {
      if (prev.has(next) || blocked(next)) continue;
      prev.set(next, cur);
      if (next === to) {
        const path = [to];
        let p = cur;
        while (p !== from) {
          path.unshift(p);
          p = prev.get(p);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

// Legacy bindings to the default map (existing tests and callers).
export const REGIONS = fracturedBelt.regions;
export const NEIGHBORS = fracturedBelt.neighbors;
export const START = fracturedBelt.start;
export function adjacent(a, b) {
  return NEIGHBORS[a]?.includes(b) ?? false;
}
export function shortestPath(from, to, blocked) {
  return pathOn(NEIGHBORS, from, to, blocked);
}
