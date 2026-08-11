// The "Fractured Belt" map — 24 regions on a pointy-top hex grid, taken from
// the design prototype. Odd rows are shifted right by half a hex (odd-r
// offset). Links are hex adjacency; nothing moves between unlinked regions.
//
// The map is exactly symmetric under 180° rotation σ(row,col) = (3-row, 5-col),
// so the two starting clusters are mirror images and the match is fair.

export const HEX = { w: 132, h: 150, dx: 134, dy: 112, oddOffset: 67 };

// [name, row, col]
const REGION_DEFS = [
  ['Aldermoor', 3, 0], ['Brackwell', 3, 1], ['Corvale', 3, 2], ['Dunmere', 3, 3],
  ['Ellwick', 2, 0], ['Fenmar', 2, 1], ['Vellmar', 2, 2],
  ['Greyholt', 3, 4], ['Harrow', 3, 5],
  ['Ilsmere', 2, 3], ['Jarveth', 2, 4], ['Kelbrey', 2, 5],
  ['Lowmarch', 1, 0], ['Marnow', 1, 1], ['Norvane', 1, 2],
  ['Ostrey', 1, 3], ['Pellhaven', 1, 4], ['Quarrow', 1, 5],
  ['Redmoss', 0, 0], ['Sablecote', 0, 1], ['Thistlow', 0, 2],
  ['Umberly', 0, 3], ['Halbrook', 0, 4], ['Kestrave', 0, 5],
];

export const REGIONS = REGION_DEFS.map(([name, row, col]) => ({
  id: name.toLowerCase(),
  name,
  row,
  col,
  x: col * HEX.dx + (row % 2) * HEX.oddOffset,
  y: row * HEX.dy,
}));

const byPos = new Map(REGIONS.map((r) => [`${r.row},${r.col}`, r.id]));

// Pointy-top odd-r offset adjacency (odd rows shifted right).
function neighborCoords(row, col) {
  const east = [row, col + 1];
  const west = [row, col - 1];
  if (row % 2 === 0) {
    return [east, west, [row - 1, col], [row - 1, col - 1], [row + 1, col], [row + 1, col - 1]];
  }
  return [east, west, [row - 1, col + 1], [row - 1, col], [row + 1, col + 1], [row + 1, col]];
}

export const NEIGHBORS = {};
for (const r of REGIONS) {
  NEIGHBORS[r.id] = neighborCoords(r.row, r.col)
    .map(([row, col]) => byPos.get(`${row},${col}`))
    .filter(Boolean);
}

export function adjacent(a, b) {
  return NEIGHBORS[a]?.includes(b) ?? false;
}

// Starting setup. Each entry is mirrored onto both sides via the σ pairs, so
// both players begin with an identical seven-region cluster:
//   A (south-west, capital Aldermoor)  <->  B (north-east, capital Kestrave)
export const START = {
  A: { capital: 'aldermoor' },
  B: { capital: 'kestrave' },
  // [regionA, regionB, nodes, garrison]
  cluster: [
    ['aldermoor', 'kestrave', ['CAP', 'INF', 'FIN'], 4],
    ['brackwell', 'halbrook', ['INF'], 3],
    ['corvale', 'umberly', ['FIN', 'ANL'], 1],
    ['dunmere', 'thistlow', ['OPS'], 1],
    ['ellwick', 'quarrow', ['FIN'], 0],
    ['fenmar', 'pellhaven', ['ANL', 'INF'], 2],
    ['vellmar', 'ostrey', ['FIN', 'LNC'], 1],
  ],
};

// Deterministic BFS shortest path (stable tie-breaking by map order).
// Returns the path EXCLUDING `from`, or null if unreachable.
export function shortestPath(from, to, blocked = () => false) {
  if (from === to) return [];
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of NEIGHBORS[cur]) {
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
