'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA = process.env.MG_DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.MG_HOST || '0.0.0.0';
const HTML = path.join(ROOT, 'index-3.html');
const STATE_FILE = path.join(DATA, 'state.enc');
const KEY_FILE = path.join(DATA, 'master.key');
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_BODY = 12 * 1024 * 1024;
const WEAK = new Set(['123456', '123456789', 'password', 'admin123', 'mashhad', 'admin1234']);

const sessions = new Map();
const loginFails = new Map();

function ensureDataDir() {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
}

function loadKey() {
  ensureDataDir();
  if (process.env.MG_DATA_KEY) {
    return crypto.scryptSync(String(process.env.MG_DATA_KEY), 'mashhad-gostar-crm-v7', 32);
  }
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE);
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  console.warn('MG_DATA_KEY تنظیم نشده؛ کلید محلی در data/master.key ساخته شد. برای استقرار، MG_DATA_KEY را تنظیم کنید.');
  return key;
}

const DATA_KEY = loadKey();

function encryptJson(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', DATA_KEY, iv);
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from('MG1'), iv, tag, enc]);
}

function decryptJson(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 3 + 12 + 16 || buf.slice(0, 3).toString() !== 'MG1') {
    throw new Error('bad-state');
  }
  const iv = buf.slice(3, 15);
  const tag = buf.slice(15, 31);
  const enc = buf.slice(31);
  const decipher = crypto.createDecipheriv('aes-256-gcm', DATA_KEY, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function hashPass(password, salt) {
  const saltBuf = salt || crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), saltBuf, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { passSalt: saltBuf.toString('base64'), passHash: hash.toString('base64') };
}

function verifyPass(password, saltB64, hashB64) {
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (e) {
    return false;
  }
}

const DUMMY_HASH = hashPass('not-a-real-user-password');

function strongEnough(pw) {
  if (typeof pw !== 'string') return false;
  const s = pw.trim();
  if (s.length < 10 || s.length > 128) return false;
  if (WEAK.has(s.toLowerCase())) return false;
  if (!/[A-Za-z\u0600-\u06FF]/.test(s)) return false;
  if (!/[0-9۰-۹]/.test(s)) return false;
  return true;
}

function seedUser(partial, password) {
  const hashed = hashPass(password);
  const weak = !strongEnough(password);
  return Object.assign({
    canDelete: false,
    canExport: false,
    mustChange: weak
  }, partial, hashed);
}

const OWNER_USER = {
  id: 'usr-erfan',
  username: 'erfan',
  displayName: 'Erfan',
  role: 'admin',
  canDelete: true,
  canExport: true,
  mustChange: false,
  passSalt: '88pzfrf2VKU32KpQ4jHn/A==',
  passHash: 'UoSiTDeIU/NOTSjA+zQD+Bl+fq679Yj0txpxPhaKyJ4='
};

function ensureOwner(db) {
  if (!Array.isArray(db.users)) db.users = [];
  if (db.users.some(u => String(u.username || '').toLowerCase() === OWNER_USER.username)) return false;
  db.users.unshift(Object.assign({}, OWNER_USER));
  return true;
}

function freshDb() {
  const adminPass = process.env.MG_ADMIN_PASSWORD || '123456';
  return {
    updatedAt: new Date().toISOString(),
    updatedBy: 'system',
    customers: [],
    deals: [],
    quotes: [],
    missedCalls: [],
    canceledDeals: [],
    archivedDeals: [],
    categories: [],
    allScenarios: [],
    ws: { tasks: [], msgs: [], profiles: {} },
    users: [
      Object.assign({}, OWNER_USER),
      seedUser({
        id: 'usr-admin',
        username: 'admin',
        displayName: 'مدیر ارشد فروش',
        role: 'admin',
        canDelete: true,
        canExport: true
      }, adminPass),
      seedUser({
        id: 'usr-sales1',
        username: 'sales1',
        displayName: 'کارشناس فروش ۱',
        role: 'agent',
        canDelete: false,
        canExport: true
      }, '123456'),
      seedUser({
        id: 'usr-sales2',
        username: 'sales2',
        displayName: 'کارشناس فروش ۲',
        role: 'agent',
        canDelete: false,
        canExport: false
      }, '123456')
    ]
  };
}

let dbCache = null;

function loadDb() {
  if (dbCache) return dbCache;
  try {
    if (fs.existsSync(STATE_FILE)) {
      dbCache = decryptJson(fs.readFileSync(STATE_FILE));
      if (!dbCache || !Array.isArray(dbCache.users) || !dbCache.users.length) throw new Error('empty');
      if (ensureOwner(dbCache)) saveDb();
      return dbCache;
    }
  } catch (e) {
    console.error('خواندن پایگاه رمزشده ناموفق بود؛ پایگاه تازه ساخته می‌شود.');
  }
  dbCache = freshDb();
  saveDb();
  return dbCache;
}

function saveDb() {
  ensureDataDir();
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, encryptJson(dbCache), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

function pub(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    canDelete: u.role === 'admin' || !!u.canDelete,
    canExport: u.role === 'admin' || !!u.canExport
  };
}

function publicState(db) {
  return {
    customers: db.customers || [],
    deals: db.deals || [],
    quotes: db.quotes || [],
    missedCalls: db.missedCalls || [],
    canceledDeals: db.canceledDeals || [],
    archivedDeals: db.archivedDeals || [],
    categories: db.categories || [],
    allScenarios: db.allScenarios || [],
    ws: db.ws || { tasks: [], msgs: [], profiles: {} },
    users: (db.users || []).map(pub)
  };
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function clientIp(req) {
  if (process.env.MG_TRUST_PROXY === '1') {
    const x = req.headers['x-forwarded-for'];
    if (typeof x === 'string' && x) return x.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'local';
}

function tooManyLogins(key) {
  const now = Date.now();
  const row = loginFails.get(key) || { n: 0, reset: now + 15 * 60 * 1000 };
  if (now > row.reset) {
    loginFails.set(key, { n: 0, reset: now + 15 * 60 * 1000 });
    return false;
  }
  return row.n >= 8;
}

function markLoginFail(key) {
  const now = Date.now();
  const row = loginFails.get(key) || { n: 0, reset: now + 15 * 60 * 1000 };
  if (now > row.reset) {
    loginFails.set(key, { n: 1, reset: now + 15 * 60 * 1000 });
    return;
  }
  row.n += 1;
  loginFails.set(key, row);
}

function clearLoginFail(key) {
  loginFails.delete(key);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too-large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(Object.assign(new Error('bad-json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), geolocation=()',
    'X-Robots-Tag': 'noindex, nofollow'
  }, extraHeaders || {});
  res.writeHead(status, headers);
  res.end(body);
}

function cookieHeader(token, req) {
  const secure = process.env.FORCE_SECURE_COOKIE === '1' || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `mg_session=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie(req) {
  const secure = process.env.FORCE_SECURE_COOKIE === '1' || req.headers['x-forwarded-proto'] === 'https';
  return `mg_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

function getSession(req) {
  const token = parseCookies(req).mg_session;
  if (!token) return null;
  const row = sessions.get(token);
  if (!row) return null;
  if (Date.now() > row.exp) {
    sessions.delete(token);
    return null;
  }
  const db = loadDb();
  const user = db.users.find(u => u.username === row.username);
  if (!user) {
    sessions.delete(token);
    return null;
  }
  return { token, user };
}

function requireUser(req, res, opts) {
  const allowMustChange = opts && opts.allowMustChange;
  const sess = getSession(req);
  if (!sess) {
    send(res, 401, { error: 'auth', message: 'برای دیدن یا تغییر داده‌ها باید وارد شوید.' });
    return null;
  }
  if (sess.user.mustChange && !allowMustChange) {
    send(res, 403, { error: 'password-change-required', message: 'اول رمز عبور را عوض کنید.' });
    return null;
  }
  return sess;
}

function guardMutate(req, res) {
  if (req.headers['x-mg-request'] !== '1') {
    send(res, 403, { error: 'csrf', message: 'درخواست تأیید نشد.' });
    return false;
  }
  return true;
}

function asArray(v, fallback) {
  return Array.isArray(v) ? v : (fallback || []);
}

function removedIds(prevArr, nextArr) {
  const next = new Set(asArray(nextArr).map(x => x && x.id).filter(Boolean));
  return asArray(prevArr).map(x => x && x.id).filter(id => id && !next.has(id));
}

function assertRetention(user, prev, next) {
  if (user.role === 'admin' || user.canDelete) return;
  for (const key of ['customers', 'quotes', 'missedCalls']) {
    if (removedIds(prev[key], next[key]).length) {
      const err = new Error('delete-forbidden');
      err.status = 403;
      throw err;
    }
  }
  const accounted = new Set();
  asArray(next.canceledDeals).forEach(x => {
    if (x && x.sourceDealId) accounted.add(x.sourceDealId);
  });
  asArray(next.archivedDeals).forEach(x => {
    if (x && (x.sourceDealId || x.id)) accounted.add(x.sourceDealId || x.id);
  });
  const goneDeals = removedIds(prev.deals, next.deals);
  if (goneDeals.some(id => !accounted.has(id))) {
    const err = new Error('delete-forbidden');
    err.status = 403;
    throw err;
  }
}

function applyState(user, payload) {
  const db = loadDb();
  if (!payload || typeof payload !== 'object') {
    const err = new Error('bad-payload');
    err.status = 400;
    throw err;
  }
  const next = {
    customers: asArray(payload.customers, db.customers),
    deals: asArray(payload.deals, db.deals),
    quotes: asArray(payload.quotes, db.quotes),
    missedCalls: asArray(payload.missedCalls, db.missedCalls),
    canceledDeals: asArray(payload.canceledDeals, db.canceledDeals),
    archivedDeals: asArray(payload.archivedDeals, db.archivedDeals),
    categories: asArray(payload.categories, db.categories),
    allScenarios: asArray(payload.allScenarios, db.allScenarios)
  };
  if (!Array.isArray(payload.customers) || !Array.isArray(payload.deals) || !Array.isArray(payload.quotes)) {
    const err = new Error('bad-payload');
    err.status = 400;
    throw err;
  }
  assertRetention(user, db, next);
  db.customers = next.customers;
  db.deals = next.deals;
  db.quotes = next.quotes;
  db.missedCalls = next.missedCalls;
  db.canceledDeals = next.canceledDeals;
  db.archivedDeals = next.archivedDeals;
  db.categories = next.categories;
  db.allScenarios = next.allScenarios;
  if (payload.ws && typeof payload.ws === 'object') db.ws = payload.ws;
  db.updatedAt = new Date().toISOString();
  db.updatedBy = user.displayName || user.username;
  saveDb();
  return db;
}

function serveHtml(res) {
  const html = fs.readFileSync(HTML);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': html.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "frame-ancestors 'none'"
  });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index-3.html')) {
      return serveHtml(res);
    }
    if (req.method === 'GET' && pathname === '/api/health') {
      return send(res, 200, { ok: true });
    }
    if (pathname.startsWith('/api/') && req.method === 'POST' && !guardMutate(req, res)) return;

    if (req.method === 'GET' && pathname === '/api/me') {
      const sess = requireUser(req, res, { allowMustChange: true });
      if (!sess) return;
      return send(res, 200, { user: pub(sess.user), mustChangePassword: !!sess.user.mustChange });
    }

    if (req.method === 'POST' && pathname === '/api/login') {
      const body = await readBody(req);
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const key = clientIp(req) + '|' + username;
      if (tooManyLogins(key)) {
        return send(res, 429, { error: 'rate', message: 'تلاش زیاد بود. چند دقیقه بعد دوباره وارد شوید.' });
      }
      const db = loadDb();
      const user = db.users.find(u => u.username.toLowerCase() === username);
      const ok = user ? verifyPass(password, user.passSalt, user.passHash) : (verifyPass(password, DUMMY_HASH.passSalt, DUMMY_HASH.passHash) && false);
      if (!user || !ok) {
        markLoginFail(key);
        return send(res, 401, { error: 'auth', message: 'نام کاربری یا رمز عبور اشتباه است.' });
      }
      clearLoginFail(key);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { username: user.username, exp: Date.now() + SESSION_MS });
      return send(res, 200, { user: pub(user), mustChangePassword: !!user.mustChange }, {
        'Set-Cookie': cookieHeader(token, req)
      });
    }

    if (req.method === 'POST' && pathname === '/api/logout') {
      const sess = getSession(req);
      if (sess) sessions.delete(sess.token);
      return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(req) });
    }

    if (req.method === 'POST' && pathname === '/api/password') {
      const sess = requireUser(req, res, { allowMustChange: true });
      if (!sess) return;
      const body = await readBody(req);
      const password = String(body.password || '');
      if (!strongEnough(password)) {
        return send(res, 400, { error: 'weak', message: 'رمز باید حداقل ۱۰ کاراکتر و شامل حرف و عدد باشد و از رمزهای ساده نباشد.' });
      }
      if (verifyPass(password, sess.user.passSalt, sess.user.passHash)) {
        return send(res, 400, { error: 'same', message: 'رمز جدید باید با رمز فعلی فرق داشته باشد.' });
      }
      const hashed = hashPass(password);
      sess.user.passSalt = hashed.passSalt;
      sess.user.passHash = hashed.passHash;
      sess.user.mustChange = false;
      for (const [tok, row] of sessions) {
        if (row.username === sess.user.username && tok !== sess.token) sessions.delete(tok);
      }
      saveDb();
      return send(res, 200, { user: pub(sess.user), mustChangePassword: false });
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      const sess = requireUser(req, res);
      if (!sess) return;
      const db = loadDb();
      return send(res, 200, { updatedAt: db.updatedAt, updatedBy: db.updatedBy, payload: publicState(db) });
    }

    if (req.method === 'POST' && pathname === '/api/state') {
      const sess = requireUser(req, res);
      if (!sess) return;
      const body = await readBody(req);
      try {
        const db = applyState(sess.user, body.payload || body);
        return send(res, 200, { updatedAt: db.updatedAt, updatedBy: db.updatedBy });
      } catch (e) {
        const status = e.status || 400;
        const message = status === 403
          ? 'سطح دسترسی شما اجازه حذف این رکوردها را نمی‌دهد.'
          : 'داده ارسالی نامعتبر است.';
        return send(res, status, { error: e.message || 'bad', message });
      }
    }

    if (req.method === 'POST' && pathname === '/api/users') {
      const sess = requireUser(req, res);
      if (!sess) return;
      if (sess.user.role !== 'admin') return send(res, 403, { error: 'forbidden', message: 'فقط مدیر کل می‌تواند کاربران را تغییر دهد.' });
      const body = await readBody(req);
      const db = loadDb();
      const username = String(body.username || '').trim().toLowerCase();
      const displayName = String(body.displayName || '').trim();
      const role = body.role === 'admin' ? 'admin' : 'agent';
      if (!username || !/^[a-z0-9._-]{2,32}$/.test(username) || !displayName) {
        return send(res, 400, { error: 'bad-user', message: 'نام نمایشی و نام کاربری انگلیسی لازم است.' });
      }
      let target = body.id ? db.users.find(u => u.id === body.id) : null;
      if (!target) target = db.users.find(u => u.username === username);
      const password = body.password ? String(body.password) : '';
      if (target) {
        const nextRole = target.username === 'admin' ? 'admin' : role;
        const adminsLeft = db.users.filter(u => u.role === 'admin' && u.id !== target.id).length + (nextRole === 'admin' ? 1 : 0);
        if (!adminsLeft) return send(res, 400, { error: 'last-admin', message: 'حداقل یک مدیر باید بماند.' });
      }
      if (!target) {
        if (!strongEnough(password)) {
          return send(res, 400, { error: 'weak', message: 'برای کاربر جدید رمز قوی بگذارید: حداقل ۱۰ کاراکتر، حرف و عدد.' });
        }
        if (db.users.some(u => u.username === username)) {
          return send(res, 409, { error: 'exists', message: 'این نام کاربری قبلاً ثبت شده است.' });
        }
        const hashed = hashPass(password);
        db.users.push(Object.assign({
          id: 'usr-' + Date.now(),
          username,
          displayName,
          role,
          canDelete: role === 'admin' ? true : !!body.canDelete,
          canExport: role === 'admin' ? true : !!body.canExport,
          mustChange: false
        }, hashed));
      } else {
        if (password && !strongEnough(password)) {
          return send(res, 400, { error: 'weak', message: 'رمز جدید باید حداقل ۱۰ کاراکتر و شامل حرف و عدد باشد.' });
        }
        if (target.username === 'admin') target.role = 'admin';
        else target.role = role;
        target.displayName = displayName;
        if (target.username !== 'admin') target.username = username;
        target.canDelete = target.role === 'admin' ? true : !!body.canDelete;
        target.canExport = target.role === 'admin' ? true : !!body.canExport;
        if (password) {
          const hashed = hashPass(password);
          target.passSalt = hashed.passSalt;
          target.passHash = hashed.passHash;
          target.mustChange = false;
          for (const [tok, row] of sessions) {
            if (row.username === target.username) sessions.delete(tok);
          }
        }
      }
      saveDb();
      return send(res, 200, { users: db.users.map(pub) });
    }

    if (req.method === 'POST' && pathname === '/api/users/delete') {
      const sess = requireUser(req, res);
      if (!sess) return;
      if (sess.user.role !== 'admin') return send(res, 403, { error: 'forbidden', message: 'فقط مدیر کل می‌تواند کاربر حذف کند.' });
      const body = await readBody(req);
      const db = loadDb();
      const target = db.users.find(u => u.id === body.id);
      if (!target) return send(res, 404, { error: 'missing', message: 'کاربر پیدا نشد.' });
      if (target.username === 'admin') return send(res, 400, { error: 'protected', message: 'حساب مدیر اصلی حذف نمی‌شود.' });
      db.users = db.users.filter(u => u.id !== target.id);
      if (!db.users.some(u => u.role === 'admin')) {
        return send(res, 400, { error: 'last-admin', message: 'حداقل یک مدیر باید بماند.' });
      }
      for (const [tok, row] of sessions) {
        if (row.username === target.username) sessions.delete(tok);
      }
      saveDb();
      return send(res, 200, { users: db.users.map(pub) });
    }

    send(res, 404, { error: 'not-found' });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: 'server', message: 'خطای داخلی سرور' });
  }
});

if (require.main === module) {
  loadDb();
  server.listen(PORT, HOST, () => {
    console.log('مشهد گستر روی http://' + HOST + ':' + PORT);
  });
}

module.exports = { server, loadDb, DATA };
