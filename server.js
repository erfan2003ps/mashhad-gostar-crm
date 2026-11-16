/**
 * Mashhad Gostar CRM — Concurrent merge server (no login encryption layer)
 * - Merge-by-ID + updatedAt / soft-delete
 * - SSE realtime hints on /api/chat/stream
 * - Delta GET /api/state?since=ISO
 * - Buffered disk writes
 * - Daily backups in ./backups
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.MG_DATA_DIR || path.join(__dirname, 'data');
const BACKUP_DIR = path.join(__dirname, 'backups');
const STATE_FILE = path.join(DATA_DIR, 'crm_state_v8.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

let serverState = {
  updatedAt: new Date().toISOString(),
  updatedBy: 'سیستم',
  revision: 0,
  payload: {
    customers: [],
    deals: [],
    quotes: [],
    missedCalls: [],
    canceledDeals: [],
    serviceReminders: [],
    categories: [],
    users: [],
    ws: { tasks: [], msgs: [], profiles: {}, pins: {}, readBy: {} }
  }
};

if (fs.existsSync(STATE_FILE)) {
  try {
    serverState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!serverState.revision) serverState.revision = 0;
    if (!serverState.payload) serverState.payload = {};
    serverState.payload.ws = serverState.payload.ws || { tasks: [], msgs: [], profiles: {}, pins: {}, readBy: {} };
  } catch (e) {
    console.error('Failed to read initial state file:', e.message);
  }
}

function mergeById(existingArr = [], incomingArr = [], tsKey = 'updatedAt') {
  const map = new Map();
  (Array.isArray(existingArr) ? existingArr : []).forEach(item => {
    if (item && item.id) map.set(item.id, item);
  });
  (Array.isArray(incomingArr) ? incomingArr : []).forEach(item => {
    if (!item || !item.id) return;
    const prev = map.get(item.id);
    const incTs = item[tsKey] || item.u || item.t || 0;
    const prevTs = prev ? (prev[tsKey] || prev.u || prev.t || 0) : -1;
    if (!prev || incTs >= prevTs) map.set(item.id, item);
  });
  return Array.from(map.values()).filter(item => !item.deleted && !item.del);
}

let writeTimer = null;
let writePending = false;
function scheduleWrite() {
  writePending = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (!writePending) return;
    writePending = false;
    try {
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(serverState), 'utf8');
      fs.renameSync(tmp, STATE_FILE);
      writeDailyBackup();
    } catch (e) {
      console.error('state write failed', e.message);
    }
  }, 350);
}

function writeDailyBackup() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const backupFile = path.join(BACKUP_DIR, `crm_backup_${today}.json`);
    if (!fs.existsSync(backupFile)) {
      fs.writeFileSync(backupFile, JSON.stringify(serverState), 'utf8');
    }
  } catch (e) {}
}

const sseClients = new Set();
function broadcastSSE(eventData) {
  const payload = `data: ${JSON.stringify(eventData)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) { sseClients.delete(res); }
  }
}

function sendJson(req, res, code, obj) {
  const raw = Buffer.from(JSON.stringify(obj), 'utf8');
  const accept = String(req.headers['accept-encoding'] || '');
  if (accept.includes('gzip') && raw.length > 1024) {
    const gz = zlib.gzipSync(raw);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Cache-Control': 'no-store'
    });
    return res.end(gz);
  }
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(raw);
}

function filterSince(arr, sinceMs, tsKey = 'updatedAt') {
  if (!sinceMs) return arr || [];
  return (arr || []).filter(item => {
    const ts = item[tsKey] || item.u || item.t || 0;
    const n = typeof ts === 'string' ? Date.parse(ts) : Number(ts);
    return !Number.isFinite(n) || n >= sinceMs;
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/chat/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', updatedAt: serverState.updatedAt, revision: serverState.revision || 0 })}\n\n`);
    sseClients.add(res);
    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) { clearInterval(hb); sseClients.delete(res); }
    }, 25000);
    req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
    return;
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    return sendJson(req, res, 200, {
      ok: true,
      updatedAt: serverState.updatedAt,
      revision: serverState.revision || 0,
      sseClients: sseClients.size
    });
  }

  if (url.pathname === '/api/ws' && req.method === 'GET') {
    const sinceRaw = url.searchParams.get('since');
    const sinceMs = sinceRaw ? Date.parse(sinceRaw) : 0;
    const ws = serverState.payload.ws || { tasks: [], msgs: [], profiles: {}, pins: {}, readBy: {} };
    return sendJson(req, res, 200, {
      updatedAt: serverState.updatedAt,
      revision: serverState.revision || 0,
      ws: {
        tasks: filterSince(ws.tasks, sinceMs, 'u'),
        msgs: filterSince(ws.msgs, sinceMs, 'u'),
        profiles: ws.profiles || {},
        pins: ws.pins || {},
        readBy: ws.readBy || {}
      }
    });
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const sinceRaw = url.searchParams.get('since');
    if (sinceRaw) {
      const sinceMs = Date.parse(sinceRaw) || 0;
      if (serverState.updatedAt && Date.parse(serverState.updatedAt) <= sinceMs) {
        return sendJson(req, res, 200, { unchanged: true, updatedAt: serverState.updatedAt, revision: serverState.revision || 0 });
      }
    }
    return sendJson(req, res, 200, serverState);
  }

  if (url.pathname === '/api/state' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 40 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body || '{}');
        const p = incoming.payload || {};
        const cur = serverState.payload;

        cur.customers = mergeById(cur.customers, p.customers, 'updatedAt');
        cur.deals = mergeById(cur.deals, p.deals, 'updatedAt');
        cur.quotes = mergeById(cur.quotes, p.quotes, 'updatedAt');
        cur.missedCalls = mergeById(cur.missedCalls, p.missedCalls, 'updatedAt');
        cur.canceledDeals = mergeById(cur.canceledDeals, p.canceledDeals, 'updatedAt');
        cur.serviceReminders = mergeById(cur.serviceReminders, p.serviceReminders, 'updatedAt');

        if (Array.isArray(p.categories) && p.categories.length > 0) {
          cur.categories = Array.from(new Set([...(cur.categories || []), ...p.categories]));
        }
        if (Array.isArray(p.allScenarios) && p.allScenarios.length > 0) {
          cur.allScenarios = p.allScenarios;
        }
        if (Array.isArray(p.users) && p.users.length > 0) {
          cur.users = mergeById(cur.users, p.users, 'id');
        }
        if (p.ws) {
          cur.ws = cur.ws || { tasks: [], msgs: [], profiles: {}, pins: {}, readBy: {} };
          cur.ws.tasks = mergeById(cur.ws.tasks, p.ws.tasks, 'u');
          cur.ws.msgs = mergeById(cur.ws.msgs, p.ws.msgs, 'u');
          cur.ws.pins = Object.assign({}, cur.ws.pins || {}, p.ws.pins || {});
          cur.ws.readBy = Object.assign({}, cur.ws.readBy || {}, p.ws.readBy || {});
          Object.keys(p.ws.profiles || {}).forEach(k => {
            if (!cur.ws.profiles[k] || (p.ws.profiles[k].u || 0) >= (cur.ws.profiles[k].u || 0)) {
              cur.ws.profiles[k] = p.ws.profiles[k];
            }
          });
          if (Array.isArray(p.ws.customPeers)) cur.ws.customPeers = p.ws.customPeers;
          if (Array.isArray(p.ws.hiddenConvs)) cur.ws.hiddenConvs = p.ws.hiddenConvs;
        }

        // migrate legacy invoice stage server-side
        (cur.deals || []).forEach(d => { if (d && d.stage === 'invoice') d.stage = 'ready'; });

        serverState.updatedAt = new Date().toISOString();
        serverState.updatedBy = incoming.updatedBy || 'کارشناس';
        serverState.revision = (serverState.revision || 0) + 1;

        scheduleWrite();
        broadcastSSE({ type: 'state_updated', updatedAt: serverState.updatedAt, updatedBy: serverState.updatedBy, revision: serverState.revision });

        sendJson(req, res, 200, { ok: true, updatedAt: serverState.updatedAt, revision: serverState.revision });
      } catch (err) {
        sendJson(req, res, 400, { ok: false, error: err.message });
      }
    });
    return;
  }

  if (url.pathname === '/sw.js') {
    const swFile = path.join(__dirname, 'sw.js');
    if (fs.existsSync(swFile)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      return res.end(fs.readFileSync(swFile));
    }
  }

  const htmlCandidates = ['index.html', 'index-1.html'];
  for (const name of htmlCandidates) {
    const full = path.join(__dirname, name);
    if (fs.existsSync(full)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(full));
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Mashhad Gostar CRM Server');
});

server.listen(PORT, () => {
  console.log(`Mashhad Gostar CRM listening on port ${PORT}`);
});
