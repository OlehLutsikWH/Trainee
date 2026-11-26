import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getViews } from './platforms.js';

const MAX_URLS = 1000;
const CONCURRENCY = 6;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Small JSON files kept between runs; the desktop app points them at its user data folder.
let dataDir = path.join(os.homedir(), '.view-counter');
const stores = new Map();

export function setDataDir(dir) {
  dataDir = dir;
  stores.clear();
}

async function loadStore(name) {
  if (!stores.has(name)) {
    let data = {};
    try {
      data = JSON.parse(await readFile(path.join(dataDir, name), 'utf8'));
    } catch {
      // First run or unreadable file: start empty
    }
    stores.set(name, data);
  }
  return stores.get(name);
}

async function saveStore(name) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, name), JSON.stringify(stores.get(name), null, 2));
}

// "https://www.Site.com/news/1" or "www.site.com" -> "site.com"
function normalizeSite(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  try {
    return new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Monthly audience per site, typed in by the user, for the "reach (estimate)" column.
// PUT { site, value } sets one site; PUT { entries: { site: value, ... } } sets many at once.
async function handleAudience(req, res) {
  const data = await loadStore('audience.json');
  if (req.method === 'GET') return sendJson(res, 200, data);
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'Очікується JSON: { "site": "...", "value": 123 } або { "entries": {...} }' });
  }
  const entries = body.entries ?? { [body.site]: body.value };
  for (const [rawSite, value] of Object.entries(entries)) {
    const site = normalizeSite(rawSite);
    if (!site) continue;
    const n = Number(value);
    if (value === null || value === '' || !Number.isFinite(n) || n <= 0) delete data[site];
    else data[site] = Math.round(n);
  }
  await saveStore('audience.json');
  sendJson(res, 200, data);
}

const SETTING_VALUES = { reachMode: ['monthly', 'daily'] };

async function handleSettings(req, res) {
  const data = await loadStore('settings.json');
  if (req.method === 'PUT') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'Очікується JSON' });
    }
    for (const [key, allowed] of Object.entries(SETTING_VALUES)) {
      if (allowed.includes(body[key])) data[key] = body[key];
    }
    await saveStore('settings.json');
  }
  sendJson(res, 200, { reachMode: 'monthly', ...data });
}

// Desktop app only: opens the page so the user can click the view counter (see electron/teacher.js).
// teacher(url, via) resolves with { views } or null if the user closed the window;
// via 'chrome' opens the user's own Chrome/Edge instead of the built-in browser.
let teacher = null;
let teacherOptions = {};

export function setTeacher(fn, options = {}) {
  teacher = fn;
  teacherOptions = options;
}

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1e6) throw new Error('Body too large');
  }
  return body;
}

async function handleViews(req, res) {
  let urls;
  try {
    ({ urls } = JSON.parse(await readBody(req)));
  } catch {
    return sendJson(res, 400, { error: 'Очікується JSON: { "urls": [...] }' });
  }
  if (!Array.isArray(urls)) return sendJson(res, 400, { error: 'Поле "urls" має бути масивом' });
  // Keep every line (blank ones too) so results line up with rows pasted from a spreadsheet
  urls = urls.map((u) => String(u ?? '').trim());
  if (!urls.some(Boolean)) return sendJson(res, 400, { error: 'Додайте хоча б одне посилання' });
  if (urls.length > MAX_URLS) return sendJson(res, 400, { error: `Максимум ${MAX_URLS} рядків за раз` });

  // Stream one JSON line per link as soon as it is checked, so the page can show progress
  const unique = [...new Set(urls.filter(Boolean))];
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  const send = (obj) => res.write(`${JSON.stringify(obj)}\n`);
  let cancelled = false;
  res.on('close', () => { cancelled = !res.writableEnded; });

  send({ type: 'start', total: unique.length });
  await mapLimited(unique, CONCURRENCY, async (url) => {
    if (cancelled) return;
    const result = await getViews(url);
    if (!cancelled) send({ type: 'result', url, result });
  });
  if (!cancelled) {
    send({ type: 'done' });
    res.end();
  }
}

async function handleTeach(req, res) {
  if (!teacher) return sendJson(res, 501, { error: 'Доступно лише в десктопній версії' });
  let url;
  let via;
  try {
    ({ url, via } = JSON.parse(await readBody(req)));
    new URL(url);
  } catch {
    return sendJson(res, 400, { error: 'Очікується JSON: { "url": "https://..." }' });
  }
  if (via === 'chrome' && !teacherOptions.realBrowser) {
    return sendJson(res, 501, { error: 'Відкриття через Chrome недоступне' });
  }
  let picked;
  try {
    picked = await teacher(url, via === 'chrome' ? 'chrome' : 'builtin');
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
  sendJson(res, 200, picked ? { ok: true, views: picked.views } : { ok: false });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/views') return await handleViews(req, res);
    if (req.method === 'POST' && req.url === '/api/teach') return await handleTeach(req, res);
    if (req.url === '/api/audience' && (req.method === 'GET' || req.method === 'PUT')) return await handleAudience(req, res);
    if (req.url === '/api/settings' && (req.method === 'GET' || req.method === 'PUT')) return await handleSettings(req, res);
    if (req.method === 'GET' && req.url === '/api/capabilities') {
      return sendJson(res, 200, { teach: !!teacher, realBrowser: !!(teacher && teacherOptions.realBrowser) });
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const html = await readFile(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'Внутрішня помилка сервера' });
  }
});

// Starts the server on 127.0.0.1; port 0 picks any free port. Resolves with the actual port.
export function startServer(port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

// `npm start` runs this file directly; the desktop app imports startServer instead.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = await startServer(Number(process.env.PORT) || 3000);
  console.log(`View Counter працює: http://localhost:${port}`);
}
