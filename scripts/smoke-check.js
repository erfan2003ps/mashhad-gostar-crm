#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const http = require('http');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const checks = [
  [/kpi-card-today/, 'KPI کارهای امروز'],
  [/kpi-card-members/, 'KPI مشتریان'],
  [/kpi-card-referrals/, 'KPI ارجاع‌شده‌ها'],
  [/kpi-card-done-tasks/, 'KPI کارهای انجام‌شده'],
  [/آلارم سرویس/, 'آلارم سرویس UI'],
  [/ps-list-time-filter|جدیدترین‌ها \(امروز و دیروز\)/, 'فیلتر جدیدترین استودیو قیمت'],
  [/ws-msg-date-filters/, 'فیلتر تاریخ گپ'],
  [/msgPassesDateFilter/, 'منطق فیلتر پیام'],
  [/openServiceAlarmForCustomer/, 'باز کردن آلارم سرویس'],
  [/deskTaskMatch/, 'فیلتر میز کار'],
  [/data-accept-ref|acceptRef/, 'قبول ارجاع'],
  [/kanban-drop-active|data-drag-deal/, 'درگ‌اند‌دراپ قیف'],
  [/mc-duplicate-hint|cf-duplicate-hint/, 'هشدار تکراری'],
  [/EventSource\('\/api\/chat\/stream'\)/, 'SSE کلاینت'],
];

let failed = 0;
for (const [re, label] of checks) {
  if (!re.test(html)) {
    console.error('FAIL:', label);
    failed++;
  } else {
    console.log('OK:', label);
  }
}

if (/id="invoice-modal"[^>]*(?:pointer-events-none|class="hidden")/.test(html) || /id="invoice-modal" class="hidden"/.test(html)) {
  console.log('OK: invoice modal disabled');
} else if (html.includes('ویزارد مرحله‌ای فاکتور هوشمند')) {
  console.error('FAIL: invoice wizard UI still present');
  failed++;
} else {
  console.log('OK: invoice modal disabled');
}

// boot server briefly
const { spawn } = require('child_process');
const child = spawn(process.execPath, [path.join(root, 'server.js')], {
  env: { ...process.env, PORT: '3099' },
  stdio: ['ignore', 'pipe', 'pipe']
});

function req(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: 3099, path: pathname }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

setTimeout(async () => {
  try {
    const health = await req('/api/health');
    if (health.status !== 200) throw new Error('health ' + health.status);
    console.log('OK: /api/health');
    const page = await req('/');
    if (page.status !== 200 || !page.body.includes('مشهد گستر')) throw new Error('index serve failed');
    console.log('OK: serves index.html');
  } catch (e) {
    console.error('FAIL: server smoke', e.message);
    failed++;
  } finally {
    child.kill('SIGTERM');
    process.exit(failed ? 1 : 0);
  }
}, 600);
