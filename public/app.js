// SIGNAL DOMINION client. Two ways to play:
//
//   Online — one WebSocket to the game server, which is authoritative and
//   only ever sends this player's fog-filtered view.
//
//   Pass-and-play — the same Match class the server uses runs right here in
//   the page with two in-page "sockets", and the players hand the device
//   back and forth. This is what works on a static host (GitHub Pages),
//   where there is no server to talk to. On a static host you can still
//   play online by pointing the client at a hosted server with
//   ?server=wss://your-server.example
//
// Orders queue up locally during planning and are sent once on "Lock in".

// Imported relative to this module: on the Node server app.js is served at
// /app.js so this resolves to /shared/…; on GitHub Pages it's
// /signal/public/app.js so this resolves to /signal/shared/… — both correct.
import { NODE_META, RULES, RESOLUTION_STEPS } from '../shared/constants.js';
import { Match } from '../shared/match.js';

const $app = document.getElementById('app');

const PARAMS = new URLSearchParams(location.search);
const SERVER_URL = PARAMS.get('server'); // e.g. wss://myserver.example
const STATIC_HOST = !SERVER_URL && /(^|\.)github\.io$/.test(location.hostname);
const HERE = location.origin + location.pathname;

const S = {
  conn: 'connecting',
  err: null,
  waitingNote: null,
  joined: null, // {code, side, token}
  sync: null,   // last sync message from the server (or the local match)
  token: localStorage.getItem('sd_token') || null,
  name: localStorage.getItem('sd_name') || '',
  localSeat: null,    // pass-and-play: which seat is holding the device
  localHandoff: null, // pass-and-play: seat waiting to take the device
  ui: {
    tab: 'map',
    selected: null,
    pending: [],
    pick: null,        // {type:'sat'} | {type:'moveSat', sat}
    buildMenu: false,
    reinforceMenu: false,
    resolve: null,     // {turn, log} — resolution overlay
    toast: null,
    autoLocked: false,
    hideOver: false,
  },
};

// --------------------------------------------------------------------------
// Networking
// --------------------------------------------------------------------------

let ws = null;
let retryMs = 800;

function connect() {
  if (STATIC_HOST) {
    S.conn = 'static'; // no server here — pass-and-play only
    render();
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(SERVER_URL || `${proto}//${location.host}`);
  ws.onopen = () => {
    S.conn = 'open';
    S.err = null;
    retryMs = 800;
    if (S.token) send({ t: 'rejoin', token: S.token });
    render();
  };
  ws.onclose = () => {
    if (local) return;
    S.conn = 'closed';
    render();
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 1.6, 8000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    handleMessage(msg);
  };
}

function send(msg) {
  if (local) { routeLocal(msg); return; }
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

function handleMessage(msg) {
  switch (msg.t) {
    case 'joined':
      S.joined = msg;
      S.token = msg.token;
      localStorage.setItem('sd_token', msg.token);
      S.waitingNote = null;
      S.err = null;
      break;
    case 'waiting':
      S.waitingNote = msg.note;
      break;
    case 'error':
      if (msg.fatal === 'token') {
        localStorage.removeItem('sd_token');
        S.token = null;
        S.joined = null;
        S.sync = null;
      } else {
        S.err = msg.error;
      }
      break;
    case 'sync': {
      const prevTurn = S.sync?.view?.turn || 0;
      S.sync = msg;
      if (msg.resolved && msg.view && msg.view.turn > prevTurn && prevTurn > 0) {
        S.ui.pending = [];
        S.ui.autoLocked = false;
        S.ui.resolve = { turn: msg.view.turn - 1, log: msg.log || [] };
        const rejects = msg.you?.lockResult?.rejected || [];
        if (rejects.length) {
          S.ui.toast = `${rejects.length} order${rejects.length === 1 ? '' : 's'} could not be carried out: ${rejects.map((r) => r.reason).join('; ')}`;
          setTimeout(() => { S.ui.toast = null; render(); }, 7000);
        }
      }
      if (msg.view && !S.ui.selected) S.ui.selected = msg.view.you.capital;
      if (msg.view && msg.view.turn !== prevTurn) S.ui.pick = null;
      break;
    }
    default:
      break;
  }
  render();
}

// --------------------------------------------------------------------------
// Pass-and-play: run the Match in-page, hand the device back and forth.
// Each seat gets its own sync stream (fog intact); a full-screen handoff
// cover hides the board between seats so nobody peeks.
// --------------------------------------------------------------------------

let local = null; // { match, seats: {A: {sync, pendingResolve}, B: {...}} }

function startLocal(nameA, nameB) {
  local = { match: new Match('LOCAL', 'relaxed'), seats: { A: {}, B: {} } };
  S.localSeat = 'A';
  S.joined = { code: 'LOCAL', side: 'A', token: null };
  const fakeWs = (side) => ({ readyState: 1, send: (json) => deliverLocal(side, JSON.parse(json)) });
  local.match.addPlayer(fakeWs('A'), nameA, 'seat-a');
  local.match.addPlayer(fakeWs('B'), nameB, 'seat-b');
  local.match.setReady('A', true);
  local.match.setReady('B', true); // both ready → the match starts immediately
}

function deliverLocal(side, msg) {
  if (msg.t !== 'sync') return;
  const seat = local.seats[side];
  seat.sync = msg;
  if (msg.resolved && msg.view) {
    seat.pendingResolve = { turn: msg.view.turn - 1, log: msg.log || [] };
  }
  if (side === S.localSeat && !S.localHandoff) applyLocalSync(side);
}

function applyLocalSync(side) {
  const seat = local.seats[side];
  if (!seat.sync) return;
  S.sync = seat.sync;
  if (seat.pendingResolve) {
    S.ui.pending = [];
    S.ui.resolve = seat.pendingResolve;
    seat.pendingResolve = null;
    const rejects = seat.sync.you?.lockResult?.rejected || [];
    if (rejects.length) {
      S.ui.toast = `${rejects.length} order${rejects.length === 1 ? '' : 's'} could not be carried out: ${rejects.map((r) => r.reason).join('; ')}`;
      setTimeout(() => { S.ui.toast = null; render(); }, 7000);
    }
  }
  if (S.sync.view && !S.ui.selected) S.ui.selected = S.sync.view.you.capital;
  render();
}

function routeLocal(msg) {
  const m = local.match;
  if (msg.t === 'lock') {
    m.lockOrders(S.localSeat, msg.orders);
    // If the turn didn't resolve (the other seat hasn't locked yet), it's
    // their move — put up the handoff cover.
    if (m.phase === 'planning' && m.players[S.localSeat].locked) {
      S.localHandoff = S.localSeat === 'A' ? 'B' : 'A';
      render();
    }
  } else if (msg.t === 'ready') {
    m.setReady(S.localSeat, msg.ready);
  }
}

function takeSeat(side) {
  S.localSeat = side;
  S.localHandoff = null;
  S.ui.pending = [];
  S.ui.buildMenu = false;
  S.ui.reinforceMenu = false;
  S.ui.resolve = null;
  S.ui.pick = null;
  S.ui.selected = null;
  applyLocalSync(side);
}

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function view() { return S.sync?.view || null; }
function mySide() { return view()?.side; }
function oppSide() { return mySide() === 'A' ? 'B' : 'A'; }
function oppName() { return S.sync?.opp?.name || 'Opponent'; }
function region(id) { return view()?.regions[id] || null; }
function regionName(id) { return region(id)?.name || cap(id || ''); }
function isMine(r) { return r && r.owner === mySide(); }
function isEnemy(r) { return r && r.owner === oppSide(); }
function locked() { return !!S.sync?.you?.locked; }
function planning() { return S.sync?.match?.phase === 'planning' && !view()?.winner; }

function unitsAt(id) { return (view()?.units || []).filter((u) => u.region === id); }

function analystNear(id) {
  const r = region(id);
  if (!r) return false;
  const ids = [id, ...r.neighbors];
  return ids.some((n) => {
    const rr = region(n);
    return isMine(rr) && (rr.nodes || []).some((nd) => nd.type === 'ANL');
  });
}

function estCost(o) {
  const c = RULES.costs;
  switch (o.kind) {
    case 'claim': return c.claim;
    case 'build_node': return c.node[o.type];
    case 'train_bots': return c.bot * (o.count || 1);
    case 'build_swarm': return c.swarm;
    case 'build_worm': return c.worm;
    case 'build_satellite': return c.satellite;
    case 'build_asat': return c.asat;
    case 'move_satellite': return c.moveSat;
    case 'sweep': return analystNear(o.region) ? c.sweep : c.sweepFar;
    default: return 0;
  }
}

function pendingSpend() { return S.ui.pending.reduce((s, o) => s + estCost(o), 0); }
function budgetLeft() { return (view()?.you.funding || 0) - pendingSpend(); }

function facilityFree(nodeType) {
  const v = view();
  if (!v) return false;
  let capacity = 0;
  for (const r of Object.values(v.regions)) {
    if (isMine(r) && r.nodes) capacity += r.nodes.filter((n) => n.type === nodeType).length;
  }
  const kinds = nodeType === 'OPS' ? ['swarm', 'worm'] : ['satellite', 'asat'];
  const orderKinds = nodeType === 'OPS'
    ? ['build_swarm', 'build_worm']
    : ['build_satellite', 'build_asat'];
  const busy = v.you.builds.filter((b) => kinds.includes(b.kind)).length
    + S.ui.pending.filter((o) => orderKinds.includes(o.kind)).length;
  return busy < capacity;
}

function orderChip(o) {
  const t = RULES.turns;
  const cost = estCost(o);
  switch (o.kind) {
    case 'claim': return { label: `Claim ${regionName(o.region)}`, meta: `${t.claim} turns · §${cost}`, color: '#4a7fe0' };
    case 'build_node': return { label: `Build ${NODE_META[o.type].label.toLowerCase()} in ${regionName(o.region)}`, meta: `${t.node[o.type]} turns · §${cost}`, color: NODE_META[o.type].color };
    case 'train_bots': return { label: `Train ${o.count} defender${o.count === 1 ? '' : 's'} at ${regionName(o.region)}`, meta: `1 turn · §${cost}`, color: '#4a7fe0' };
    case 'move_bots': return { label: `Reinforce ${regionName(o.to)}`, meta: `${o.count} from ${regionName(o.from)} · arrives next turn`, color: '#4a7fe0' };
    case 'isolate': return { label: `Cut off ${regionName(o.region)}`, meta: 'Reconnect takes 2 turns', color: '#e8b53f' };
    case 'reconnect': return { label: `Reconnect ${regionName(o.region)}`, meta: `${RULES.reconnectTurns} turns · vulnerable meanwhile`, color: '#e8b53f' };
    case 'sweep': return { label: `Sweep ${regionName(o.region)}`, meta: `1 turn · §${cost}`, color: '#8f5fc7' };
    case 'build_swarm': return { label: `Swarm push on ${regionName(o.target)}`, meta: `builds ${t.swarm} turns · §${cost}`, color: '#d8624f' };
    case 'build_worm': return { label: `Worm run at ${regionName(o.target)}`, meta: `builds ${t.worm} turns · §${cost}`, color: '#d8624f' };
    case 'build_satellite': return { label: `Satellite over ${regionName(o.target)}`, meta: `${t.satellite} turns · §${cost}`, color: '#c48a1e' };
    case 'build_asat': return { label: 'Build a satellite killer', meta: `${t.asat} turns · §${cost}`, color: '#d8624f' };
    case 'move_satellite': return { label: `Move satellite to ${regionName(o.target)}`, meta: `${t.moveSat} turns · §${cost}`, color: '#c48a1e' };
    case 'cancel_build': return { label: `Cancel: ${esc(o.label || 'build')}`, meta: `refund §${o.refund ?? '?'}`, color: '#8d99ab' };
    default: return { label: o.kind, meta: '', color: '#8d99ab' };
  }
}

function addOrder(o) {
  if (!planning() || locked()) return;
  if (o.kind === 'move_bots' || o.kind === 'train_bots') {
    const same = S.ui.pending.find((p) => p.kind === o.kind && p.region === o.region && p.from === o.from && p.to === o.to);
    if (same) {
      const max = o.kind === 'train_bots' ? 5 : (o.maxCount ?? 99);
      same.count = Math.min(same.count + 1, max);
      render();
      return;
    }
  }
  S.ui.pending.push(o);
  S.ui.buildMenu = false;
  S.ui.reinforceMenu = false;
  render();
}

function lockIn() {
  if (!planning() || locked()) return;
  send({ t: 'lock', orders: S.ui.pending.map(({ maxCount, label, refund, ...o }) => o) });
}

// --------------------------------------------------------------------------
// Screens
// --------------------------------------------------------------------------

function render() {
  const v = view();
  let html;
  if (!S.sync || !S.joined) html = renderConnect();
  else if (S.sync.match.phase === 'lobby') html = renderLobby();
  else html = renderGame(v);
  if (S.conn === 'closed') {
    html += `<div class="conn-banner">Connection lost — reconnecting…</div>`;
  }
  $app.innerHTML = html;
  afterRender();
}

function renderConnect() {
  const urlCode = PARAMS.get('code') || '';
  const offline = S.conn === 'static';
  const offlineNote = offline
    ? '<div class="body" style="color:#a07a24">This is the static build — there is no game server here, so online play is off. Pass-and-play works right on this page, or point this client at a hosted server with <b>?server=wss://…</b> (see the README).</div>'
    : '';
  return `
  <div class="screen" style="overflow:auto">
    <div class="wordmark"><div class="mark"></div><div class="word">SIGNAL DOMINION</div></div>
    <div class="tagline">Two governments, one network. Plan in private, resolve together — first capital to fall ends it.</div>
    ${S.err ? `<div class="error-note">${esc(S.err)}</div>` : ''}
    ${S.waitingNote ? `<div class="error-note" style="background:#10263e;border-color:#2f5686;color:#cfe2fb">${esc(S.waitingNote)}</div>` : ''}
    <div class="card-row">
      <div class="paper-card">
        <div class="eyebrow">COMMANDER</div>
        <div class="field">
          <label for="name-in">DISPLAY NAME</label>
          <input id="name-in" maxlength="24" placeholder="e.g. Meridian" value="${esc(S.name)}">
        </div>
        <div class="rule"></div>
        <div class="body">Your opponent sees this name across the table. Everything else about you stays behind the fog.</div>
      </div>
      <div class="paper-card">
        <div class="eyebrow">START A MATCH</div>
        <div class="field">
          <label for="pacing-in">PACING</label>
          <select id="pacing-in" ${offline ? 'disabled' : ''}>
            <option value="live">Live · ${RULES.planningSeconds}s per turn</option>
            <option value="relaxed">Relaxed · no timer</option>
          </select>
        </div>
        <button class="paper-btn primary" data-act="create" ${offline ? 'disabled' : ''}>Create match</button>
        <div class="rule"></div>
        <div class="body">You'll get a 4-letter code and a link to send to your opponent.</div>
        <button class="paper-btn" data-act="quick" ${offline ? 'disabled' : ''}>Quick match — pair me with anyone</button>
        ${offlineNote}
      </div>
      <div class="paper-card">
        <div class="eyebrow">JOIN A MATCH</div>
        <div class="field">
          <label for="code-in">MATCH CODE</label>
          <input id="code-in" class="code" maxlength="4" placeholder="XXXX" value="${esc(urlCode)}" ${offline ? 'disabled' : ''}>
        </div>
        <button class="paper-btn primary" data-act="join" ${offline ? 'disabled' : ''}>Join with code</button>
        <div class="rule"></div>
        <div class="body">Get the code (or the link) from whoever created the match.</div>
      </div>
      <div class="paper-card">
        <div class="eyebrow">SAME DEVICE</div>
        <div class="field">
          <label for="name2-in">SECOND PLAYER</label>
          <input id="name2-in" maxlength="24" placeholder="e.g. Kestrel">
        </div>
        <button class="paper-btn primary" data-act="local">Start pass-and-play</button>
        <div class="rule"></div>
        <div class="body">Two players, one screen. You hand the device back and forth; a cover screen keeps each side's fog private. Runs entirely in this page.</div>
      </div>
    </div>
  </div>`;
}

function renderLobby() {
  const you = S.sync.you;
  const opp = S.sync.opp;
  const code = S.sync.match.code;
  const pacing = S.sync.match.pacing === 'live' ? `Live · ${RULES.planningSeconds}s per turn` : 'Relaxed · no timer';
  const shareLink = `${HERE}?code=${code}`;
  return `
  <div class="screen">
    <div class="wordmark"><div class="mark"></div><div class="word">SIGNAL DOMINION</div></div>
    <div class="card-row">
      <div class="paper-card">
        <div class="eyebrow">YOU</div>
        <div class="identity">
          <div class="avatar" style="background:#4a7fe0"></div>
          <div>
            <div class="who">${esc(you.name)}</div>
            <div class="status ${you.ready ? 'good' : ''}">${you.ready ? 'Ready' : 'Ready to plan'}</div>
          </div>
        </div>
        <div class="rule"></div>
        <div class="body">You start with a seven-region cluster. Your capital sits at ${you.side === 'A' ? 'Aldermoor' : 'Kestrave'}.</div>
      </div>
      <div class="paper-card">
        <div class="eyebrow">OPPONENT</div>
        ${opp ? `
        <div class="identity">
          <div class="avatar" style="background:#e0803f"></div>
          <div>
            <div class="who">${esc(opp.name)}</div>
            <div class="status ${opp.ready ? 'good' : ''}">${opp.connected ? (opp.ready ? 'Connected · ready' : 'Connected · not ready') : 'Disconnected'}</div>
          </div>
        </div>
        <div class="rule"></div>
        <div class="body">Both of you plan at the same time each turn. Orders resolve together when you're both done.</div>
        ` : `
        <div class="identity">
          <div class="avatar" style="background:#333e4f"></div>
          <div>
            <div class="who" style="color:#8b93a1">Waiting…</div>
            <div class="status">Share the code below</div>
          </div>
        </div>
        <div class="rule"></div>
        <div class="code-chip">${esc(code)}<button class="paper-btn" data-act="copy-link">Copy link</button></div>
        <div class="body">Send <a href="${esc(shareLink)}">${esc(shareLink)}</a> to your opponent, or have them enter the code.</div>
        `}
      </div>
    </div>
    <div class="info-bar">
      <div class="cell"><div class="k">MAP</div><div class="v">24 regions · Fractured Belt</div></div>
      <div class="sep"></div>
      <div class="cell"><div class="k">PACING</div><div class="v">${pacing}</div></div>
      <div class="sep"></div>
      <div class="cell"><div class="k">LENGTH</div><div class="v">Typically 20–40 turns</div></div>
      <div class="sep"></div>
      <div class="cell"><div class="k">CODE</div><div class="v" style="font-family:var(--mono);letter-spacing:.2em">${esc(code)}</div></div>
    </div>
    <button class="cta" data-act="ready" ${!opp ? 'disabled' : ''}>${you.ready ? 'Waiting for opponent…' : 'Start the match'}</button>
    <button class="cta secondary" data-act="leave">Leave</button>
  </div>`;
}

// ---- game ----------------------------------------------------------------

function renderGame(v) {
  return `
  <div class="game">
    ${renderTopbar(v)}
    <div class="main">
      ${renderRail(v)}
      <div class="stage">
        ${S.ui.tab === 'map' ? renderMap(v) : ''}
        ${S.ui.tab === 'orbit' ? renderOrbit(v) : ''}
        ${S.ui.tab === 'intel' ? renderIntel(v) : ''}
        ${S.ui.tab === 'log' ? renderLog(v) : ''}
        ${S.ui.pick ? renderPickBanner() : ''}
      </div>
      ${renderSidebar(v)}
    </div>
    ${renderOrderbar(v)}
    ${S.ui.toast ? `<div class="toast">${esc(S.ui.toast)}</div>` : ''}
    ${v.winner ? (S.ui.hideOver ? '' : renderGameOver(v)) : (S.ui.resolve ? renderResolve(v) : '')}
    ${S.localHandoff ? renderHandoff() : ''}
  </div>`;
}

function renderHandoff() {
  const name = local?.match.players[S.localHandoff]?.name || 'the other player';
  return `
  <div class="overlay" style="background:var(--bg);z-index:90">
    <div class="resolve-card" style="width:480px;text-align:center;align-items:center">
      <div style="width:34px;height:34px;border-radius:10px;background:#4a7fe0"></div>
      <h2>Hand the device to ${esc(name)}</h2>
      <div class="sub" style="font-size:16px">No peeking — their half of the fog comes up next.</div>
      <button class="paper-btn primary" style="font-size:17px;padding:13px 32px" data-act="take-seat">I'm ${esc(name)} — show my board</button>
    </div>
  </div>`;
}

function renderTopbar(v) {
  const m = S.sync.match;
  const live = m.pacing === 'live' && m.deadline;
  const phase = v.winner ? 'Match over' : 'Planning';
  const opp = S.sync.opp;
  const oppState = !opp?.connected ? `${esc(oppName())} disconnected`
    : opp.locked ? `${esc(oppName())} locked in`
    : `${esc(oppName())} is planning…`;
  const oppPulse = opp?.connected && !opp.locked ? 'animation:sdPulse 1.8s ease-in-out infinite;' : '';
  return `
  <div class="topbar">
    <div class="brand">
      <div class="mark"></div>
      <div class="word">SIGNAL DOMINION</div>
      <div class="code">${esc(m.code)}</div>
    </div>
    <div style="display:flex;align-items:center;gap:16px">
      <div class="turn-pill">
        <div class="t">Turn ${v.turn}</div>
        <div class="sep"></div>
        <div class="phase">${phase}</div>
        ${live ? `<div class="clock" id="clock">--:--</div>` : `<div class="clock" style="color:var(--muted)">async</div>`}
      </div>
      ${live ? `<div class="clock-track"><div class="fill" id="clockbar" style="width:100%"></div></div>` : ''}
    </div>
    <div class="right">
      <div class="me">
        <div class="dot" style="background:#4a7fe0"></div>
        <span style="font-size:15px">${esc(v.you.name)}</span>
        <span class="funds">§${v.you.funding}</span>
        <span class="delta">${v.you.income >= 0 ? '+' : ''}${v.you.income}/turn</span>
      </div>
      <div class="opp">
        <div class="dot" style="background:#e0803f;${oppPulse}"></div>
        <span>${oppState}</span>
      </div>
    </div>
  </div>`;
}

function renderRail(v) {
  const tabs = [
    ['map', 'Map', 'border-radius:6px'],
    ['orbit', 'Orbit', 'border-radius:50%'],
    ['intel', 'Intel', 'border-radius:3px'],
    ['log', 'Report', 'border-radius:4px'],
  ];
  return `
  <div class="rail">
    ${tabs.map(([k, label, glyph]) => `
      <button class="tab ${S.ui.tab === k ? 'active' : ''}" data-act="tab" data-arg="${k}">
        <div class="glyph" style="${glyph}"></div><span>${label}</span>
      </button>`).join('')}
    <div class="spring"></div>
    <div class="threats"><div class="k">Threats</div><div class="v">${v.you.alerts.length}</div></div>
  </div>`;
}

function unitBadges(v, id) {
  const here = unitsAt(id);
  const mine = mySide();
  const parts = [];
  const mySw = here.filter((u) => u.type === 'swarm' && u.owner === mine).reduce((s, u) => s + (u.strength || 0), 0);
  const enSw = here.filter((u) => u.type === 'swarm' && u.owner !== mine).reduce((s, u) => s + (u.strength || 0), 0);
  const myWorms = here.filter((u) => u.type === 'worm' && u.owner === mine).length;
  const enWorms = here.filter((u) => u.type === 'worm' && u.owner !== mine).length;
  if (mySw) parts.push(`<span class="ubadge" style="color:#9dc1f7">▲${mySw}</span>`);
  if (enSw) parts.push(`<span class="ubadge" style="color:#f0a58f">▲${enSw}</span>`);
  if (myWorms) parts.push(`<span class="ubadge" style="color:#c9a8ef">◆${myWorms}</span>`);
  if (enWorms) parts.push(`<span class="ubadge" style="color:#e8a0d2">◆!</span>`);
  return parts.length ? `<div class="unitrow">${parts.join('')}</div>` : '';
}

function renderMap(v) {
  const mine = mySide();
  const alertRegions = new Set(v.you.alerts.map((a) => a.region).filter(Boolean));
  const hexes = Object.values(v.regions).map((r) => {
    const own = r.owner;
    const fill = own === mine ? '#2f4f8f' : own ? '#6b4326' : '#222c3b';
    const stroke = r.id === S.ui.selected ? '#ffffff' : own === mine ? '#5b8ff0' : own ? '#c98a5c' : '#37445a';
    const text = own ? '#f2f5fa' : '#aab5c5';
    const sub = own ? 'rgba(242,245,250,.7)' : '#77839a';
    let subline = 'unclaimed';
    if (own === mine) subline = `${r.garrison ?? 0} def`;
    else if (own) subline = r.visible ? `${r.garrison} def` : '? def';
    const dots = (r.nodes || r.intel?.nodes || []).slice(0, 4)
      .map((n) => `<i style="background:${NODE_META[n.type].color}"></i>`).join('');
    return `
    <div class="hex" data-act="hex" data-arg="${r.id}" style="left:${r.x}px;top:${r.y}px;background:${stroke}">
      <div class="inner" style="background:${fill}">
        <div class="rname" style="color:${text}">${esc(r.name)}</div>
        <div class="dots">${dots}</div>
        <div class="sub" style="color:${sub}">${subline}</div>
        ${unitBadges(v, r.id)}
      </div>
      ${alertRegions.has(r.id) ? '<div class="alert-dot"></div>' : ''}
      ${(r.isolated || r.reconnecting > 0) ? '<div class="iso"></div>' : ''}
    </div>`;
  }).join('');

  const topAlert = v.you.alerts[0];
  return `
  <div class="mapwrap">
    <div class="mapscale" id="mapscale">${hexes}</div>
    <div class="legend">
      <div class="item"><div class="sw" style="background:#2f4f8f;border:1px solid #6d9bf0"></div>Yours</div>
      <div class="item"><div class="sw" style="background:#6b4326;border:1px solid #e0a06f"></div>${esc(oppName())}</div>
      <div class="item"><div class="sw" style="background:#222c3b;border:1px solid #3d4b60"></div>Unclaimed</div>
      <div class="sep"></div>
      <div class="item"><div class="sw" style="background:var(--amber);border-radius:50%;width:10px;height:10px"></div><span style="color:var(--ink-dim)">Something is coming</span></div>
    </div>
    ${topAlert ? `
    <div class="threat-card">
      <div class="head"><div class="dot"></div><div class="t">Heads up</div></div>
      <div class="body">${alertText(topAlert)}</div>
      <button data-act="focus-threat" data-arg="${esc(topAlert.region || '')}">See my options</button>
    </div>` : ''}
  </div>`;
}

function alertText(a) {
  const r = (id) => `<strong>${esc(regionName(id))}</strong>`;
  const turns = (n) => `${n} turn${n === 1 ? '' : 's'}`;
  switch (a.type) {
    case 'swarm': return `A swarm group (strength ${a.strength}) is heading for ${r(a.region)} from ${esc(regionName(a.at))}. It arrives in ${turns(a.eta)}.`;
    case 'worm': return `A stealth worm has been detected at ${esc(regionName(a.at))}, heading for ${r(a.region)} — ${turns(a.eta)} out. Defenders there can intercept it.`;
    case 'siege': return `Enemy units are inside ${r(a.region)}.`;
    case 'build': return `They are building a ${a.buildType} aimed at ${r(a.region)} — about ${turns(a.eta)} out.`;
    case 'anomaly': return `Something is being built against ${r(a.region)} — type unknown, ~${turns(a.eta)} out. It might also be a bluff.`;
    default: return '';
  }
}

function renderPickBanner() {
  const label = S.ui.pick.type === 'moveSat'
    ? 'Pick the region the satellite should watch'
    : 'Pick the region your new satellite should watch';
  return `<div class="pick-banner">${label} <button data-act="pick-cancel">cancel</button></div>`;
}

function renderOrbit(v) {
  const cards = [];
  const footprint = (id) => [id, ...(region(id)?.neighbors || [])].map(regionName).join(', ');
  for (const s of v.you.satellites) {
    const moving = v.you.builds.find((b) => b.kind === 'moveSat' && b.satId === s.id);
    cards.push(`
    <div class="orbit-card">
      <div class="row">
        <div class="who"><i style="background:#3f9c78"></i>Watcher over ${esc(regionName(s.region))}</div>
        <div class="chip" style="color:#3f9c78;background:#dff2ea">${moving ? `Moving · ${moving.turnsLeft} left` : 'Live'}</div>
      </div>
      <div class="detail">Covers ${esc(footprint(s.region))}. Worms crossing the footprint are spotted, and you see what's really inside it.</div>
      <div class="rule"></div>
      <div class="actions">
        <button class="paper-btn" data-act="movesat" data-arg="${s.id}" ${moving || locked() ? 'disabled' : ''}>Move coverage · §${RULES.costs.moveSat}</button>
        <button class="paper-btn" data-act="tab" data-arg="intel">What it sees</button>
      </div>
    </div>`);
  }
  for (const b of v.you.builds.filter((x) => x.kind === 'satellite')) {
    cards.push(`
    <div class="orbit-card">
      <div class="row">
        <div class="who"><i style="background:#c48a1e"></i>Launch in progress</div>
        <div class="chip" style="color:#c48a1e;background:#f8eed6">${b.turnsLeft} turn${b.turnsLeft === 1 ? '' : 's'} left</div>
      </div>
      <div class="detail">Building at ${esc(regionName(b.facility || b.region))}, headed for orbit over ${esc(regionName(b.target))}. ${esc(oppName())} can see this one coming — big launches are impossible to hide.</div>
      <div class="rule"></div>
      <div class="actions"><button class="paper-btn" data-act="cancel-build" data-arg="${b.id}" ${locked() ? 'disabled' : ''}>Cancel for §${Math.floor(b.cost * RULES.refundRate)} back</button></div>
    </div>`);
  }
  for (const b of v.you.builds.filter((x) => x.kind === 'asat')) {
    cards.push(`
    <div class="orbit-card">
      <div class="row">
        <div class="who"><i style="background:#d8624f"></i>Satellite killer in progress</div>
        <div class="chip" style="color:#d8624f;background:#fae0da">${b.turnsLeft} turn${b.turnsLeft === 1 ? '' : 's'} left</div>
      </div>
      <div class="detail">When it completes, its target satellite comes down the same turn.</div>
      <div class="rule"></div>
      <div class="actions"><button class="paper-btn" data-act="cancel-build" data-arg="${b.id}" ${locked() ? 'disabled' : ''}>Cancel for §${Math.floor(b.cost * RULES.refundRate)} back</button></div>
    </div>`);
  }
  for (const s of v.opponent.satellites) {
    cards.push(`
    <div class="orbit-card">
      <div class="row">
        <div class="who"><i style="background:#d8624f"></i>${esc(oppName())}'s eye over ${esc(regionName(s.region))}</div>
        <div class="chip" style="color:#d8624f;background:#fae0da">Watching you</div>
      </div>
      <div class="detail">Anything you move through ${esc(footprint(s.region))}, they see — including worms.</div>
      <div class="rule"></div>
      <div class="actions">
        <button class="paper-btn" data-act="asat" data-arg="${s.id}" ${(!facilityFree('LNC') || budgetLeft() < RULES.costs.asat || locked()) ? 'disabled' : ''}>Build a satellite killer · §${RULES.costs.asat}</button>
      </div>
    </div>`);
  }
  for (const b of v.opponent.builds.filter((x) => x.kind === 'satellite')) {
    cards.push(`
    <div class="orbit-card">
      <div class="row">
        <div class="who"><i style="background:#e0803f"></i>${esc(oppName())} is launching a satellite</div>
        <div class="chip" style="color:#c48a1e;background:#f8eed6">${b.turnsLeft} turn${b.turnsLeft === 1 ? '' : 's'} left</div>
      </div>
      <div class="detail">Where it will look is their secret. If you want it gone, a satellite killer takes ${RULES.turns.asat} turns — start counting.</div>
    </div>`);
  }
  const detect = new Set(v.you.detect);
  const blind = Object.values(v.regions).filter((r) => isMine(r) && !detect.has(r.id)).map((r) => r.name);
  if (blind.length) {
    cards.push(`
    <div class="orbit-card">
      <div class="row">
        <div class="who"><i style="background:#8d99ab"></i>Blind spots</div>
        <div class="chip" style="color:#6c7688;background:#eceae4">No worm detection</div>
      </div>
      <div class="detail">Nothing covers ${esc(blind.slice(0, 5).join(', '))}${blind.length > 5 ? '…' : ''}. A worm could cross there without you ever knowing. Analysts cover their region and neighbours; satellites cover anywhere.</div>
    </div>`);
  }
  return `
  <div class="pane">
    <div>
      <div class="pane-title">Orbital layer</div>
      <div class="pane-sub">Satellites watch a patch of the map and spot stealthy worms passing through it. Everyone can see you launching one.</div>
    </div>
    <div class="grid2">${cards.join('') || '<div class="pane-sub">Nothing in orbit yet. Build a satellite from an enemy or neutral region\'s panel — you\'ll need a launch facility.</div>'}</div>
  </div>`;
}

function renderIntel(v) {
  const enemyRegions = Object.values(v.regions).filter((r) => isEnemy(r));
  const sight = new Set(v.you.sight);
  const cards = enemyRegions
    .map((r) => {
      const live = sight.has(r.id) && r.nodes;
      const intel = r.intel;
      const age = live ? 0 : intel?.age ?? null;
      const nodes = live ? r.nodes : intel?.nodes || [];
      let ageText;
      let ageColor;
      let opacity;
      if (live) { ageText = 'Live now'; ageColor = '#3f9c78'; opacity = 1; }
      else if (age === null) { ageText = 'Never scouted'; ageColor = '#8b93a1'; opacity = 0.62; }
      else { ageText = `Scouted ${age} turn${age === 1 ? '' : 's'} ago`; ageColor = age > 4 ? '#c25b46' : '#a07a24'; opacity = age > 4 ? 0.62 : 0.85; }
      let summary;
      if (live) summary = `${r.garrison} defender${r.garrison === 1 ? '' : 's'} stationed. This is what's really there, right now.`;
      else if (age === null) summary = 'You have never had eyes on this region. Analysts see neighbours; satellites see anywhere.';
      else if (age > 4) summary = 'Old picture — treat this as a guess. They have had plenty of time to change it.';
      else summary = `${intel.garrison} defender${intel.garrison === 1 ? '' : 's'} when you last looked.`;
      const chips = nodes.map((n) => `<span>${NODE_META[n.type].label}</span>`).join('');
      return { sort: live ? -1 : age ?? 99, html: `
      <div class="intel-card" style="opacity:${opacity}" data-act="hex" data-arg="${r.id}">
        <div class="row"><div class="name">${esc(r.name)}</div><div class="age" style="color:${ageColor}">${ageText}</div></div>
        <div class="summary">${summary}</div>
        <div class="chips">${chips}</div>
      </div>` };
    })
    .sort((a, b) => a.sort - b.sort)
    .map((c) => c.html)
    .join('');
  return `
  <div class="pane">
    <div>
      <div class="pane-title">What you know about ${esc(oppName())}</div>
      <div class="pane-sub">These are snapshots, not live views. The older a card is, the less you should trust it.</div>
    </div>
    <div class="grid3">${cards || '<div class="pane-sub">They hold no regions. That went well.</div>'}</div>
  </div>`;
}

function renderLog(v) {
  const log = S.sync.log || [];
  const items = log.map((e) => `
    <div class="log-item">
      <div class="dot" style="background:${e.color || '#8d99ab'}"></div>
      <div style="flex:1"><div class="t">${esc(e.title)}</div><div class="d">${esc(e.detail)}</div></div>
      <div class="step">step ${e.step}</div>
    </div>`).join('');
  return `
  <div class="pane">
    <div>
      <div class="pane-title">Last turn's report</div>
      <div class="pane-sub">Everything that happened when turn ${v.turn - 1} resolved, in the order it happened.</div>
    </div>
    <div class="log-list">${items || '<div class="pane-sub">Nothing yet — finish your first turn.</div>'}</div>
  </div>`;
}

// ---- sidebar --------------------------------------------------------------

function renderSidebar(v) {
  const id = S.ui.selected || v.you.capital;
  const r = region(id);
  if (!r) return '<div class="sidebar"></div>';
  const mine = isMine(r);
  const enemy = isEnemy(r);
  const sight = new Set(v.you.sight);
  const live = sight.has(id);

  const ownerColor = mine ? '#4a7fe0' : enemy ? '#e0803f' : '#8d99ab';
  let status;
  if (mine) {
    status = r.isolated ? 'Yours · currently cut off from your network'
      : r.reconnecting > 0 ? `Yours · reconnecting (${r.reconnecting} turn${r.reconnecting === 1 ? '' : 's'} left)`
      : r.connected ? 'Yours · connected to your capital'
      : 'Yours · CUT OFF from your capital — it will degrade';
  } else if (enemy) {
    status = live ? `${esc(oppName())}'s · you have live eyes on it`
      : r.intel ? `${esc(oppName())}'s · last scouted ${r.intel.age} turn${r.intel.age === 1 ? '' : 's'} ago`
      : `${esc(oppName())}'s · never scouted`;
  } else {
    const borders = r.neighbors.some((n) => isMine(region(n)));
    status = `Unclaimed${borders ? ' · borders your network' : ''}`;
  }

  const nodes = (r.nodes || r.intel?.nodes || []);
  const nodeRows = nodes.length ? nodes.map((n) => {
    const meta = NODE_META[n.type];
    const pct = n.hpPct ?? Math.round((n.hp / n.maxHp) * 100);
    const hpText = (mine || live) ? `${pct}% healthy` : r.intel ? `${pct}% when seen` : 'unknown';
    return `
    <div class="node-row">
      <div class="icon" style="background:${meta.tint}"><i style="background:${meta.color}"></i></div>
      <div class="meta">
        <div class="top"><span class="label">${meta.label}</span><span class="hp-text">${hpText}</span></div>
        <div class="track"><div class="fill" style="background:${meta.color};width:${pct}%"></div></div>
      </div>
    </div>`;
  }).join('') : `
    <div class="node-row">
      <div class="icon" style="background:#eceae4"><i style="background:#8d99ab"></i></div>
      <div class="meta"><div class="top"><span class="label" style="color:#8b93a1">${(mine || live) ? 'Nothing built here yet' : 'Contents unknown'}</span></div></div>
    </div>`;

  const garrison = (mine || live) ? (r.garrison ?? 0) : r.intel ? `${r.intel.garrison}?` : 'unknown';

  const fighters = unitsAt(id).filter((u) => u.type !== 'bot');
  const unitRows = fighters.length ? `
    <div class="kv"><span>Units here</span><b>${fighters.map((u) => {
      const who = u.owner === mySide() ? 'your' : 'their';
      return u.type === 'swarm' ? `${who} swarm (${u.strength})` : `${who} worm`;
    }).join(', ')}</b></div>` : '';

  const alerts = v.you.alerts.filter((a) => a.region === id);
  const threatCards = alerts.map((a) => `
    <div class="warn-card">
      <div class="t">${a.type === 'anomaly' ? 'Something is being built against this region' : a.type === 'swarm' ? `A swarm group is ${a.eta} turn${a.eta === 1 ? '' : 's'} away` : a.type === 'worm' ? `A worm is ${a.eta} turn${a.eta === 1 ? '' : 's'} away` : a.type === 'build' ? `Incoming ${a.buildType} build` : 'Enemy units are inside'}</div>
      <div class="d">${alertText(a).replace(/<[^>]+>/g, '')}</div>
    </div>`).join('');

  const builds = v.you.builds.filter((b) => b.region === id || b.facility === id || b.target === id);
  const buildRows = builds.length ? `
  <div class="side-sec">
    <div class="eyebrow">UNDERWAY</div>
    ${builds.map((b) => `
      <div class="kv"><span>${buildLabel(b)}</span>
        <span style="display:flex;gap:10px;align-items:center"><b>${b.turnsLeft} turn${b.turnsLeft === 1 ? '' : 's'} left</b>
        <button class="paper-btn" style="padding:4px 12px;font-size:13px" data-act="cancel-build" data-arg="${b.id}" ${locked() ? 'disabled' : ''}>Cancel · §${Math.floor(b.cost * RULES.refundRate)} back</button></span>
      </div>`).join('')}
  </div>` : '';

  return `
  <div class="sidebar">
    <div class="head">
      <div class="row"><div class="sw" style="background:${ownerColor}"></div><div class="name">${esc(r.name)}</div></div>
      <div class="status">${status}</div>
    </div>
    <div class="scroll">
      <div class="side-sec">
        <div class="eyebrow">WHAT'S HERE</div>
        ${nodeRows}
        <div class="kv"><span>Defenders stationed</span><b>${garrison}</b></div>
        ${unitRows}
      </div>
      ${threatCards}
      ${buildRows}
      <div class="side-sec">
        <div class="eyebrow">WHAT YOU CAN DO HERE</div>
        ${renderActions(v, r)}
      </div>
    </div>
  </div>`;
}

function buildLabel(b) {
  switch (b.kind) {
    case 'claim': return `Claiming ${regionName(b.region)}`;
    case 'node': return `Building ${NODE_META[b.type].label.toLowerCase()}`;
    case 'bots': return `Training ${b.count} defender${b.count === 1 ? '' : 's'}`;
    case 'swarm': return `Swarm → ${regionName(b.target)}`;
    case 'worm': return `Worm → ${regionName(b.target)}`;
    case 'satellite': return `Satellite → ${regionName(b.target)}`;
    case 'asat': return 'Satellite killer';
    case 'moveSat': return `Satellite → ${regionName(b.target)}`;
    default: return b.kind;
  }
}

function actionBtn({ act, arg, label, detail, cost, time, color, disabled, why }) {
  return `
  <button class="action-btn" data-act="${act}" ${arg ? `data-arg="${esc(arg)}"` : ''} ${disabled ? 'disabled' : ''} ${why ? `title="${esc(why)}"` : ''}>
    <div class="sw" style="background:${color}"></div>
    <div class="mid"><div class="label">${label}</div><div class="detail">${detail}</div></div>
    <div class="cost">${cost}<br>${time}</div>
  </button>`;
}

function renderActions(v, r) {
  if (v.winner) return '<div style="font-size:14px;color:#8b93a1">The match is over.</div>';
  if (locked()) return '<div style="font-size:14px;color:#8b93a1">Orders are locked in. Waiting for the turn to resolve.</div>';
  const c = RULES.costs;
  const t = RULES.turns;
  const left = budgetLeft();
  const out = [];
  const mine = isMine(r);
  const id = r.id;

  if (mine) {
    const cutOff = r.isolated;
    const sources = r.neighbors
      .map((n) => region(n))
      .filter((n) => isMine(n) && (n.garrison ?? 0) > 0 && !n.isolated);
    out.push(actionBtn({
      act: 'reinforce-menu', label: 'Send defenders here', detail: 'Pull bots from a neighbouring region',
      cost: '§0', time: '1 turn', color: '#4a7fe0',
      disabled: cutOff || r.reconnecting > 0 || !sources.length,
      why: cutOff || r.reconnecting > 0 ? 'This region cannot receive units right now' : !sources.length ? 'No neighbouring defenders available' : '',
    }));
    if (S.ui.reinforceMenu && sources.length && !cutOff && r.reconnecting === 0) {
      out.push(`<div class="sub-actions">${sources.map((n) => {
        const pendingFrom = S.ui.pending.filter((o) => o.kind === 'move_bots' && o.from === n.id).reduce((s, o) => s + o.count, 0);
        const avail = (n.garrison ?? 0) - pendingFrom;
        return `<button class="paper-btn" data-act="reinforce" data-arg="${n.id}" ${avail < 1 ? 'disabled' : ''}>+1 from ${esc(n.name)} (${avail} available)</button>`;
      }).join('')}</div>`);
    }
    if ((r.nodes || []).some((n) => n.type === 'INF')) {
      out.push(actionBtn({
        act: 'train', label: 'Train a defender', detail: 'The garrison here builds one infantry bot',
        cost: `§${c.bot}`, time: '1 turn', color: '#4a7fe0',
        disabled: cutOff || r.reconnecting > 0 || left < c.bot,
      }));
    }
    out.push(actionBtn({
      act: cutOff ? 'reconnect' : 'isolate',
      label: cutOff ? 'Reconnect this region' : 'Cut this region off',
      detail: cutOff
        ? `Takes ${RULES.reconnectTurns} turns — vulnerable and unsupported until done`
        : 'Nothing gets in — but nothing gets out either, and reconnecting takes 2 turns',
      cost: '§0', time: cutOff ? `${RULES.reconnectTurns} turns` : 'now', color: '#e8b53f',
      disabled: S.ui.pending.some((o) => (o.kind === 'isolate' || o.kind === 'reconnect') && o.region === id),
    }));
    const sweepCost = analystNear(id) ? c.sweep : c.sweepFar;
    out.push(actionBtn({
      act: 'sweep', label: 'Sweep for malware', detail: `Clear anything hiding here. ${analystNear(id) ? 'Your analyst nearby makes this cheap' : 'Cheaper with an analyst nearby'}`,
      cost: `§${sweepCost}`, time: '1 turn', color: '#8f5fc7', disabled: left < sweepCost,
    }));
    out.push(actionBtn({
      act: 'build-menu', label: 'Build something new', detail: 'Add a finance hub, garrison, analyst post, ops centre or launch facility',
      cost: `from §${c.node.INF}`, time: '2–4 turns', color: '#3f9c78',
      disabled: cutOff || r.reconnecting > 0 || (r.nodes || []).length >= RULES.maxNodesPerRegion,
      why: (r.nodes || []).length >= RULES.maxNodesPerRegion ? 'Region is full' : '',
    }));
    if (S.ui.buildMenu && !cutOff && r.reconnecting === 0) {
      out.push(`<div class="sub-actions">${['FIN', 'INF', 'ANL', 'OPS', 'LNC'].map((type) => `
        <button class="paper-btn" data-act="build-node" data-arg="${type}" ${left < c.node[type] ? 'disabled' : ''}>
          ${NODE_META[type].label} · §${c.node[type]} · ${t.node[type]} turns
        </button>`).join('')}</div>`);
    }
  } else {
    const enemy = isEnemy(r);
    if (!enemy) {
      const conn = r.neighbors.some((n) => { const nn = region(n); return isMine(nn) && nn.connected; });
      out.push(actionBtn({
        act: 'claim', label: 'Claim this region', detail: 'Must border your network. Nobody can leapfrog',
        cost: `§${c.claim}`, time: `${t.claim} turns`, color: '#4a7fe0',
        disabled: !conn || left < c.claim,
        why: !conn ? 'Not adjacent to your connected network' : '',
      }));
    }
    out.push(actionBtn({
      act: 'swarm', label: 'Send a swarm here', detail: 'Cheap and numerous. Travels one region per turn and can be seen coming',
      cost: `§${c.swarm}`, time: `${t.swarm} turns to build`, color: '#d8624f',
      disabled: !facilityFree('OPS') || left < c.swarm,
      why: !facilityFree('OPS') ? 'Every cyber ops centre is busy (or you have none)' : '',
    }));
    if (enemy) {
      out.push(actionBtn({
        act: 'worm', label: 'Send a worm here', detail: 'Slow and expensive, but invisible unless they have eyes on the route',
        cost: `§${c.worm}`, time: `${t.worm} turns to build`, color: '#d8624f',
        disabled: !facilityFree('OPS') || left < c.worm,
        why: !facilityFree('OPS') ? 'Every cyber ops centre is busy (or you have none)' : '',
      }));
    }
    out.push(actionBtn({
      act: 'satellite', label: 'Put a satellite overhead', detail: enemy ? 'See what is really in here, and spot worms passing through' : 'Watch the crossroads before they use it',
      cost: `§${c.satellite}`, time: `${t.satellite} turns`, color: '#c48a1e',
      disabled: !facilityFree('LNC') || left < c.satellite,
      why: !facilityFree('LNC') ? 'Every launch facility is busy (or you have none)' : '',
    }));
  }
  return out.join('');
}

function renderOrderbar(v) {
  const isLocked = locked();
  const spend = pendingSpend();
  const over = spend > v.you.funding;
  const chips = S.ui.pending.map((o, i) => {
    const chip = orderChip(o);
    return `
    <div class="order-chip" style="border-color:${chip.color}33">
      <div class="sw" style="background:${chip.color}"></div>
      <div><div class="l">${chip.label}</div><div class="m">${chip.meta}</div></div>
      ${!isLocked ? `<button data-act="unqueue" data-arg="${i}">×</button>` : ''}
    </div>`;
  }).join('');
  return `
  <div class="orderbar">
    <div class="left">
      <div class="eyebrow">${isLocked ? 'LOCKED IN THIS TURN' : "THIS TURN YOU'RE COMMITTING TO"}</div>
      <div class="chips">${chips || `<div class="none">${isLocked ? 'No orders this turn.' : 'No orders yet — pick a region on the map and choose an action.'}</div>`}</div>
    </div>
    <div class="right">
      <div class="spendline">Spending this turn <b class="${over ? 'over' : ''}">§${spend}</b> of §${v.you.funding}</div>
      ${v.winner
    ? `<button class="lock-btn locked" data-act="show-result">Match over — view result</button>`
    : isLocked
      ? `<button class="lock-btn locked" disabled>Locked — waiting for ${esc(oppName())}</button>`
      : `<button class="lock-btn" data-act="lock" ${over ? 'disabled' : ''}>Lock in orders</button>`}
    </div>
  </div>`;
}

function renderResolve(v) {
  const { turn, log } = S.ui.resolve;
  const counts = {};
  for (const e of log) counts[e.step] = (counts[e.step] || 0) + 1;
  const firstTitle = {};
  for (const e of log) if (!firstTitle[e.step]) firstTitle[e.step] = e.title;
  return `
  <div class="overlay">
    <div class="resolve-card">
      <div>
        <h2>Both sides locked in — turn ${turn} resolved</h2>
        <div class="sub">Orders always resolve in the same order, so nobody gets an advantage from acting first.</div>
      </div>
      <div class="bar"><i></i></div>
      <div class="steps">
        ${RESOLUTION_STEPS.map((s) => {
    const active = counts[s.n] > 0;
    return `
        <div class="step" style="background:${active ? '#eceae4' : 'transparent'}">
          <div class="n" style="background:${active ? '#4a7fe0' : '#b8bcc4'}">${s.n}</div>
          <div class="l" style="color:${active ? '#1b2029' : '#6c7688'}">${s.label}</div>
          <div class="note">${active ? (counts[s.n] === 1 ? firstTitle[s.n] : `${counts[s.n]} events`) : '—'}</div>
        </div>`;
  }).join('')}
      </div>
      <div class="foot"><button class="paper-btn primary" data-act="see-report" style="font-size:17px;padding:13px 32px">See what happened</button></div>
    </div>
  </div>`;
}

function renderGameOver(v) {
  const mine = v.winner === mySide();
  const title = v.winner === 'draw' ? 'The match is a draw' : mine ? 'You won' : `${esc(oppName())} won`;
  return `
  <div class="overlay">
    <div class="resolve-card" style="width:520px;text-align:center;align-items:center">
      <div style="width:44px;height:44px;border-radius:14px;background:${v.winner === 'draw' ? '#8d99ab' : mine ? '#4a7fe0' : '#e0803f'}"></div>
      <h2>${title}</h2>
      <div class="sub" style="font-size:16px">${esc(v.winReason || '')} · ${v.turn - 1} turns played.</div>
      <div style="display:flex;gap:10px">
        <button class="paper-btn" data-act="see-final">Review the final report</button>
        <button class="paper-btn primary" data-act="leave">Leave match</button>
      </div>
    </div>
  </div>`;
}

// --------------------------------------------------------------------------
// Events
// --------------------------------------------------------------------------

$app.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const arg = el.dataset.arg;
  const act = el.dataset.act;
  const sel = () => S.ui.selected;

  switch (act) {
    case 'create': {
      const name = readName();
      if (!name) return;
      send({ t: 'create', name, pacing: document.getElementById('pacing-in')?.value || 'live' });
      break;
    }
    case 'join': {
      const name = readName();
      if (!name) return;
      const code = document.getElementById('code-in')?.value.trim().toUpperCase();
      if (!code) { S.err = 'Enter the 4-letter match code.'; render(); return; }
      send({ t: 'join', name, code });
      break;
    }
    case 'quick': {
      const name = readName();
      if (!name) return;
      send({ t: 'quick', name });
      break;
    }
    case 'local': {
      const p1 = (document.getElementById('name-in')?.value || S.name || '').trim() || 'Player 1';
      const p2 = (document.getElementById('name2-in')?.value || '').trim() || 'Player 2';
      S.name = p1;
      localStorage.setItem('sd_name', p1);
      startLocal(p1, p2);
      break;
    }
    case 'take-seat': takeSeat(S.localHandoff); break;
    case 'ready': send({ t: 'ready', ready: !S.sync.you.ready }); break;
    case 'leave':
      localStorage.removeItem('sd_token');
      location.assign(HERE);
      break;
    case 'copy-link':
      navigator.clipboard?.writeText(`${HERE}?code=${S.sync.match.code}`);
      el.textContent = 'Copied!';
      break;
    case 'tab': S.ui.tab = arg; S.ui.resolve = null; render(); break;
    case 'hex': {
      if (S.ui.pick) {
        const pick = S.ui.pick;
        S.ui.pick = null;
        if (pick.type === 'sat') addOrder({ kind: 'build_satellite', target: arg });
        else if (pick.type === 'moveSat') addOrder({ kind: 'move_satellite', sat: pick.sat, target: arg });
        S.ui.tab = 'map';
        render();
        return;
      }
      S.ui.selected = arg;
      S.ui.buildMenu = false;
      S.ui.reinforceMenu = false;
      S.ui.tab = 'map';
      render();
      break;
    }
    case 'focus-threat': if (arg) { S.ui.selected = arg; S.ui.tab = 'map'; render(); } break;
    case 'pick-cancel': S.ui.pick = null; render(); break;

    // region actions
    case 'reinforce-menu': S.ui.reinforceMenu = !S.ui.reinforceMenu; render(); break;
    case 'reinforce': addOrder({ kind: 'move_bots', from: arg, to: sel(), count: 1, maxCount: region(arg)?.garrison ?? 1 }); break;
    case 'train': addOrder({ kind: 'train_bots', region: sel(), count: 1 }); break;
    case 'isolate': addOrder({ kind: 'isolate', region: sel() }); break;
    case 'reconnect': addOrder({ kind: 'reconnect', region: sel() }); break;
    case 'sweep': addOrder({ kind: 'sweep', region: sel() }); break;
    case 'build-menu': S.ui.buildMenu = !S.ui.buildMenu; render(); break;
    case 'build-node': addOrder({ kind: 'build_node', region: sel(), type: arg }); break;
    case 'claim': addOrder({ kind: 'claim', region: sel() }); break;
    case 'swarm': addOrder({ kind: 'build_swarm', target: sel() }); break;
    case 'worm': addOrder({ kind: 'build_worm', target: sel() }); break;
    case 'satellite': addOrder({ kind: 'build_satellite', target: sel() }); break;
    case 'movesat': S.ui.pick = { type: 'moveSat', sat: Number(arg) }; S.ui.tab = 'map'; render(); break;
    case 'asat': addOrder({ kind: 'build_asat', targetSat: Number(arg) }); break;
    case 'cancel-build': {
      const b = view().you.builds.find((x) => x.id === Number(arg));
      if (b && !S.ui.pending.some((o) => o.kind === 'cancel_build' && o.build === b.id)) {
        addOrder({ kind: 'cancel_build', build: b.id, label: buildLabel(b), refund: Math.floor(b.cost * RULES.refundRate) });
      }
      break;
    }
    case 'unqueue': S.ui.pending.splice(Number(arg), 1); render(); break;
    case 'lock': lockIn(); break;
    case 'see-report': S.ui.resolve = null; S.ui.tab = 'log'; render(); break;
    case 'see-final': S.ui.hideOver = true; S.ui.resolve = null; S.ui.tab = 'log'; render(); break;
    case 'show-result': S.ui.hideOver = false; render(); break;
    default: break;
  }
});

$app.addEventListener('input', (ev) => {
  if (ev.target.id === 'name-in') {
    S.name = ev.target.value;
    localStorage.setItem('sd_name', S.name);
  }
});

function readName() {
  const el = document.getElementById('name-in');
  const name = (el?.value || S.name || '').trim();
  if (!name) {
    S.err = 'Pick a display name first.';
    render();
    return null;
  }
  S.name = name;
  localStorage.setItem('sd_name', name);
  return name;
}

// --------------------------------------------------------------------------
// Layout + clock
// --------------------------------------------------------------------------

function fitMap() {
  const scaleEl = document.getElementById('mapscale');
  if (!scaleEl) return;
  const wrap = scaleEl.parentElement;
  const availW = wrap.clientWidth - 50;
  const availH = wrap.clientHeight - 110;
  const scale = Math.min(1, availW / 880, availH / 545);
  scaleEl.style.transform = `scale(${scale})`;
}

function afterRender() {
  fitMap();
}
window.addEventListener('resize', fitMap);

setInterval(() => {
  const m = S.sync?.match;
  if (!m || m.phase !== 'planning' || m.pacing !== 'live' || !m.deadline) return;
  const remaining = Math.max(0, m.deadline - Date.now());
  const secs = Math.ceil(remaining / 1000);
  const clock = document.getElementById('clock');
  if (clock) clock.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const bar = document.getElementById('clockbar');
  if (bar) bar.style.width = `${Math.min(100, (remaining / (m.planningSeconds * 1000)) * 100)}%`;
  if (remaining < 1500 && !locked() && !S.ui.autoLocked && view() && !view().winner) {
    S.ui.autoLocked = true;
    lockIn(); // send whatever is queued before the deadline hits
  }
}, 400);

connect();
