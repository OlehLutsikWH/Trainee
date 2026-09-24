import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getViews } from './platforms.js';

const PORT = Number(process.env.PORT) || 3000;
const MAX_URLS = 100;
const CONCURRENCY = 4;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

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
  urls = [...new Set(urls.map(String).map((u) => u.trim()).filter(Boolean))];
  if (urls.length === 0) return sendJson(res, 400, { error: 'Додайте хоча б одне посилання' });
  if (urls.length > MAX_URLS) return sendJson(res, 400, { error: `Максимум ${MAX_URLS} посилань за раз` });

  const results = await mapLimited(urls, CONCURRENCY, getViews);
  const totalViews = results.reduce((sum, r) => sum + (r.ok ? r.views : 0), 0);
  sendJson(res, 200, { totalViews, results });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/views') return await handleViews(req, res);
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

server.listen(PORT, () => {
  console.log(`View Counter працює: http://localhost:${PORT}`);
});
