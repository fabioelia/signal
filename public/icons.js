// SIGNAL DOMINION — hand-drawn SVG icon set. Stroke-based geometric glyphs
// on a 24×24 grid, tinted via currentColor so they inherit any palette
// colour. Inline everywhere: no image files, no fonts, crisp at any scale.

const PATHS = {
  // Command centre: four-point star with a core.
  CAP: '<path d="M12 3.5 14.3 9.7 20.5 12 14.3 14.3 12 20.5 9.7 14.3 3.5 12 9.7 9.7Z"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  // Finance hub: a stack of coin bars.
  FIN: '<rect x="6" y="4.5" width="12" height="4.4" rx="2.2"/><rect x="6" y="10" width="12" height="4.4" rx="2.2"/><rect x="6" y="15.5" width="12" height="4.4" rx="2.2"/>',
  // Defender garrison: shield.
  INF: '<path d="M12 3.5 18.5 6v5.4c0 4.4-2.8 7.3-6.5 9-3.7-1.7-6.5-4.6-6.5-9V6Z"/><path d="M12 8v5"/>',
  // Analyst post: an eye.
  ANL: '<path d="M2.8 12C4.8 8.4 8.2 6 12 6s7.2 2.4 9.2 6c-2 3.6-5.4 6-9.2 6s-7.2-2.4-9.2-6Z"/><circle cx="12" cy="12" r="2.6"/>',
  // Red team den: crosshair.
  OPS: '<circle cx="12" cy="12" r="6"/><path d="M12 2.8v4M12 17.2v4M2.8 12h4M17.2 12h4"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  // Uplink station: dish and beam.
  LNC: '<path d="M4.5 13.5A9 9 0 0 1 13.5 4.5"/><path d="M8 13.5A5.5 5.5 0 0 1 13.5 8"/><circle cx="14.5" cy="14.5" r="1.4" fill="currentColor" stroke="none"/><path d="M14.5 14.5 20 20M12 20.5h7"/>',
  // Swarm: a wedge of three delta gliders.
  swarm: '<path d="M12 4 15 9H9Z"/><path d="M7 13l3 5H4Z"/><path d="M17 13l3 5h-6Z"/>',
  // Worm: a sine crawler.
  worm: '<path d="M3 14c2.5-6 5-6 7 -1s4.5 5 7-1"/><circle cx="19.6" cy="9.6" r="1.3" fill="currentColor" stroke="none"/>',
  // Defender bot: small shield.
  bot: '<path d="M12 4.5 17.5 6.7v4.4c0 3.7-2.3 6.2-5.5 7.7-3.2-1.5-5.5-4-5.5-7.7V6.7Z"/>',
  // Satellite: body with panels.
  sat: '<rect x="9.4" y="9.4" width="5.2" height="5.2" rx="1" transform="rotate(45 12 12)"/><path d="M4 7.2 8.2 11M15.8 13l4.2 3.8M2.8 4l3.4 3.4M17.6 16.2l3.6 3.4"/>',
  // Speaker on/off for the sound toggle.
  soundOn: '<path d="M4 9.5v5h3.5L12 19V5L7.5 9.5Z"/><path d="M15 9a4.2 4.2 0 0 1 0 6M17.5 6.5a8 8 0 0 1 0 11"/>',
  soundOff: '<path d="M4 9.5v5h3.5L12 19V5L7.5 9.5Z"/><path d="M15.5 9.5 21 15M21 9.5 15.5 15"/>',
};

export function icon(name, size = 14, color = 'currentColor', extra = '') {
  const body = PATHS[name] || PATHS.CAP;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="color:${color};display:block;flex:0 0 ${size}px" ${extra}><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
}

// The SIGNAL DOMINION mark: a broadcast dot with two arcs, on a blue tile.
export function logoMark(size = 34, radius = 10) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 34 34" style="display:block;flex:0 0 ${size}px">
    <rect width="34" height="34" rx="${radius}" fill="#4a7fe0"/>
    <g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round">
      <circle cx="13" cy="21" r="2.4" fill="#fff" stroke="none"/>
      <path d="M17.5 16.5a7 7 0 0 1 2 4.5"/>
      <path d="M20.5 12.5a11.5 11.5 0 0 1 3.4 8.5"/>
    </g>
  </svg>`;
}

export const FAVICON = `data:image/svg+xml,${encodeURIComponent(logoMark(34, 8))}`;
