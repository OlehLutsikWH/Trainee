// Platform detection, page fetching and view-count parsing.
// Each platform has: match(url) -> id|null, and fetchViews(url, id) -> { views, title }.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 15000;

export class ViewsError extends Error {}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new ViewsError(`Сторінка відповіла кодом ${res.status}`);
  return res.text();
}

function decodeHtml(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function metaContent(html, name) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`,
    'i',
  );
  const m = html.match(re);
  return m ? decodeHtml(m[1]) : null;
}

// "1.2K" -> 1200, "3,4M" -> 3400000, "987" -> 987
export function parseCompactNumber(text) {
  const m = String(text).trim().replace(/\s/g, '').match(/^([\d.,]+)([KMB])?$/i);
  if (!m) return null;
  const suffix = m[2]?.toUpperCase();
  let num = m[1];
  if (suffix) {
    num = Number(num.replace(',', '.'));
  } else {
    num = Number(num.replace(/[.,]/g, ''));
  }
  if (!Number.isFinite(num)) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[suffix] ?? 1;
  return Math.round(num * mult);
}

// ---------- YouTube ----------

export function matchYouTube(url) {
  const host = url.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtu.be') return url.pathname.slice(1).split('/')[0] || null;
  if (host !== 'youtube.com') return null;
  if (url.searchParams.get('v')) return url.searchParams.get('v');
  const m = url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)/);
  return m ? m[1] : null;
}

export function parseYouTubePage(html) {
  const m = html.match(/"viewCount"\s*:\s*"(\d+)"/);
  if (!m) throw new ViewsError('Не вдалося знайти кількість переглядів на сторінці YouTube');
  return {
    views: Number(m[1]),
    title: metaContent(html, 'og:title') ?? metaContent(html, 'title'),
  };
}

async function fetchYouTube(url, id) {
  const key = process.env.YOUTUBE_API_KEY;
  if (key) {
    const api =
      'https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet' +
      `&id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}`;
    const data = JSON.parse(await fetchText(api));
    const item = data.items?.[0];
    if (!item) throw new ViewsError('Відео не знайдено');
    return { views: Number(item.statistics.viewCount), title: item.snippet.title };
  }
  return parseYouTubePage(await fetchText(`https://www.youtube.com/watch?v=${id}`));
}

// ---------- Telegram ----------

const TELEGRAM_RESERVED = new Set(['joinchat', 'addstickers', 'addemoji', 'share', 'proxy', 'socks', 'iv', 'login']);

// Post: t.me/channel/123, t.me/s/channel/123 -> "channel/123"
// Channel feed: t.me/channel, t.me/s/channel?before=123 -> { feed: "channel", before: "123" }
export function matchTelegram(url) {
  const host = url.hostname.replace(/^www\./, '');
  if (host !== 't.me' && host !== 'telegram.me') return null;
  const post = url.pathname.match(/^\/(?:s\/)?(\w+)\/(\d+)/);
  if (post) return `${post[1]}/${post[2]}`;
  const feed = url.pathname.match(/^\/(?:s\/)?(\w+)\/?$/);
  if (feed && !TELEGRAM_RESERVED.has(feed[1].toLowerCase())) {
    return { feed: feed[1], before: url.searchParams.get('before') };
  }
  return null;
}

function parseTelegramMessage(html) {
  const m = html.match(/class="tgme_widget_message_views"[^>]*>([^<]+)</);
  if (!m) return null;
  const views = parseCompactNumber(m[1]);
  if (views === null) throw new ViewsError(`Невідомий формат переглядів: ${m[1]}`);
  const text = html.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  const title = text
    ? decodeHtml(text[1].replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '')).trim().slice(0, 100)
    : null;
  return { views, title, approximate: /[KMB]/i.test(m[1]) };
}

export function parseTelegramEmbed(html) {
  const result = parseTelegramMessage(html);
  if (!result) {
    throw new ViewsError('Не вдалося знайти перегляди: пост приватний, видалений або це не канал');
  }
  return result;
}

// Channel page (t.me/s/channel) lists the ~20 latest posts, each with its own view counter.
export function parseTelegramFeed(html) {
  const posts = [];
  const chunks = html.split('data-post="').slice(1);
  for (const chunk of chunks) {
    const id = chunk.slice(0, chunk.indexOf('"'));
    const parsed = parseTelegramMessage(chunk);
    if (parsed && /^\w+\/\d+$/.test(id)) posts.push({ url: `https://t.me/${id}`, ...parsed });
  }
  if (posts.length === 0) {
    throw new ViewsError('Не знайдено постів: канал приватний, порожній або це не канал');
  }
  return { posts };
}

async function fetchTelegram(url, id) {
  if (typeof id === 'object') {
    const before = id.before ? `?before=${encodeURIComponent(id.before)}` : '';
    return parseTelegramFeed(await fetchText(`https://t.me/s/${id.feed}${before}`));
  }
  return parseTelegramEmbed(await fetchText(`https://t.me/${id}?embed=1&mode=tme`));
}

// ---------- TikTok ----------

export function matchTikTok(url) {
  const host = url.hostname.replace(/^www\.|^m\./, '');
  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') return 'short';
  if (host !== 'tiktok.com') return null;
  const m = url.pathname.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

export function parseTikTokPage(html) {
  const m = html.match(/"playCount"\s*:\s*"?(\d+)"?/);
  if (!m) throw new ViewsError('Не вдалося знайти перегляди на сторінці TikTok (можливо, TikTok заблокував запит)');
  const desc = html.match(/"desc"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  let title = null;
  if (desc) {
    try {
      title = JSON.parse(`"${desc[1]}"`).slice(0, 100);
    } catch {
      title = desc[1].slice(0, 100);
    }
  }
  return { views: Number(m[1]), title: title || metaContent(html, 'og:title') };
}

async function fetchTikTok(url) {
  return parseTikTokPage(await fetchText(url.href));
}

// ---------- Registry ----------

const NOT_PUBLIC =
  'Ця платформа не показує перегляди публічно. Потрібне підключення акаунта власника (буде в наступних версіях).';

const PLATFORMS = [
  { name: 'YouTube', match: matchYouTube, fetchViews: fetchYouTube },
  { name: 'Telegram', match: matchTelegram, fetchViews: fetchTelegram },
  { name: 'TikTok', match: matchTikTok, fetchViews: fetchTikTok },
  { name: 'Instagram', match: (u) => /(^|\.)instagram\.com$/.test(u.hostname) || null, unsupported: NOT_PUBLIC },
  { name: 'Facebook', match: (u) => /(^|\.)(facebook\.com|fb\.watch)$/.test(u.hostname) || null, unsupported: NOT_PUBLIC },
  { name: 'X (Twitter)', match: (u) => /(^|\.)(x\.com|twitter\.com)$/.test(u.hostname) || null, unsupported: 'Перегляди X доступні лише через платний API (буде в наступних версіях).' },
];

export function detectPlatform(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { url: null, platform: null };
  }
  for (const platform of PLATFORMS) {
    const id = platform.match(url);
    if (id) return { url, platform, id };
  }
  return { url, platform: null };
}

// Returns one result, or an array of results when the link expands into several posts.
export async function getViews(rawUrl) {
  const { url, platform, id } = detectPlatform(rawUrl);
  const base = { url: rawUrl.trim() };
  if (!url) return { ...base, ok: false, error: 'Некоректне посилання' };
  if (!platform) return { ...base, ok: false, platform: url.hostname, error: 'Платформа поки не підтримується' };
  if (platform.unsupported) return { ...base, ok: false, platform: platform.name, error: platform.unsupported };
  try {
    const result = await platform.fetchViews(url, id);
    // A channel link expands into one row per post
    if (result.posts) return result.posts.map((post) => ({ ok: true, platform: platform.name, ...post }));
    return { ...base, ok: true, platform: platform.name, ...result };
  } catch (err) {
    const message = err instanceof ViewsError ? err.message
      : err.name === 'TimeoutError' ? 'Сторінка не відповіла вчасно'
      : `Помилка запиту: ${err.message}`;
    return { ...base, ok: false, platform: platform.name, error: message };
  }
}
