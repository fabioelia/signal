// SIGNAL DOMINION server: static file host + WebSocket lobby.
//
// How two players connect and join a game:
//   1. Player 1 opens the site, enters a display name and clicks
//      "Create match" — the server makes a match with a 4-letter code and
//      seats them as side A. The UI shows the code and a shareable link
//      (https://host/?code=XXXX).
//   2. Player 2 opens the site (or the link), enters the code and joins as
//      side B. Alternatively both can press "Quick match" to be paired with
//      the next stranger in the queue.
//   3. Both press Ready in the match lobby; the match starts and the WEGO
//      planning/resolution loop runs over the same socket.
//   4. Each seat gets a secret rejoin token (stored client-side); reloading
//      the page or dropping the connection re-attaches to the same seat with
//      full state.

import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Match } from './match.js';

const PORT = Number(process.env.PORT) || 3000;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MATCH_IDLE_MS = 60 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = url.pathname;
    if (path === '/' || path === '/index.html') path = '/public/index.html';
    else if (!path.startsWith('/shared/')) path = `/public${path}`;
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(normalize(ROOT))) throw new Error('nope');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});

const wss = new WebSocketServer({ server });
const matches = new Map(); // code -> Match
let quickWaiting = null; // { ws, name } of the player waiting for a stranger

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  let code = '';
  do {
    code = Array.from(crypto.randomBytes(4), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  } while (matches.has(code));
  return code;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function joinSeat(ws, match, name) {
  const secret = crypto.randomUUID();
  const side = match.addPlayer(ws, name, secret);
  if (!side) {
    send(ws, { t: 'error', error: 'That match is already full.' });
    return null;
  }
  ws._seat = { match, side };
  send(ws, { t: 'joined', code: match.code, side, token: `${match.code}.${secret}` });
  match.syncAll();
  return side;
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { t: 'error', error: 'Bad message.' });
    }

    switch (msg.t) {
      case 'create': {
        const match = new Match(newCode(), msg.pacing);
        matches.set(match.code, match);
        joinSeat(ws, match, msg.name);
        break;
      }
      case 'join': {
        const code = String(msg.code || '').trim().toUpperCase();
        const match = matches.get(code);
        if (!match) return send(ws, { t: 'error', error: `No match with code ${code || '—'}. Check the code and try again.` });
        joinSeat(ws, match, msg.name);
        break;
      }
      case 'quick': {
        if (quickWaiting && quickWaiting.ws.readyState === 1 && quickWaiting.ws !== ws) {
          const { ws: otherWs, name: otherName } = quickWaiting;
          quickWaiting = null;
          const match = new Match(newCode(), 'live');
          matches.set(match.code, match);
          joinSeat(otherWs, match, otherName);
          joinSeat(ws, match, msg.name);
        } else {
          quickWaiting = { ws, name: msg.name };
          send(ws, { t: 'waiting', note: 'Waiting for another commander to appear…' });
        }
        break;
      }
      case 'rejoin': {
        const [code, secret] = String(msg.token || '').split('.');
        const match = matches.get(code);
        const side = match?.seatFor(secret);
        if (!match || !side) return send(ws, { t: 'error', error: 'That match is over or gone.', fatal: 'token' });
        match.attach(ws, side);
        ws._seat = { match, side };
        send(ws, { t: 'joined', code: match.code, side, token: msg.token, rejoined: true });
        match.syncAll();
        break;
      }
      case 'ready': {
        ws._seat?.match.setReady(ws._seat.side, msg.ready);
        break;
      }
      case 'lock': {
        ws._seat?.match.lockOrders(ws._seat.side, Array.isArray(msg.orders) ? msg.orders : []);
        break;
      }
      case 'ping':
        send(ws, { t: 'pong' });
        break;
      default:
        send(ws, { t: 'error', error: `Unknown message: ${msg.t}` });
    }
  });

  ws.on('close', () => {
    if (quickWaiting?.ws === ws) quickWaiting = null;
    ws._seat?.match.detach(ws);
  });
});

setInterval(() => {
  for (const [code, match] of matches) {
    if (match.isAbandoned(MATCH_IDLE_MS)) {
      match.destroy();
      matches.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`SIGNAL DOMINION listening on http://localhost:${PORT}`);
  console.log('Open it in two browser windows to play head-to-head.');
});

export { server, wss };
