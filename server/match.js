// One live match: two seats, a planning phase with an optional shared
// deadline, and the "collect both order sets → resolve → notify" loop.
// The server is authoritative — clients only ever see buildView() output.

import { createMatch, validateOrders, resolveTurn } from '../shared/engine.js';
import { buildView } from '../shared/view.js';
import { RULES } from '../shared/constants.js';

const SIDES = ['A', 'B'];
const GRACE_MS = 2500;

export class Match {
  constructor(code, pacing = 'live') {
    this.code = code;
    this.pacing = pacing === 'relaxed' ? 'relaxed' : 'live';
    this.phase = 'lobby'; // lobby -> planning -> over
    this.players = { A: null, B: null };
    this.state = null;
    this.logs = { A: [], B: [] };
    this.deadline = null;
    this.timer = null;
    this.lastActivity = Date.now();
  }

  touch() {
    this.lastActivity = Date.now();
  }

  seatFor(secret) {
    return SIDES.find((s) => this.players[s]?.secret === secret) || null;
  }

  addPlayer(ws, name, secret) {
    const side = !this.players.A ? 'A' : !this.players.B ? 'B' : null;
    if (!side) return null;
    this.players[side] = {
      side,
      name: String(name || `Player ${side}`).slice(0, 24),
      secret,
      ws,
      connected: true,
      ready: false,
      locked: false,
      orders: [],
      lockResult: null,
    };
    this.touch();
    return side;
  }

  attach(ws, side) {
    const p = this.players[side];
    if (!p) return false;
    if (p.ws && p.ws !== ws) {
      try { p.ws.close(4000, 'replaced by another connection'); } catch { /* ignore */ }
    }
    p.ws = ws;
    p.connected = true;
    this.touch();
    return true;
  }

  detach(ws) {
    for (const side of SIDES) {
      const p = this.players[side];
      if (p && p.ws === ws) {
        p.ws = null;
        p.connected = false;
        this.touch();
        this.syncAll();
        return side;
      }
    }
    return null;
  }

  setReady(side, ready) {
    const p = this.players[side];
    if (!p || this.phase !== 'lobby') return;
    p.ready = !!ready;
    this.touch();
    if (this.players.A?.ready && this.players.B?.ready) this.start();
    else this.syncAll();
  }

  start() {
    this.state = createMatch({ A: this.players.A.name, B: this.players.B.name });
    this.phase = 'planning';
    this.startPlanning();
  }

  startPlanning() {
    for (const side of SIDES) {
      const p = this.players[side];
      p.locked = false;
      p.orders = [];
    }
    if (this.pacing === 'live') {
      this.deadline = Date.now() + RULES.planningSeconds * 1000;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.onDeadline(), RULES.planningSeconds * 1000 + GRACE_MS);
    } else {
      this.deadline = null;
    }
    this.syncAll();
  }

  lockOrders(side, orders) {
    const p = this.players[side];
    if (!p || this.phase !== 'planning' || p.locked) return;
    const { accepted, rejected } = validateOrders(this.state, side, orders);
    p.orders = accepted;
    p.locked = true;
    p.lockResult = {
      accepted: accepted.length,
      rejected: rejected.map((r) => ({ kind: r.order.kind, reason: r.reason })),
    };
    this.touch();
    if (this.players.A.locked && this.players.B.locked) this.resolve();
    else this.syncAll();
  }

  onDeadline() {
    if (this.phase !== 'planning') return;
    for (const side of SIDES) {
      const p = this.players[side];
      if (!p.locked) {
        p.locked = true;
        p.orders = [];
        p.lockResult = { accepted: 0, rejected: [], timedOut: true };
      }
    }
    this.resolve();
  }

  resolve() {
    clearTimeout(this.timer);
    const { state, logs } = resolveTurn(this.state, {
      A: this.players.A.orders,
      B: this.players.B.orders,
    });
    this.state = state;
    this.logs = logs;
    this.touch();
    if (state.winner) {
      this.phase = 'over';
      this.deadline = null;
      this.syncAll({ resolved: true });
    } else {
      // startPlanning syncs; flag the fresh resolution so clients replay it.
      for (const side of SIDES) {
        this.players[side].locked = false;
        this.players[side].orders = [];
      }
      if (this.pacing === 'live') {
        this.deadline = Date.now() + RULES.planningSeconds * 1000;
        this.timer = setTimeout(() => this.onDeadline(), RULES.planningSeconds * 1000 + GRACE_MS);
      } else {
        this.deadline = null;
      }
      this.syncAll({ resolved: true });
    }
  }

  messageFor(side, extra = {}) {
    const p = this.players[side];
    const opp = this.players[side === 'A' ? 'B' : 'A'];
    return {
      t: 'sync',
      ...extra,
      match: {
        code: this.code,
        pacing: this.pacing,
        phase: this.phase,
        deadline: this.deadline,
        planningSeconds: RULES.planningSeconds,
      },
      you: {
        side,
        name: p.name,
        ready: p.ready,
        locked: p.locked,
        lockResult: p.lockResult,
      },
      opp: opp
        ? { name: opp.name, connected: opp.connected, ready: opp.ready, locked: opp.locked }
        : null,
      view: this.state ? buildView(this.state, side) : null,
      log: this.logs[side] || [],
    };
  }

  syncAll(extra = {}) {
    for (const side of SIDES) {
      const p = this.players[side];
      if (p?.ws && p.ws.readyState === 1) {
        p.ws.send(JSON.stringify(this.messageFor(side, extra)));
      }
    }
  }

  isAbandoned(maxIdleMs) {
    const idle = Date.now() - this.lastActivity;
    const nobodyHome = SIDES.every((s) => !this.players[s] || !this.players[s].connected);
    return (nobodyHome && idle > maxIdleMs) || (this.phase === 'over' && idle > maxIdleMs);
  }

  destroy() {
    clearTimeout(this.timer);
    for (const side of SIDES) {
      const p = this.players[side];
      if (p?.ws) {
        try { p.ws.close(4001, 'match closed'); } catch { /* ignore */ }
      }
    }
  }
}
