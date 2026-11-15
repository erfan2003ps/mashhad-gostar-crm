'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-sec-'));
const port = 3700 + Math.floor(Math.random() * 2000);
const child = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: Object.assign({}, process.env, {
    PORT: String(port),
    MG_HOST: '127.0.0.1',
    MG_DATA_DIR: tmp,
    MG_DATA_KEY: 'test-key-for-mashhad-gostar',
    MG_ADMIN_PASSWORD: '123456'
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});

function req(method, pathname, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: Object.assign({
        'X-MG-Request': '1',
        Accept: 'application/json'
      }, cookie ? { Cookie: cookie } : {}, data ? {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      } : {})
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        const setCookie = res.headers['set-cookie'];
        const cookieOut = Array.isArray(setCookie) ? setCookie.map(c => c.split(';')[0]).join('; ') : '';
        resolve({ status: res.statusCode, json, text, cookie: cookieOut });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server timeout')), 8000);
    child.stdout.on('data', () => { clearTimeout(t); resolve(); });
    child.stderr.on('data', d => process.stderr.write(d));
    child.on('exit', code => reject(new Error('server exited ' + code)));
  });

  const openGet = await req('GET', '/api/state');
  assert(openGet.status === 401, 'GET /api/state بدون ورود باید ۴۰۱ باشد، بود ' + openGet.status);

  const openPost = await req('POST', '/api/state', { body: { payload: { customers: [], deals: [], quotes: [] } } });
  assert(openPost.status === 401, 'POST /api/state بدون ورود باید ۴۰۱ باشد، بود ' + openPost.status);

  const missing = await req('GET', '/server.js');
  assert(missing.status === 404, 'فایل سرور نباید سرو شود');

  const bad = await req('POST', '/api/login', { body: { username: 'admin', password: 'wrong-pass' } });
  assert(bad.status === 401, 'رمز اشتباه باید رد شود');

  const login = await req('POST', '/api/login', { body: { username: 'admin', password: '123456' } });
  assert(login.status === 200 && login.cookie.includes('mg_session='), 'ورود مدیر باید کوکی HttpOnly بسازد');
  assert(login.json.mustChangePassword === true, 'رمز اولیه باید تعویض اجباری داشته باشد');
  assert(!JSON.stringify(login.json).includes('passHash'), 'پاسخ ورود نباید هش رمز داشته باشد');
  assert(!JSON.stringify(login.json).includes('123456'), 'پاسخ ورود نباید رمز را برگرداند');

  const blocked = await req('GET', '/api/state', { cookie: login.cookie });
  assert(blocked.status === 403, 'قبل از تعویض رمز، خواندن داده باید بسته باشد');

  const weak = await req('POST', '/api/password', { cookie: login.cookie, body: { password: '123456789' } });
  assert(weak.status === 400, 'رمز ضعیف باید رد شود');

  const changed = await req('POST', '/api/password', { cookie: login.cookie, body: { password: 'Mashhad#2480' } });
  assert(changed.status === 200 && changed.json.mustChangePassword === false, 'تعویض رمز قوی باید قبول شود');

  const oldPw = await req('POST', '/api/login', { body: { username: 'admin', password: '123456' } });
  assert(oldPw.status === 401, 'رمز قبلی بعد از تعویض نباید کار کند');

  const state = await req('GET', '/api/state', { cookie: login.cookie });
  assert(state.status === 200, 'بعد از تعویض رمز باید داده خوانده شود');
  const dumped = JSON.stringify(state.json);
  assert(!dumped.includes('passHash') && !dumped.includes('passSalt') && !dumped.includes('"password"'), 'وضعیت سرور نباید رمز یا هش را به کلاینت بدهد');

  const agent = await req('POST', '/api/login', { body: { username: 'sales1', password: '123456' } });
  assert(agent.status === 200, 'ورود کارشناس');
  await req('POST', '/api/password', { cookie: agent.cookie, body: { password: 'Sales#one91' } });

  const seeded = await req('POST', '/api/state', {
    cookie: login.cookie,
    body: {
      payload: {
        customers: [{ id: 'c1', name: 'مشتری محرمانه تست' }],
        deals: [{ id: 'd1', title: 'معامله' }],
        quotes: [{ id: 'q1', productName: 'پکیج' }],
        missedCalls: [{ id: 'm1', phone: '09120000000' }],
        canceledDeals: [],
        archivedDeals: [],
        categories: ['گرمایش'],
        allScenarios: []
      }
    }
  });
  assert(seeded.status === 200, 'ذخیره مدیر باید موفق باشد ' + seeded.status);

  const wipe = await req('POST', '/api/state', {
    cookie: agent.cookie,
    body: { payload: { customers: [], deals: [], quotes: [], missedCalls: [], canceledDeals: [], archivedDeals: [] } }
  });
  assert(wipe.status === 403, 'کارشناس بدون مجوز حذف نباید بتواند داده را پاک کند');

  const after = await req('GET', '/api/state', { cookie: login.cookie });
  assert(after.json.payload.customers.some(c => c.id === 'c1'), 'داده بعد از تلاش حذف باید سر جایش باشد');

  const file = fs.readFileSync(path.join(tmp, 'state.enc'));
  assert(!file.slice(0, 1).equals(Buffer.from('{')), 'فایل دیسک نباید JSON خام باشد');
  assert(!file.includes(Buffer.from('مشتری محرمانه تست')), 'نام مشتری نباید در فایل رمزشده پیدا شود');
  assert(file.slice(0, 3).toString() === 'MG1', 'فایل باید با قالب رمز AES ذخیره شود');

  console.log('security-check: ok');
  child.kill('SIGTERM');
  process.exit(0);
})().catch(err => {
  console.error(err);
  child.kill('SIGTERM');
  process.exit(1);
});
