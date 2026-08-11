// End-to-end: boots the real server, connects two WebSocket clients, walks
// them through create → join-by-code → ready → planning → lock → resolution,
// and checks reconnection with a seat token.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';

process.env.PORT = '0'; // pick a free port
const { server } = await import('../server/index.js');
await once(server, 'listening');
const port = server.address().port;
const url = `ws://127.0.0.1:${port}`;

function connect() {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.fn(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  ws.next = (fn = () => true, timeoutMs = 5000) => {
    const i = inbox.findIndex(fn);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
      waiters.push({ fn, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  };
  ws.push = (msg) => ws.send(JSON.stringify(msg));
  return new Promise((resolve) => ws.on('open', () => resolve(ws)));
}

test.after(() => server.close());

test('two players: create, join by code, ready, lock orders, resolve', async (t) => {
  const p1 = await connect();
  const p2 = await connect();
  t.after(() => { p1.close(); p2.close(); });

  // Player 1 creates a relaxed (no timer) match and gets a code + token.
  p1.push({ t: 'create', name: 'Meridian', pacing: 'relaxed' });
  const joined1 = await p1.next((m) => m.t === 'joined');
  assert.equal(joined1.side, 'A');
  assert.match(joined1.code, /^[A-Z2-9]{4}$/);
  assert.ok(joined1.token.startsWith(joined1.code + '.'));

  // Player 2 joins with the code.
  p2.push({ t: 'join', code: joined1.code.toLowerCase(), name: 'Kestrel' });
  const joined2 = await p2.next((m) => m.t === 'joined');
  assert.equal(joined2.side, 'B');

  // Both see each other in the lobby.
  const lobby1 = await p1.next((m) => m.t === 'sync' && m.opp?.name === 'Kestrel');
  assert.equal(lobby1.match.phase, 'lobby');

  // Ready up → match starts, both get fog-filtered views.
  p1.push({ t: 'ready', ready: true });
  p2.push({ t: 'ready', ready: true });
  const started1 = await p1.next((m) => m.t === 'sync' && m.match.phase === 'planning');
  const started2 = await p2.next((m) => m.t === 'sync' && m.match.phase === 'planning');
  assert.equal(started1.view.turn, 1);
  assert.equal(started1.view.side, 'A');
  assert.equal(started2.view.side, 'B');
  assert.equal(started1.view.regions.aldermoor.owner, 'A');
  assert.equal(started1.view.regions.kestrave.nodes, null, 'fog: enemy capital contents hidden');

  // A locks a claim order; B sees "opponent locked" but no resolution yet.
  p1.push({ t: 'lock', orders: [{ kind: 'claim', region: 'ilsmere' }] });
  const oppLocked = await p2.next((m) => m.t === 'sync' && m.opp?.locked === true);
  assert.equal(oppLocked.view.turn, 1, 'turn does not resolve until both lock');

  // B locks too → turn resolves for both.
  p2.push({ t: 'lock', orders: [] });
  const r1 = await p1.next((m) => m.t === 'sync' && m.resolved);
  const r2 = await p2.next((m) => m.t === 'sync' && m.resolved);
  assert.equal(r1.view.turn, 2);
  assert.equal(r2.view.turn, 2);
  assert.equal(r1.you.lockResult.accepted, 1);
  assert.ok(r1.view.you.builds.some((b) => b.kind === 'claim'), 'claim in progress');
  assert.ok(r1.log.length > 0, 'resolution log delivered');

  // One more turn: the claim completes and both clients see the map change.
  p1.push({ t: 'lock', orders: [] });
  p2.push({ t: 'lock', orders: [] });
  const r3 = await p2.next((m) => m.t === 'sync' && m.resolved && m.view.turn === 3);
  assert.equal(r3.view.regions.ilsmere.owner, 'A', 'B sees A expand (topology is public)');

  // Reconnection: P1 drops, comes back with the token, gets current state.
  p1.close();
  const dropSeen = await p2.next((m) => m.t === 'sync' && m.opp?.connected === false);
  assert.ok(dropSeen);
  const p1b = await connect();
  t.after(() => p1b.close());
  p1b.push({ t: 'rejoin', token: joined1.token });
  const rejoined = await p1b.next((m) => m.t === 'joined');
  assert.equal(rejoined.rejoined, true);
  const stateBack = await p1b.next((m) => m.t === 'sync');
  assert.equal(stateBack.view.turn, 3);
  assert.equal(stateBack.view.regions.ilsmere.owner, 'A');
});

test('joining a bad code fails cleanly; quick match pairs strangers', async (t) => {
  const p1 = await connect();
  const p2 = await connect();
  t.after(() => { p1.close(); p2.close(); });

  p1.push({ t: 'join', code: 'ZZZZ', name: 'Lost' });
  const err = await p1.next((m) => m.t === 'error');
  assert.match(err.error, /No match/);

  p1.push({ t: 'quick', name: 'Stranger 1' });
  const waiting = await p1.next((m) => m.t === 'waiting');
  assert.ok(waiting.note);
  p2.push({ t: 'quick', name: 'Stranger 2' });
  const j1 = await p1.next((m) => m.t === 'joined');
  const j2 = await p2.next((m) => m.t === 'joined');
  assert.equal(j1.code, j2.code, 'both landed in the same match');
  assert.notEqual(j1.side, j2.side);
});
