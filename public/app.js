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
import { NODE_META, RULES, RESOLUTION_STEPS, VERSION } from '../shared/constants.js';
import { Match } from '../shared/match.js';
import { pathOn, MAPS, DEFAULT_MAP } from '../shared/map.js';
import { aiOrders } from './ai.js';
import { icon, logoMark, FAVICON } from './icons.js';
import { ensureAudio, sfx, soundOn, toggleSound } from './audio.js';

const SAVE_KEY = 'sd_local_save';

document.head.insertAdjacentHTML('beforeend', `<link rel="icon" href="${FAVICON}">`);
// Browsers unlock audio on the first gesture; after that it's a cheap no-op.
window.addEventListener('pointerdown', () => ensureAudio());

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
    pick: null,        // {type:'moveSat', sat} | {type:'retarget', unit}
    buildMenu: false,
    reinforceMenu: false,
    decomMenu: false,
    attackMenu: null,  // 'swarm' | 'worm' — origin picker when several ops are idle
    resolve: null,     // {turn, log} — resolution overlay
    toast: null,
    autoLocked: false,
    hideOver: false,
    sawMap: true,      // has the player looked at the map since the last resolution?
    lockConfirm: false,
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
        requeueStanding();
        S.ui.autoLocked = false;
        S.ui.sawMap = S.ui.tab === 'map';
        S.ui.lockConfirm = false;
        S.ui.resolve = { turn: msg.view.turn - 1, log: msg.log || [] };
        resolveSounds(msg.view, msg.log || []);
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

let local = null; // { match, ai, seats: {A: {sync, pendingResolve}, B: {...}} }

function startLocal(nameA, nameB, { ai = false, aiLevel = 'ruthless', restored = null, map = undefined } = {}) {
  local = { match: new Match('LOCAL', 'relaxed', restored?.map || map), ai, aiLevel, aiPending: false, seats: { A: {}, B: {} } };
  S.localSeat = 'A';
  S.localHandoff = null;
  S.joined = { code: 'LOCAL', side: 'A', token: null };
  Object.assign(S.ui, {
    tab: 'map', selected: null, pending: [], pick: null, buildMenu: false,
    reinforceMenu: false, decomMenu: false, attackMenu: null, resolve: null,
    hideOver: false, sawMap: true, lockConfirm: false, autoLocked: false,
  });
  const fakeWs = (side) => ({ readyState: 1, send: (json) => deliverLocal(side, JSON.parse(json)) });
  local.match.addPlayer(fakeWs('A'), nameA, 'seat-a');
  local.match.addPlayer(fakeWs('B'), nameB, 'seat-b');
  if (restored) {
    local.match.state = restored;
    local.match.phase = restored.winner ? 'over' : 'planning';
    if (restored.winner) local.match.syncAll();
    else local.match.startPlanning();
  } else {
    local.match.setReady('A', true);
    local.match.setReady('B', true); // both ready → the match starts immediately
  }
}

function saveLocal() {
  if (!local?.match?.state) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      v: VERSION,
      ai: local.ai,
      aiLevel: local.aiLevel,
      names: { A: local.match.players.A.name, B: local.match.players.B.name },
      state: local.match.state,
    }));
  } catch { /* private mode / storage full — the game still runs */ }
}

function loadLocalSave() {
  try {
    const save = JSON.parse(localStorage.getItem(SAVE_KEY));
    return save?.state?.regions ? save : null;
  } catch {
    return null;
  }
}

function deliverLocal(side, msg) {
  if (msg.t !== 'sync') return;
  const seat = local.seats[side];
  seat.sync = msg;
  if (msg.resolved && msg.view) {
    seat.pendingResolve = { turn: msg.view.turn - 1, log: msg.log || [] };
  }
  saveLocal(); // hot-seat games survive reloads and can be exported
  // The Daemon plays seat B: as soon as it sees a planning view, it locks in.
  if (local.ai && side === 'B' && msg.match.phase === 'planning' && !msg.you.locked && !local.aiPending) {
    local.aiPending = true;
    setTimeout(() => {
      local.aiPending = false;
      const m = local?.match;
      if (m && m.phase === 'planning' && !m.players.B.locked && local.seats.B.sync?.view) {
        m.lockOrders('B', aiOrders(local.seats.B.sync.view, local.aiLevel));
      }
    }, 60);
  }
  if (side === S.localSeat && !S.localHandoff) applyLocalSync(side);
}

function applyLocalSync(side) {
  const seat = local.seats[side];
  if (!seat.sync) return;
  S.sync = seat.sync;
  if (seat.pendingResolve) {
    S.ui.pending = [];
    requeueStanding();
    S.ui.sawMap = S.ui.tab === 'map';
    S.ui.lockConfirm = false;
    S.ui.resolve = seat.pendingResolve;
    resolveSounds(seat.sync.view, seat.pendingResolve.log);
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
    // their move — put up the handoff cover. Never against the Daemon: it
    // locks on its own within a moment.
    if (!local.ai && m.phase === 'planning' && m.players[S.localSeat].locked) {
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
  S.ui.decomMenu = false;
  S.ui.attackMenu = null;
  S.ui.resolve = null;
  S.ui.pick = null;
  S.ui.selected = null;
  S.ui.tab = 'map';
  S.ui.sawMap = true;
  S.ui.lockConfirm = false;
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
    case 'repair': return o.estCost || 0;
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

// Regions with at least one ops centre that isn't already building something.
function idleOpsRegions() {
  const v = view();
  const load = {};
  for (const b of v.you.builds) {
    if (b.kind === 'swarm' || b.kind === 'worm') load[b.facility] = (load[b.facility] || 0) + 1;
  }
  for (const o of S.ui.pending) {
    if (o.kind === 'build_swarm' || o.kind === 'build_worm') load[o.facility] = (load[o.facility] || 0) + 1;
  }
  const out = [];
  for (const r of Object.values(v.regions)) {
    if (!isMine(r) || !r.nodes) continue;
    const capacity = r.nodes.filter((n) => n.type === 'OPS').length;
    if (capacity > (load[r.id] || 0)) out.push(r.id);
  }
  return out;
}

function travelEta(from, to) {
  return (pathVia(from, to) || []).length;
}

function orderChip(o) {
  const t = RULES.turns;
  const cost = estCost(o);
  switch (o.kind) {
    case 'claim': return { label: `Claim ${regionName(o.region)}`, meta: `${t.claim} turns · §${cost}`, color: '#4a7fe0' };
    case 'build_node': return { label: `Build ${NODE_META[o.type].label.toLowerCase()} in ${regionName(o.region)}`, meta: `${t.node[o.type]} turns · §${cost}`, color: NODE_META[o.type].color };
    case 'train_bots': return { label: `${o.standing ? '↻ ' : ''}Train ${o.count} defender${o.count === 1 ? '' : 's'} at ${regionName(o.region)}`, meta: o.standing ? `every turn · §${cost}/turn` : `1 turn · §${cost}`, color: '#4a7fe0' };
    case 'move_bots': return { label: `Reinforce ${regionName(o.to)}`, meta: `${o.count} from ${regionName(o.from)} · arrives next turn`, color: '#4a7fe0' };
    case 'isolate': return { label: `Cut off ${regionName(o.region)}`, meta: 'Reconnect takes 2 turns', color: '#e8b53f' };
    case 'reconnect': return { label: `Reconnect ${regionName(o.region)}`, meta: `${RULES.reconnectTurns} turns · vulnerable meanwhile`, color: '#e8b53f' };
    case 'sweep': return { label: `Sweep ${regionName(o.region)}`, meta: `1 turn · §${cost}`, color: '#8f5fc7' };
    case 'repair': return { label: `Repair ${NODE_META[o.type].label.toLowerCase()} at ${regionName(o.region)}`, meta: `1 turn · §${o.estCost}`, color: '#3f9c78' };
    case 'build_swarm': return { label: `Swarm push on ${regionName(o.target)}`, meta: `from ${regionName(o.facility)} · ${t.swarm} turns to build · §${cost}`, color: '#d8624f' };
    case 'build_worm': return { label: `Worm run at ${regionName(o.target)}`, meta: `from ${regionName(o.facility)}${o.targetNode ? ` · aimed at the ${NODE_META[o.targetNode].label.toLowerCase()}` : ''} · ${t.worm} turns to build · §${cost}`, color: '#d8624f' };
    case 'build_satellite': return { label: `Satellite over ${regionName(o.target)}`, meta: `${t.satellite} turns · §${cost}`, color: '#c48a1e' };
    case 'build_asat': return { label: 'Build a satellite killer', meta: `${t.asat} turns · §${cost}`, color: '#d8624f' };
    case 'move_satellite': return { label: `Move satellite to ${regionName(o.target)}`, meta: `${t.moveSat} turns · §${cost}`, color: '#c48a1e' };
    case 'cancel_build': return { label: `Cancel: ${esc(o.label || 'build')}`, meta: `refund §${o.refund ?? '?'}`, color: '#8d99ab' };
    case 'demolish': return { label: `Remove ${NODE_META[o.type].label.toLowerCase()} at ${regionName(o.region)}`, meta: `get §${Math.floor(RULES.costs.node[o.type] * RULES.demolishRefund)} back · upkeep stops`, color: '#8d99ab' };
    case 'disband': return { label: `Disband your ${o.unitType || 'unit'}`, meta: 'upkeep stops', color: '#8d99ab' };
    case 'disband_bots': return { label: `Disband ${o.count} defender${o.count === 1 ? '' : 's'} at ${regionName(o.region)}`, meta: 'upkeep stops', color: '#8d99ab' };
    case 'retarget': return { label: `Redirect ${o.unitType || 'unit'} to ${regionName(o.target)}`, meta: 'reroutes this turn', color: '#4a7fe0' };
    case 'retarget_group': return { label: `Redirect ${o.units.length} swarm${o.units.length === 1 ? '' : 's'} → ${regionName(o.target)}`, meta: 'they reroute this turn', color: '#d8624f' };
    case 'disband_group': return { label: `Disband ${o.units.length} swarm${o.units.length === 1 ? '' : 's'}`, meta: 'upkeep stops', color: '#8d99ab' };
    default: return { label: o.kind, meta: '', color: '#8d99ab' };
  }
}

function addOrder(o) {
  if (!planning() || locked()) return;
  if (o.kind === 'move_bots' || o.kind === 'train_bots' || o.kind === 'disband_bots') {
    const same = S.ui.pending.find((p) => p.kind === o.kind && p.region === o.region && p.from === o.from && p.to === o.to);
    if (same) {
      const max = o.kind === 'train_bots' ? 5 : (o.maxCount ?? 99);
      same.count = Math.min(same.count + 1, max);
      render();
      return;
    }
  }
  // Menus stay open on purpose — playtesters kept clicking "+1" and having
  // the menu collapse under them. Selecting a different region closes them.
  S.ui.pending.push(o);
  sfx('queue');
  render();
}

// Layered turn-resolution audio: the resolve sweep, then combat noise and
// threat warnings if the report contains them, then win/lose stingers.
function resolveSounds(v, log) {
  sfx('resolve');
  if (log.some((e) => e.step === 3)) setTimeout(() => sfx('combat'), 450);
  if (log.some((e) => /worm detected/i.test(e.title))) setTimeout(() => sfx('detect'), 750);
  if (v?.you?.alerts?.length) setTimeout(() => sfx('alert'), 1000);
  if (v?.winner) setTimeout(() => sfx(v.winner === v.side ? 'win' : 'lose'), 1300);
}

function lockIn() {
  if (!planning() || locked()) return;
  // Client-side group orders expand into the engine's per-unit orders here.
  const orders = S.ui.pending.flatMap((o) => {
    if (o.kind === 'retarget_group') return o.units.map((u) => ({ kind: 'retarget', unit: u, target: o.target }));
    if (o.kind === 'disband_group') return o.units.map((u) => ({ kind: 'disband', unit: u }));
    const { maxCount, label, refund, unitType, estCost, standing, ...rest } = o;
    return [rest];
  });
  send({ t: 'lock', orders });
}

// Standing orders (auto-train): re-queued at the start of every planning
// phase until stopped. Scoped per seat so hot-seat players don't inherit
// each other's automation.
function standingList() {
  if (local) return (local.seats[S.localSeat].standing ??= []);
  return (S.standingOnline ??= []);
}

function requeueStanding() {
  for (const s of standingList()) {
    S.ui.pending.push({ ...s, standing: true });
  }
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
  if (S.conn === 'closed' && !local) {
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
    <div class="wordmark">${logoMark(34)}<div class="word">SIGNAL DOMINION</div></div>
    <div class="tagline">Two governments, one network. Plan in private, resolve together — first capital to fall ends it. <span style="font-family:var(--mono);font-size:13px;color:#6f7b8d">v${VERSION}</span></div>
    ${S.err ? `<div class="error-note">${esc(S.err)}</div>` : ''}
    ${S.waitingNote ? `<div class="error-note" style="background:#10263e;border-color:#2f5686;color:#cfe2fb">${esc(S.waitingNote)}</div>` : ''}
    <div class="card-row">
      <div class="paper-card">
        <div class="eyebrow">COMMANDER</div>
        <div class="field">
          <label for="name-in">DISPLAY NAME</label>
          <input id="name-in" maxlength="24" placeholder="e.g. Meridian" value="${esc(S.name)}">
        </div>
        <div class="field">
          <label for="map-in">BATTLEFIELD</label>
          <select id="map-in">
            ${Object.values(MAPS).map((m) => `<option value="${m.id}" ${m.id === (localStorage.getItem('sd_map') || DEFAULT_MAP) ? 'selected' : ''}>${esc(m.name)} — ${m.regions.length} regions</option>`).join('')}
          </select>
        </div>
        <div class="body" id="map-blurb">${esc(MAPS[localStorage.getItem('sd_map')]?.blurb || MAPS[DEFAULT_MAP].blurb)}</div>
        <div class="rule"></div>
        <div class="body">The battlefield applies to matches you create here — online, pass-and-play or vs the Daemon.</div>
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
        <div class="field">
          <label for="ai-level-in">DAEMON DIFFICULTY</label>
          <select id="ai-level-in">
            <option value="ruthless" ${(localStorage.getItem('sd_ai_level') || 'ruthless') === 'ruthless' ? 'selected' : ''}>Ruthless — plays to win</option>
            <option value="standard" ${localStorage.getItem('sd_ai_level') === 'standard' ? 'selected' : ''}>Standard — a fairer fight</option>
          </select>
        </div>
        <button class="paper-btn" data-act="local-ai">Play vs the Daemon (AI)</button>
        <div class="rule"></div>
        ${(() => {
    const save = loadLocalSave();
    return save ? `
        <button class="paper-btn primary" data-act="resume-save">Resume saved game — turn ${save.state.turn}${save.ai ? ' vs the Daemon' : ''}</button>
        <div style="display:flex;gap:8px">
          <button class="paper-btn" style="flex:1" data-act="export-save">Export save</button>
          <button class="paper-btn" style="flex:1" data-act="import-save">Import save</button>
        </div>` : `
        <button class="paper-btn" data-act="import-save">Import a save file</button>`;
  })()}
        <input type="file" id="import-in" accept=".json,application/json" style="display:none">
        <div class="body">Runs entirely in this page and auto-saves every turn — reload and resume any time. Pass-and-play hides each side's fog behind a cover screen.</div>
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
    <div class="wordmark">${logoMark(34)}<div class="word">SIGNAL DOMINION</div></div>
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
      <div class="cell"><div class="k">MAP</div><div class="v">${S.sync.match.map ? `${S.sync.match.map.regionCount} regions · ${esc(S.sync.match.map.name)}` : '—'}</div></div>
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
        ${S.ui.tab === 'econ' ? renderEconomy(v) : ''}
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
      ${logoMark(34)}
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
      ${logoMark(22, 7)}
      <div class="word">SIGNAL DOMINION</div>
      <div class="code" title="match code">${esc(m.code)}</div>
      <div class="code" title="game version" style="border:none;padding:4px 2px">v${VERSION}</div>
      <button class="sound-btn" data-act="toggle-sound" title="${soundOn() ? 'Sound on — click to mute' : 'Sound off — click to unmute'}">${icon(soundOn() ? 'soundOn' : 'soundOff', 16, soundOn() ? '#8d99ab' : '#5a6578')}</button>
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
        <span title="Capital integrity — if this hits 0, you lose" style="display:inline-flex;align-items:center;gap:4px;padding-left:10px;border-left:1px solid var(--line)">
          ${icon('CAP', 13, v.you.capitalHp >= RULES.combat.capitalHp ? '#8d99ab' : v.you.capitalHp > RULES.combat.capitalHp / 2 ? '#e8b53f' : '#e08585')}
          <span class="funds" style="color:${v.you.capitalHp >= RULES.combat.capitalHp ? '#8d99ab' : v.you.capitalHp > RULES.combat.capitalHp / 2 ? '#e8b53f' : '#e08585'}">${v.you.capitalHp}</span>
        </span>
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
    ['econ', 'Funds', 'border-radius:8px'],
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
  if (mySw) parts.push(`<span class="ubadge" style="color:#9dc1f7" title="your swarm, strength ${mySw}">${icon('swarm', 11)}${mySw}</span>`);
  if (enSw) parts.push(`<span class="ubadge" style="color:#f0a58f" title="enemy swarm, strength ${enSw}">${icon('swarm', 11)}${enSw}</span>`);
  if (myWorms) parts.push(`<span class="ubadge" style="color:#c9a8ef" title="your worm${myWorms === 1 ? '' : 's'}">${icon('worm', 12)}${myWorms}</span>`);
  if (enWorms) parts.push(`<span class="ubadge" style="color:#e8a0d2" title="detected enemy worm — defenders here can intercept it">${icon('worm', 12)}!</span>`);
  // Your in-progress work on this tile, so you don't have to click around:
  // claims/structures/training/repairs at the region, swarm/worm/satellite
  // builds at their facility.
  const builds = v.you.builds.filter((b) => (b.facility || b.region) === id);
  if (builds.length) {
    const min = Math.min(...builds.map((b) => b.turnsLeft));
    const what = builds.map((b) => `${buildLabel(b)} — ${b.turnsLeft} turn${b.turnsLeft === 1 ? '' : 's'} left`).join('\n');
    parts.push(`<span class="ubadge" style="color:#9fd1b6" title="${esc(what)}">⚒${builds.length > 1 ? builds.length : ''}·${min}</span>`);
  }
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
      .map((n) => icon(n.type, 13, NODE_META[n.type].color, `title="${NODE_META[n.type].label}"`)).join('');
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
    <div class="mapscale" id="mapscale" data-w="${v.map.size.w}" data-h="${v.map.size.h}" style="width:${v.map.size.w}px;height:${v.map.size.h}px">${hexes}${routeLines(v)}</div>
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
      <div class="body">${alertText(topAlert)}${topAlert.region && v.regions[topAlert.region]?.owner === mine ? ` <b>${defenseForecast(v.regions[topAlert.region], topAlert)}</b>` : ''}</div>
      <button data-act="focus-threat" data-arg="${esc(topAlert.region || '')}">See my options</button>
    </div>` : ''}
    ${buildQueueDock(v)}
  </div>`;
}

// "Will it hold?" — the math the defender is doing in their head, done for
// them: garrison power vs known incoming strength.
function defenseForecast(r, a) {
  const inf = (r.nodes || []).filter((n) => n.type === 'INF').length;
  const def = (r.garrison || 0) * RULES.combat.botPower + ((r.garrison || 0) > 0 ? inf * RULES.combat.infBonus : 0);
  if (a.type === 'swarm' && a.strength != null) {
    if (def > a.strength) return `Your defense is ${def} vs ~${a.strength} incoming — it should hold.`;
    const add = Math.ceil((a.strength - def) / RULES.combat.botPower) + 1;
    return `Your defense is ${def} vs ~${a.strength} incoming — it likely FALLS. Add ~${add} defenders, or cut the region off.`;
  }
  if (a.type === 'worm') {
    return (r.garrison || 0) > 0
      ? `You have ${r.garrison} defender${r.garrison === 1 ? '' : 's'} here — a detected worm gets intercepted on arrival.`
      : 'No defenders here to intercept it — reinforce now or cut the region off.';
  }
  return `Current defense here: ${def}.`;
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

// The global build queue, always visible on the map: everything in progress
// with a countdown bar, click to jump to where it's happening.
function buildQueueDock(v) {
  const builds = v.you.builds;
  if (!builds.length && !S.ui.pending.length) return '';
  const iconFor = (b) => {
    if (b.kind === 'node' || b.kind === 'repair') return icon(b.type, 13, NODE_META[b.type]?.color || '#8d99ab');
    if (b.kind === 'swarm') return icon('swarm', 13, '#d8624f');
    if (b.kind === 'worm') return icon('worm', 13, '#8f5fc7');
    if (b.kind === 'satellite' || b.kind === 'asat' || b.kind === 'moveSat') return icon('sat', 13, '#c48a1e');
    if (b.kind === 'bots') return icon('bot', 13, '#4a7fe0');
    return icon('CAP', 13, '#8d99ab');
  };
  const rows = builds.slice(0, 7).map((b) => {
    const pct = Math.round(((b.totalTurns - b.turnsLeft) / b.totalTurns) * 100);
    const where = b.facility || b.region;
    return `
    <div class="queue-row" data-act="hex" data-arg="${where}">
      ${iconFor(b)}
      <div class="q-mid">
        <div class="q-label">${buildLabel(b)}</div>
        <div class="q-track"><i style="width:${pct}%"></i></div>
      </div>
      <div class="q-eta">${b.turnsLeft}t</div>
    </div>`;
  }).join('');
  const more = builds.length > 7 ? `<div class="q-note">+${builds.length - 7} more in the Funds tab</div>` : '';
  const queued = S.ui.pending.length ? `<div class="q-note">+${S.ui.pending.length} order${S.ui.pending.length === 1 ? '' : 's'} queued this turn</div>` : '';
  return `
  <div class="queue-dock">
    <div class="q-head">BUILD QUEUE</div>
    ${rows || '<div class="q-note">Nothing in progress</div>'}
    ${more}${queued}
  </div>`;
}

function renderPickBanner() {
  const label = S.ui.pick.type === 'moveSat'
    ? 'Pick the region the satellite should watch'
    : S.ui.pick.type === 'retarget'
      ? 'Pick the new destination for this unit'
      : S.ui.pick.type === 'retarget-group'
        ? `Pick where to send the ${S.ui.pick.units.length} selected swarm group${S.ui.pick.units.length === 1 ? '' : 's'}`
        : 'Pick a region on the map';
  return `<div class="pick-banner">${label} <button data-act="pick-cancel">cancel</button></div>`;
}

function renderEconomy(v) {
  const eco = v.you.economy;
  const line = (label, amount, note = '') => `
    <div style="display:flex;justify-content:space-between;gap:12px;font-size:15px;padding:6px 0;border-bottom:1px solid var(--paper-line)">
      <span style="color:var(--paper-soft)">${label}${note ? ` <span style="color:var(--paper-muted);font-size:13px">${note}</span>` : ''}</span>
      <b style="font-family:var(--mono);font-weight:500">${amount >= 0 ? '+' : ''}§${amount}</b>
    </div>`;
  const incomeLines = [
    eco.capitalIncome ? line('Command centre', eco.capitalIncome) : line('Command centre', 0, 'cut off — no income!'),
    ...eco.finance.map((f) => line(`${regionName(f.region)}`, f.amount, f.count > 1 ? `${f.count} finance hubs` : 'finance hub')),
  ].join('');
  const upkeepLines = [
    line(`Structures (${eco.counts.nodes})`, -eco.upkeep.nodes, `§${RULES.upkeep.node} each`),
    line(`Defenders (${eco.counts.bots})`, -eco.upkeep.bots, `§${RULES.upkeep.bot} each`),
    eco.counts.swarms ? line(`Swarms (${eco.counts.swarms})`, -eco.upkeep.swarms, `§${RULES.upkeep.swarm} each`) : '',
    eco.counts.worms ? line(`Worms (${eco.counts.worms})`, -eco.upkeep.worms, `§${RULES.upkeep.worm} each`) : '',
    eco.counts.satellites ? line(`Satellites (${eco.counts.satellites})`, -eco.upkeep.satellites, `§${RULES.upkeep.satellite} each`) : '',
  ].join('');

  const regionCards = Object.values(v.regions).filter((r) => isMine(r)).map((r) => {
    const status = r.isolated ? '⚠ cut off (quarantined)'
      : r.reconnecting > 0 ? `⚠ reconnecting (${r.reconnecting} left)`
      : r.connected ? 'connected'
      : '⚠ CUT OFF from capital';
    const fins = (r.nodes || []).filter((n) => n.type === 'FIN').length;
    const chips = (r.nodes || []).map((n) => `<span>${NODE_META[n.type].label}${n.hp < n.maxHp ? ` · ${Math.round((n.hp / n.maxHp) * 100)}%` : ''}</span>`).join('');
    return `
    <div class="intel-card" data-act="hex" data-arg="${r.id}" style="cursor:pointer">
      <div class="row"><div class="name">${esc(r.name)}</div>
        <div class="age" style="color:${r.connected && !r.isolated ? '#3f9c78' : '#c25b46'}">${status}</div></div>
      <div class="summary">${(r.nodes || []).length}/${RULES.maxNodesPerRegion} structure slots · ${r.garrison ?? 0} defender${r.garrison === 1 ? '' : 's'}${fins && r.connected ? ` · earning §${fins * RULES.income.finance}/turn` : ''}</div>
      <div class="chips">${chips || '<span style="background:transparent;color:#8b93a1">nothing built</span>'}</div>
    </div>`;
  }).join('');

  const buildRows = v.you.builds.map((b) => `
    <div style="display:flex;justify-content:space-between;gap:12px;font-size:15px;padding:6px 0;border-bottom:1px solid var(--paper-line)">
      <span style="color:var(--paper-soft)">${buildLabel(b)}</span>
      <span style="display:flex;gap:10px;align-items:center">
        <b>${b.turnsLeft} turn${b.turnsLeft === 1 ? '' : 's'} left</b>
        <button class="paper-btn" style="padding:3px 10px;font-size:12px" data-act="cancel-build" data-arg="${b.id}" ${locked() ? 'disabled' : ''}>Cancel · §${Math.floor(b.cost * RULES.refundRate)}</button>
      </span>
    </div>`).join('');

  const unitRows = v.units.filter((u) => u.owner === mySide() && u.type !== 'bot').map((u) => `
    <div style="display:flex;justify-content:space-between;gap:12px;font-size:15px;padding:6px 0;border-bottom:1px solid var(--paper-line)">
      <span style="color:var(--paper-soft)">${u.type} at ${regionName(u.region)}${u.target && u.target !== u.region ? ` → ${regionName(u.target)} (${u.eta} turn${u.eta === 1 ? '' : 's'})` : ' · idle'}${u.held ? ' · <b style="color:#c25b46">held — way in is cut off</b>' : ''}</span>
      <button class="paper-btn" style="padding:3px 10px;font-size:12px" data-act="disband" data-arg="${u.id}" ${locked() ? 'disabled' : ''}>Disband</button>
    </div>`).join('');

  return `
  <div class="pane">
    <div>
      <div class="pane-title">Funds</div>
      <div class="pane-sub">§${v.you.funding} in the treasury · ${v.you.income >= 0 ? '+' : ''}${v.you.income}/turn${v.you.negStreak ? ` · <b style="color:#e08585">running negative ${v.you.negStreak}/${RULES.collapseTurns} turns — at ${RULES.collapseTurns} your economy collapses</b>` : ''}</div>
    </div>
    <div class="grid2">
      <div class="orbit-card">
        <div class="who">Money in <span style="font-family:var(--mono);color:#3f9c78">+§${eco.income}</span></div>
        <div>${incomeLines}</div>
        <div class="detail">Finance hubs only pay while their region is connected to your capital. Cut-off regions earn nothing.</div>
      </div>
      <div class="orbit-card">
        <div class="who">Money out <span style="font-family:var(--mono);color:#c25b46">−§${eco.upkeepTotal}</span></div>
        <div>${upkeepLines}</div>
        <div class="detail">Reclaim money by decommissioning structures (25% back, from the region panel) or disbanding units.</div>
      </div>
      ${v.you.builds.length ? `
      <div class="orbit-card">
        <div class="who">Being built</div>
        <div>${buildRows}</div>
      </div>` : ''}
      ${unitRows ? `
      <div class="orbit-card">
        <div class="who">Units in the field</div>
        <div>${unitRows}</div>
      </div>` : ''}
    </div>
    <div>
      <div class="pane-title" style="font-size:19px">Your regions</div>
    </div>
    <div class="grid3">${regionCards}</div>
  </div>`;
}

function renderOrbit(v) {
  const cards = [];
  const footprint = (id) => [id, ...(region(id)?.neighbors || [])].map(regionName).join(', ');
  for (const s of v.you.satellites) {
    const moving = v.you.builds.find((b) => b.kind === 'moveSat' && b.satId === s.id);
    cards.push(`
    <div class="orbit-card">
      <div class="row">
        <div class="who">${icon('sat', 16, '#3f9c78')}Watcher over ${esc(regionName(s.region))}</div>
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
        <div class="who">${icon('sat', 16, '#d8624f')}${esc(oppName())}'s eye over ${esc(regionName(s.region))}</div>
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
    <div class="grid2">${cards.join('') || '<div class="pane-sub">Nothing in orbit yet. Build a satellite from an enemy or neutral region\'s panel — you\'ll need an uplink station.</div>'}</div>
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
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <div>
        <div class="pane-title">Last turn's report</div>
        <div class="pane-sub">Everything that happened when turn ${v.turn - 1} resolved, in the order it happened.</div>
      </div>
      <button class="cta" style="font-size:16px;padding:12px 28px" data-act="tab" data-arg="map">Back to the map →</button>
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
  const pendingRepairs = (type) =>
    S.ui.pending.filter((o) => o.kind === 'repair' && o.region === id && o.type === type).length
    + v.you.builds.filter((b) => b.kind === 'repair' && b.region === id && b.type === type).length;
  const repairShown = {};
  const nodeRows = nodes.length ? nodes.map((n) => {
    const meta = NODE_META[n.type];
    const pct = n.hpPct ?? Math.round((n.hp / n.maxHp) * 100);
    const hpText = (mine || live) ? `${pct}% healthy` : r.intel ? `${pct}% when seen` : 'unknown';
    let repairBtn = '';
    if (mine && n.type !== 'CAP' && n.hp < n.maxHp && planning() && !locked()) {
      repairShown[n.type] = (repairShown[n.type] || 0) + 1;
      const damagedOfType = nodes.filter((x) => x.type === n.type && x.hp < x.maxHp).length;
      if (pendingRepairs(n.type) < damagedOfType && repairShown[n.type] <= damagedOfType - pendingRepairs(n.type)) {
        const cost = Math.max(5, Math.ceil((n.maxHp - n.hp) * RULES.repairPerHp));
        repairBtn = `<button class="paper-btn" style="padding:2px 9px;font-size:12px;margin-left:8px" data-act="repair" data-arg="${n.type}" data-cost="${cost}" ${budgetLeft() < cost ? 'disabled' : ''}>Repair §${cost}</button>`;
      }
    }
    return `
    <div class="node-row" title="${esc(nodeEffect(n.type))}">
      <div class="icon" style="background:${meta.tint}">${icon(n.type, 19, meta.color)}</div>
      <div class="meta">
        <div class="top"><span class="label">${meta.label}</span><span class="hp-text">${hpText}${repairBtn}</span></div>
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
  const mySwarmsHere = fighters
    .filter((u) => u.owner === mySide() && u.type === 'swarm')
    .sort((a, b) => (b.strength || 0) - (a.strength || 0));
  const groupable = mySwarmsHere.length > 1;
  const groupRow = groupable ? (() => {
    const total = mySwarmsHere.reduce((s, u) => s + (u.strength || 0), 0);
    const n = Math.min(S.ui.swarmSend ?? mySwarmsHere.length, mySwarmsHere.length);
    const sel = mySwarmsHere.slice(0, n).reduce((s, u) => s + (u.strength || 0), 0);
    return `
    <div class="kv" style="flex-direction:column;align-items:stretch;gap:8px">
      <div style="display:flex;justify-content:space-between"><span>Your swarms here</span><b>${mySwarmsHere.length} groups · strength ${total}</b></div>
      <input type="range" id="swarm-slider" min="1" max="${mySwarmsHere.length}" value="${n}" style="width:100%;accent-color:#4a7fe0">
      <div style="font-size:13px;color:var(--paper-muted)">Sending <b id="swarm-send-label">${n} group${n === 1 ? '' : 's'} (strength ${sel})</b> — slide to split the force</div>
      <div style="display:flex;gap:6px">
        <button class="paper-btn" style="flex:1;padding:6px 10px;font-size:13px" data-act="retarget-group" ${locked() ? 'disabled' : ''}>Redirect selected</button>
        <button class="paper-btn" style="flex:1;padding:6px 10px;font-size:13px" data-act="disband-group" ${locked() ? 'disabled' : ''}>Disband selected</button>
      </div>
    </div>`;
  })() : '';
  const singles = groupable ? fighters.filter((u) => !(u.owner === mySide() && u.type === 'swarm')) : fighters;
  const unitRows = groupRow + singles.map((u) => {
    const isMyUnit = u.owner === mySide();
    const label = u.type === 'swarm' ? `swarm (strength ${u.strength})` : 'worm';
    if (!isMyUnit) return `<div class="kv"><span>Their ${label} is here</span><b style="color:#c25b46">hostile</b></div>`;
    const going = u.target && u.target !== u.region
      ? `→ ${regionName(u.target)}, ${u.eta} turn${u.eta === 1 ? '' : 's'}`
      : 'idle';
    return `
    <div class="kv" style="align-items:center">
      <span>Your ${label}<br><span style="font-size:13px;color:${u.held ? '#c25b46' : 'var(--paper-muted)'}">${u.held ? 'held — the way in is cut off' : going}</span></span>
      <span style="display:flex;gap:6px">
        <button class="paper-btn" style="padding:4px 10px;font-size:12px" data-act="retarget" data-arg="${u.id}" ${locked() ? 'disabled' : ''}>Redirect</button>
        <button class="paper-btn" style="padding:4px 10px;font-size:12px" data-act="disband" data-arg="${u.id}" ${locked() ? 'disabled' : ''}>Disband</button>
      </span>
    </div>`;
  }).join('');

  const starvedWarn = mine && r.starved > 0 && !r.connected ? `
    <div class="warn-card">
      <div class="t">Cut off for ${r.starved} turn${r.starved === 1 ? '' : 's'}</div>
      <div class="d">No income, no reinforcements. ${r.starved > RULES.starveGrace
    ? `It is decaying: structures lose ${RULES.starveNodeDamage} HP and a defender goes dark every turn.`
    : `After ${RULES.starveGrace} turns, structures start losing ${RULES.starveNodeDamage} HP per turn and defenders go dark.`}</div>
    </div>` : '';

  const alerts = v.you.alerts.filter((a) => a.region === id);
  const threatCards = alerts.map((a) => `
    <div class="warn-card">
      <div class="t">${a.type === 'anomaly' ? 'Something is being built against this region' : a.type === 'swarm' ? `A swarm group is ${a.eta} turn${a.eta === 1 ? '' : 's'} away` : a.type === 'worm' ? `A worm is ${a.eta} turn${a.eta === 1 ? '' : 's'} away` : a.type === 'build' ? `Incoming ${a.buildType} build` : 'Enemy units are inside'}</div>
      <div class="d">${alertText(a).replace(/<[^>]+>/g, '')}</div>
      ${mine ? `<div class="d" style="font-weight:600">${defenseForecast(r, a)}</div>` : ''}
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
        ${(mine || live) ? `<div class="kv"><span>Structure slots</span><b>${nodes.length}/${RULES.maxNodesPerRegion}</b></div>` : ''}
        ${mine ? facilityStatusRows(v, id, r) : ''}
        ${unitRows}
      </div>
      ${starvedWarn}
      ${threatCards}
      ${buildRows}
      <div class="side-sec">
        <div class="eyebrow">WHAT YOU CAN DO HERE</div>
        ${renderActions(v, r)}
      </div>
    </div>
  </div>`;
}

// "Is my red team den / uplink station here free or busy?" — playtesters
// couldn't tell why they couldn't send more swarms.
function facilityStatusRows(v, id, r) {
  return ['OPS', 'LNC'].map((type) => {
    const count = (r.nodes || []).filter((n) => n.type === type).length;
    if (!count) return '';
    const kinds = type === 'OPS' ? ['swarm', 'worm'] : ['satellite', 'asat'];
    const orderKinds = type === 'OPS' ? ['build_swarm', 'build_worm'] : ['build_satellite', 'build_asat'];
    const busy = v.you.builds.filter((b) => (b.facility || b.region) === id && kinds.includes(b.kind));
    const queued = S.ui.pending.filter((o) => orderKinds.includes(o.kind) && o.facility === id).length;
    const used = busy.length + queued;
    const status = used >= count
      ? (busy[0] ? `busy — ${buildLabel(busy[0])}, ${busy[0].turnsLeft} left` : 'busy — queued this turn')
      : 'idle — ready to build';
    return `<div class="kv"><span>${NODE_META[type].label}</span><b style="color:${used >= count ? '#a07a24' : '#3f9c78'};font-weight:500">${status}</b></div>`;
  }).join('');
}

// Pathfinding over whatever map this match is on, via the view's own
// adjacency data.
function viewNeighbors() {
  const nb = {};
  for (const [id, r] of Object.entries(view().regions)) nb[id] = r.neighbors;
  return nb;
}

function pathVia(from, to, blocked) {
  return pathOn(viewNeighbors(), from, to, blocked);
}

// Route for defenders: through your own connected network only.
function botPath(from, to) {
  const blocked = (rid) => {
    const rr = region(rid);
    return !rr || rr.owner !== mySide() || rr.isolated || rr.reconnecting > 0;
  };
  return pathVia(from, to, blocked);
}

function botEta(from, to) {
  const path = botPath(from, to);
  return path ? path.length : null;
}

// Dashed route lines on the map: where your units are going, where your
// queued/under-construction attacks will travel, and (estimated) where
// visible incoming threats are headed.
function routeLines(v) {
  const center = (id) => {
    const r = v.regions[id];
    return [r.x + 66, r.y + 75];
  };
  const lines = [];
  const poly = (ids, color, opacity, dash, width = 3) => {
    if (!ids || ids.length < 2) return;
    const pts = ids.map((id) => center(id).join(',')).join(' ');
    lines.push(`<polyline points="${pts}" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${width}" stroke-dasharray="${dash}" stroke-linecap="round"/>`);
    const [tx, ty] = center(ids[ids.length - 1]);
    lines.push(`<circle cx="${tx}" cy="${ty}" r="8" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="2.5"/>`);
  };
  const unitColor = (t) => (t === 'worm' ? '#b48ae0' : t === 'bot' ? '#6d9bf0' : '#e0705c');
  for (const u of v.units) {
    if (u.owner === mySide()) {
      if (u.path?.length) poly([u.region, ...u.path], unitColor(u.type), 0.85, '3 9');
    } else if ((u.type === 'swarm' || u.type === 'worm') && u.target && u.target !== u.region) {
      // Their exact route is their business — draw the likely one.
      poly([u.region, ...(pathVia(u.region, u.target) || [])], '#e0803f', 0.55, '7 7');
    }
  }
  // Attacks still in the build queue at a red team den.
  for (const b of v.you.builds) {
    if (b.kind === 'swarm' || b.kind === 'worm') {
      poly([b.facility, ...(pathVia(b.facility, b.target) || [])], unitColor(b.kind), 0.3, '2 8', 2.5);
    }
  }
  // Orders queued this turn but not locked yet.
  for (const o of S.ui.pending) {
    if (o.kind === 'build_swarm' || o.kind === 'build_worm') {
      poly([o.facility, ...(pathVia(o.facility, o.target) || [])], unitColor(o.kind.slice(6)), 0.3, '2 8', 2.5);
    } else if (o.kind === 'move_bots') {
      const p = botPath(o.from, o.to);
      if (p) poly([o.from, ...p], '#6d9bf0', 0.35, '2 8', 2.5);
    }
  }
  const { w, h } = v.map.size;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="position:absolute;left:0;top:0;pointer-events:none;overflow:visible">${lines.join('')}</svg>`;
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
  const shown = disabled && why ? `<span style="color:#b05c4c">${why}</span>` : detail;
  return `
  <button class="action-btn" data-act="${act}" ${arg ? `data-arg="${esc(arg)}"` : ''} ${disabled ? 'disabled' : ''} ${why ? `title="${esc(why)}"` : ''}>
    <div class="sw" style="background:${color}"></div>
    <div class="mid"><div class="label">${label}</div><div class="detail">${shown}</div></div>
    <div class="cost">${cost}<br>${time}</div>
  </button>`;
}

// What building each structure actually does for you — shown in the build menu.
function nodeEffect(type) {
  const c = RULES.costs;
  switch (type) {
    case 'FIN': return `+§${RULES.income.finance}/turn while connected to your capital · §${RULES.upkeep.node}/turn upkeep`;
    case 'INF': return `Lets you train defenders here (§${c.bot} each) · adds +${RULES.combat.infBonus} defence while garrisoned`;
    case 'ANL': return `Spots stealth worms here and next door · sweeps cost §${c.sweep} instead of §${c.sweepFar}`;
    case 'OPS': return `Builds swarms (§${c.swarm}) and worms (§${c.worm}) — one at a time`;
    case 'LNC': return `Launches satellites (§${c.satellite}) and satellite killers (§${c.asat}) — one at a time`;
    default: return '';
  }
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
    const sources = Object.values(view().regions)
      .filter((n) => isMine(n) && n.id !== id && (n.garrison ?? 0) > 0 && !n.isolated)
      .map((n) => ({ ...n, eta: botEta(n.id, id) }))
      .filter((n) => n.eta !== null && n.eta > 0)
      .sort((a, b) => a.eta - b.eta)
      .slice(0, 6);
    out.push(actionBtn({
      act: 'reinforce-menu', label: 'Send defenders here', detail: 'Pull bots from anywhere in your network — they travel one region per turn',
      cost: '§0', time: '1+ turns', color: '#4a7fe0',
      disabled: cutOff || r.reconnecting > 0 || !sources.length,
      why: cutOff || r.reconnecting > 0 ? 'This region cannot receive units right now' : !sources.length ? 'No reachable defenders available' : '',
    }));
    if (S.ui.reinforceMenu && sources.length && !cutOff && r.reconnecting === 0) {
      out.push(`<div class="sub-actions">${sources.map((n) => {
        const pendingFrom = S.ui.pending.filter((o) => o.kind === 'move_bots' && o.from === n.id).reduce((s, o) => s + o.count, 0);
        const avail = (n.garrison ?? 0) - pendingFrom;
        return `<button class="paper-btn" data-act="reinforce" data-arg="${n.id}" ${avail < 1 ? 'disabled' : ''}>+1 from ${esc(n.name)} (${avail} available) · ${n.eta} turn${n.eta === 1 ? '' : 's'}</button>`;
      }).join('')}</div>`);
    }
    const hasInf = (r.nodes || []).some((n) => n.type === 'INF');
    const standing = standingList().some((s) => s.kind === 'train_bots' && s.region === id);
    out.push(actionBtn({
      act: 'train', label: 'Train a defender', detail: 'The garrison here builds one infantry bot',
      cost: `§${c.bot}`, time: '1 turn', color: '#4a7fe0',
      disabled: cutOff || r.reconnecting > 0 || !hasInf || left < c.bot,
      why: !hasInf ? 'Needs a defender garrison here — build one first' : left < c.bot ? 'Not enough funding left' : '',
    }));
    if (hasInf) {
      out.push(actionBtn({
        act: 'train-standing',
        label: standing ? 'Stop auto-training' : 'Auto-train every turn',
        detail: standing ? 'This region queues a defender each turn — click to stop' : `Queues one defender here automatically at the start of every turn`,
        cost: standing ? '' : `§${c.bot}/turn`, time: '↻', color: '#4a7fe0',
        disabled: !standing && (cutOff || r.reconnecting > 0),
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
      act: 'build-menu', label: 'Build something new', detail: 'Add a finance hub, garrison, analyst post, red team den or uplink station',
      cost: `from §${c.node.INF}`, time: '2–4 turns', color: '#3f9c78',
      disabled: cutOff || r.reconnecting > 0 || (r.nodes || []).length >= RULES.maxNodesPerRegion,
      why: (r.nodes || []).length >= RULES.maxNodesPerRegion ? 'Region is full' : '',
    }));
    if (S.ui.buildMenu && !cutOff && r.reconnecting === 0) {
      out.push(`<div class="sub-actions">${['FIN', 'INF', 'ANL', 'OPS', 'LNC'].map((type) => `
        <button class="paper-btn" style="text-align:left" data-act="build-node" data-arg="${type}" ${left < c.node[type] ? 'disabled' : ''}>
          <span style="display:inline-flex;align-items:center;gap:7px"><span style="display:inline-flex">${icon(type, 15, NODE_META[type].color)}</span><b>${NODE_META[type].label}</b> · §${c.node[type]} · ${t.node[type]} turns</span><br>
          <span style="font-size:13px;color:var(--paper-muted);font-weight:400">${nodeEffect(type)}</span>
        </button>`).join('')}</div>`);
    }
    const removable = (r.nodes || []).filter((n) => n.type !== 'CAP');
    if (removable.length || (r.garrison ?? 0) > 0) {
      out.push(actionBtn({
        act: 'decom-menu', label: 'Decommission something', detail: 'Get some money back and stop the upkeep',
        cost: 'refunds', time: 'now', color: '#8d99ab',
      }));
      if (S.ui.decomMenu) {
        const pendingDemo = (type) => S.ui.pending.filter((o) => o.kind === 'demolish' && o.region === id && o.type === type).length;
        const items = [...new Set(removable.map((n) => n.type))].map((type) => {
          const count = removable.filter((n) => n.type === type).length - pendingDemo(type);
          return count > 0 ? `
          <button class="paper-btn" data-act="demolish" data-arg="${type}">
            Remove ${NODE_META[type].label.toLowerCase()} · get §${Math.floor(c.node[type] * RULES.demolishRefund)} back
          </button>` : '';
        }).join('');
        const pendingBotDisband = S.ui.pending.filter((o) => o.kind === 'disband_bots' && o.region === id).reduce((s, o) => s + o.count, 0);
        const botsLeft = (r.garrison ?? 0) - pendingBotDisband;
        out.push(`<div class="sub-actions">${items}${botsLeft > 0
          ? `<button class="paper-btn" data-act="disband-bot">Disband a defender · saves §${RULES.upkeep.bot}/turn</button>` : ''}</div>`);
      }
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
    const opsChoices = idleOpsRegions();
    const opsWhy = opsChoices.length === 0
      ? (facilityFree('OPS') ? '' : 'Every red team den is busy — build another, or wait')
      : '';
    const knownTypes = [...new Set((r.nodes || r.intel?.nodes || []).map((n) => n.type))];
    const attackSub = (kind) => {
      const aim = kind === 'worm' && knownTypes.length ? `
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        <span style="font-size:13px;color:var(--paper-muted)">Aim at:</span>
        ${['auto', ...knownTypes].map((type) => {
    const on = (S.ui.wormAim || 'auto') === type;
    return `<button class="paper-btn" style="padding:4px 10px;font-size:12px;${on ? 'background:#4a7fe0;border-color:#4a7fe0;color:#fff' : ''}" data-act="worm-aim" data-arg="${type}">${type === 'auto' ? 'first target' : NODE_META[type].label}</button>`;
  }).join('')}
      </div>` : '';
      return `<div class="sub-actions">${aim}${opsChoices.map((ops) => {
        const dist = travelEta(ops, id);
        const buildT = kind === 'swarm' ? t.swarm : t.worm;
        return `
      <button class="paper-btn" style="text-align:left" data-act="attack-from" data-arg="${ops}">
        <b>From ${esc(regionName(ops))}</b> · ${buildT} turns to build, then ${dist} turn${dist === 1 ? '' : 's'} of travel
      </button>`;
      }).join('')}</div>`;
    };
    out.push(actionBtn({
      act: 'swarm', label: 'Send a swarm here', detail: 'Cheap and numerous. Travels one region per turn and can be seen coming',
      cost: `§${c.swarm}`, time: `${t.swarm} turns to build`, color: '#d8624f',
      disabled: !opsChoices.length || left < c.swarm,
      why: opsWhy || (opsChoices.length && left < c.swarm ? 'Not enough funding left' : opsWhy),
    }));
    if (S.ui.attackMenu === 'swarm' && opsChoices.length > 1) out.push(attackSub('swarm'));
    if (enemy) {
      out.push(actionBtn({
        act: 'worm', label: 'Send a worm here', detail: 'Slow and expensive, but invisible unless they have eyes on the route',
        cost: `§${c.worm}`, time: `${t.worm} turns to build`, color: '#d8624f',
        disabled: !opsChoices.length || left < c.worm,
        why: opsWhy || (opsChoices.length && left < c.worm ? 'Not enough funding left' : opsWhy),
      }));
      if (S.ui.attackMenu === 'worm' && (opsChoices.length > 1 || knownTypes.length)) out.push(attackSub('worm'));
    }
    out.push(actionBtn({
      act: 'satellite', label: 'Put a satellite overhead', detail: enemy ? 'See what is really in here, and spot worms passing through' : 'Watch the crossroads before they use it',
      cost: `§${c.satellite}`, time: `${t.satellite} turns`, color: '#c48a1e',
      disabled: !facilityFree('LNC') || left < c.satellite,
      why: !facilityFree('LNC') ? 'Every uplink station is busy (or you have none)' : '',
    }));
    const allSwarms = view().units.filter((u) => u.owner === mySide() && u.type === 'swarm');
    if (allSwarms.length) {
      const total = allSwarms.reduce((s, u) => s + (u.strength || 0), 0);
      out.push(actionBtn({
        act: 'rally', label: 'Rally all swarms here', detail: `Every swarm you have (${allSwarms.length} group${allSwarms.length === 1 ? '' : 's'}, strength ${total}) reroutes to this region`,
        cost: '§0', time: 'now', color: '#d8624f',
      }));
    }
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
      <div class="spendline">Orders cost <b class="${over ? 'over' : ''}">§${spend}</b> · you'll have <b class="${over ? 'over' : ''}">§${v.you.funding - spend}</b> left</div>
      ${v.winner
    ? `<button class="lock-btn locked" data-act="show-result">Match over — view result</button>`
    : isLocked
      ? `<button class="lock-btn locked" disabled>Locked — waiting for ${esc(oppName())}</button>`
      : S.ui.lockConfirm
        ? `<button class="lock-btn" style="background:#a3702a" data-act="lock" ${over ? 'disabled' : ''}>You haven't checked the map — lock anyway?</button>`
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
      <div class="foot" style="gap:10px">
        <button class="paper-btn" data-act="see-report" style="font-size:16px;padding:12px 24px">Read the full report</button>
        <button class="paper-btn primary" data-act="to-map" style="font-size:17px;padding:13px 32px">To the map — plan turn ${v.turn}</button>
      </div>
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
      send({ t: 'create', name, pacing: document.getElementById('pacing-in')?.value || 'live', map: chosenMap() });
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
    case 'local':
    case 'local-ai': {
      const p1 = (document.getElementById('name-in')?.value || S.name || '').trim() || 'Player 1';
      const ai = act === 'local-ai';
      const p2 = ai ? 'The Daemon' : (document.getElementById('name2-in')?.value || '').trim() || 'Player 2';
      S.name = p1;
      localStorage.setItem('sd_name', p1);
      const aiLevel = document.getElementById('ai-level-in')?.value || localStorage.getItem('sd_ai_level') || 'ruthless';
      localStorage.setItem('sd_ai_level', aiLevel);
      startLocal(p1, p2, { ai, aiLevel, map: chosenMap() });
      break;
    }
    case 'resume-save': {
      const save = loadLocalSave();
      if (!save) break;
      try {
        startLocal(save.names.A, save.names.B, { ai: save.ai, aiLevel: save.aiLevel || 'ruthless', restored: save.state });
      } catch (e) {
        localStorage.removeItem(SAVE_KEY);
        S.err = 'That save could not be loaded (probably from an older version).';
        local = null;
        render();
      }
      break;
    }
    case 'export-save': {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) break;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
      a.download = `signal-dominion-turn${loadLocalSave()?.state.turn ?? 0}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      break;
    }
    case 'import-save': document.getElementById('import-in')?.click(); break;
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
    case 'tab':
      S.ui.tab = arg;
      S.ui.resolve = null;
      if (arg === 'map') { S.ui.sawMap = true; S.ui.lockConfirm = false; }
      render();
      break;
    case 'to-map':
      S.ui.resolve = null;
      S.ui.tab = 'map';
      S.ui.sawMap = true;
      S.ui.lockConfirm = false;
      render();
      break;
    case 'hex': {
      if (S.ui.pick) {
        const pick = S.ui.pick;
        S.ui.pick = null;
        if (pick.type === 'moveSat') addOrder({ kind: 'move_satellite', sat: pick.sat, target: arg });
        else if (pick.type === 'retarget') addOrder({ kind: 'retarget', unit: pick.unit, target: arg, unitType: pick.unitType });
        else if (pick.type === 'retarget-group') addOrder({ kind: 'retarget_group', units: pick.units, target: arg });
        S.ui.tab = 'map';
        render();
        return;
      }
      S.ui.selected = arg;
      S.ui.buildMenu = false;
      S.ui.reinforceMenu = false;
      S.ui.decomMenu = false;
      S.ui.attackMenu = null;
      S.ui.swarmSend = null;
      S.ui.tab = 'map';
      S.ui.sawMap = true;
      S.ui.lockConfirm = false;
      sfx('click');
      render();
      break;
    }
    case 'focus-threat': if (arg) { S.ui.selected = arg; S.ui.tab = 'map'; S.ui.sawMap = true; render(); } break;
    case 'pick-cancel': S.ui.pick = null; render(); break;

    // region actions
    case 'reinforce-menu': S.ui.reinforceMenu = !S.ui.reinforceMenu; render(); break;
    case 'reinforce': addOrder({ kind: 'move_bots', from: arg, to: sel(), count: 1, maxCount: region(arg)?.garrison ?? 1 }); break;
    case 'train': addOrder({ kind: 'train_bots', region: sel(), count: 1 }); break;
    case 'train-standing': {
      const list = standingList();
      const i = list.findIndex((s) => s.kind === 'train_bots' && s.region === sel());
      if (i >= 0) {
        list.splice(i, 1);
        S.ui.pending = S.ui.pending.filter((o) => !(o.standing && o.kind === 'train_bots' && o.region === sel()));
      } else {
        list.push({ kind: 'train_bots', region: sel(), count: 1 });
        S.ui.pending.push({ kind: 'train_bots', region: sel(), count: 1, standing: true });
      }
      render();
      break;
    }
    case 'isolate': addOrder({ kind: 'isolate', region: sel() }); break;
    case 'reconnect': addOrder({ kind: 'reconnect', region: sel() }); break;
    case 'sweep': addOrder({ kind: 'sweep', region: sel() }); break;
    case 'build-menu': S.ui.buildMenu = !S.ui.buildMenu; S.ui.decomMenu = false; render(); break;
    case 'build-node': addOrder({ kind: 'build_node', region: sel(), type: arg }); break;
    case 'decom-menu': S.ui.decomMenu = !S.ui.decomMenu; S.ui.buildMenu = false; render(); break;
    case 'demolish': addOrder({ kind: 'demolish', region: sel(), type: arg }); break;
    case 'repair': addOrder({ kind: 'repair', region: sel(), type: arg, estCost: Number(el.dataset.cost) || 0 }); break;
    case 'disband-bot': addOrder({ kind: 'disband_bots', region: sel(), count: 1 }); break;
    case 'disband': {
      const u = view().units.find((x) => x.id === Number(arg));
      if (u && !S.ui.pending.some((o) => o.kind === 'disband' && o.unit === u.id)) {
        addOrder({ kind: 'disband', unit: u.id, unitType: u.type });
      }
      break;
    }
    case 'retarget': {
      const u = view().units.find((x) => x.id === Number(arg));
      if (u) { S.ui.pick = { type: 'retarget', unit: u.id, unitType: u.type }; S.ui.tab = 'map'; render(); }
      break;
    }
    case 'retarget-group':
    case 'disband-group': {
      const here = view().units
        .filter((u) => u.owner === mySide() && u.type === 'swarm' && u.region === sel())
        .sort((a, b) => (b.strength || 0) - (a.strength || 0));
      const n = Math.min(S.ui.swarmSend ?? here.length, here.length);
      const units = here.slice(0, n).map((u) => u.id);
      if (!units.length) break;
      if (act === 'disband-group') addOrder({ kind: 'disband_group', units });
      else { S.ui.pick = { type: 'retarget-group', units }; S.ui.tab = 'map'; render(); }
      break;
    }
    case 'rally': {
      const units = view().units.filter((u) => u.owner === mySide() && u.type === 'swarm').map((u) => u.id);
      if (units.length) addOrder({ kind: 'retarget_group', units, target: sel() });
      break;
    }
    case 'claim': addOrder({ kind: 'claim', region: sel() }); break;
    case 'swarm':
    case 'worm': {
      const kind = act === 'swarm' ? 'build_swarm' : 'build_worm';
      const ops = idleOpsRegions();
      if (!ops.length) break;
      const r = region(sel());
      const aimable = act === 'worm' && (r?.nodes || r?.intel?.nodes || []).length > 0;
      if (ops.length === 1 && !aimable) addOrder({ kind, target: sel(), facility: ops[0] });
      else { S.ui.attackMenu = S.ui.attackMenu === act ? null : act; S.ui.wormAim = null; render(); }
      break;
    }
    case 'worm-aim': S.ui.wormAim = arg; render(); break;
    case 'attack-from': {
      const kind = S.ui.attackMenu === 'worm' ? 'build_worm' : 'build_swarm';
      const o = { kind, target: sel(), facility: arg };
      if (kind === 'build_worm' && S.ui.wormAim && S.ui.wormAim !== 'auto') o.targetNode = S.ui.wormAim;
      addOrder(o);
      break;
    }
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
    case 'unqueue': {
      const [removed] = S.ui.pending.splice(Number(arg), 1);
      if (removed?.standing) {
        // Removing a ↻ chip also stops the automation behind it.
        const list = standingList();
        const i = list.findIndex((s) => s.kind === removed.kind && s.region === removed.region);
        if (i >= 0) list.splice(i, 1);
      }
      sfx('unqueue');
      render();
      break;
    }
    case 'toggle-sound': ensureAudio(); toggleSound(); render(); break;
    case 'lock':
      // Nudge players who lock straight from the report without re-checking
      // the map — a second click confirms.
      if (!S.ui.sawMap && !S.ui.lockConfirm) {
        S.ui.lockConfirm = true;
        render();
        break;
      }
      S.ui.lockConfirm = false;
      sfx('lock');
      lockIn();
      break;
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
  if (ev.target.id === 'swarm-slider') {
    // Update the label live without re-rendering (that would kill the drag).
    S.ui.swarmSend = Number(ev.target.value);
    const here = view().units
      .filter((u) => u.owner === mySide() && u.type === 'swarm' && u.region === S.ui.selected)
      .sort((a, b) => (b.strength || 0) - (a.strength || 0));
    const n = Math.min(S.ui.swarmSend, here.length);
    const sel = here.slice(0, n).reduce((s, u) => s + (u.strength || 0), 0);
    const label = document.getElementById('swarm-send-label');
    if (label) label.textContent = `${n} group${n === 1 ? '' : 's'} (strength ${sel})`;
  }
});

$app.addEventListener('change', (ev) => {
  if (ev.target.id === 'map-in') {
    localStorage.setItem('sd_map', ev.target.value);
    const blurb = document.getElementById('map-blurb');
    if (blurb) blurb.textContent = MAPS[ev.target.value]?.blurb || '';
  }
});

$app.addEventListener('change', (ev) => {
  if (ev.target.id !== 'import-in' || !ev.target.files?.[0]) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const save = JSON.parse(reader.result);
      if (!save?.state?.regions) throw new Error('not a save');
      localStorage.setItem(SAVE_KEY, JSON.stringify(save));
      startLocal(save.names?.A || 'Player 1', save.names?.B || 'Player 2', { ai: !!save.ai, aiLevel: save.aiLevel || 'ruthless', restored: save.state });
    } catch {
      S.err = 'That file is not a SIGNAL DOMINION save.';
      render();
    }
  };
  reader.readAsText(ev.target.files[0]);
});

function chosenMap() {
  const id = document.getElementById('map-in')?.value || localStorage.getItem('sd_map') || DEFAULT_MAP;
  localStorage.setItem('sd_map', id);
  return id;
}

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
  const w = Number(scaleEl.dataset.w) || 880;
  const h = Number(scaleEl.dataset.h) || 545;
  const wrap = scaleEl.parentElement;
  const availW = wrap.clientWidth - 40;
  const availH = wrap.clientHeight - 100; // leave room for the legend row
  const scale = Math.min(1.6, availW / w, availH / h); // fill the space, don't just shrink
  const x = Math.max(20, (wrap.clientWidth - w * scale) / 2);
  const y = Math.max(16, (wrap.clientHeight - 90 - h * scale) / 2);
  scaleEl.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
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
