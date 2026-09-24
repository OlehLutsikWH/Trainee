// Platform detection, page fetching and view-count parsing.
// Each platform has: match(url) -> id|null, and fetchViews(url, id) -> { views, title }.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 15000;

export class ViewsError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const hint = res.status === 403 ? ' (сайт заблокував автоматичний запит)' : res.status === 404 ? ' (сторінку не знайдено)' : '';
    throw new ViewsError(`Сторінка відповіла кодом ${res.status}${hint}`, res.status);
  }
  return res.text();
}

const NAMED_ENTITIES = {
  quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', bull: '•', ndash: '–', mdash: '—',
  laquo: '«', raquo: '»', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '„',
};

function decodeHtml(str) {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/&amp;/g, '&');
}

function metaContent(html, name) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`,
    'i',
  );
  const m = html.match(re);
  return m ? decodeHtml(m[1]).replace(/\s+/g, ' ').trim() : null;
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
// Private channel post: t.me/c/123/456 -> { private: true }
export function matchTelegram(url) {
  const host = url.hostname.replace(/^www\./, '');
  if (host !== 't.me' && host !== 'telegram.me') return null;
  if (/^\/c\//.test(url.pathname)) return { private: true };
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
  if (id.private) {
    throw new ViewsError('Це приватний канал (t.me/c/…) — перегляди видно лише його учасникам');
  }
  if (id.feed) {
    const before = id.before ? `?before=${encodeURIComponent(id.before)}` : '';
    const feed = parseTelegramFeed(await fetchText(`https://t.me/s/${id.feed}${before}`));
    // t.me/s/channel?before=N opens the page scrolled to the last post before N — that's the post meant
    return id.before ? feed.posts[feed.posts.length - 1] : feed;
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

// ---------- Any other website (news sites etc.) ----------

const VIEW_WORDS = 'переглядів|перегляди|перегляд|просмотров|просмотра|просмотры|просмотр|views|view';

function toInt(str) {
  const n = Number(String(str).replace(/[\s\u00a0\u202f.,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function pageText(html) {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' '),
  ).replace(/\s+/g, ' ');
}

// Many news sites print a view counter on the article page. Tries, in order of reliability:
// schema.org interaction statistics, a "views" element in the markup, then "N переглядів" in the text.
export function parseGenericPage(html) {
  const title = metaContent(html, 'og:title');
  const found = (views, method) => ({ views, title, method });

  const ld =
    html.match(/"interactionType"\s*:\s*"[^"]*(?:WatchAction|ViewAction|ReadAction)"[^}]*?"userInteractionCount"\s*:\s*"?(\d+)/) ||
    html.match(/"userInteractionCount"\s*:\s*"?(\d+)"?[^}]*?"interactionType"\s*:\s*"[^"]*(?:WatchAction|ViewAction|ReadAction)"/) ||
    html.match(/itemprop=["']interactionCount["'][^>]*content=["'](?:UserPageVisits|UserViews):(\d+)/i);
  if (ld) return found(Number(ld[1]), 'schema.org');

  // An element whose class names it a view counter, e.g. "article__views" or "post-views-count",
  // whose first text is the number.
  for (const m of html.matchAll(/<[a-z][^>]*\sclass=["']([^"']*)["'][^>]*>/gi)) {
    if (!/(?:^|[\s_-])(?:views?|eye|перегляд\w*)(?:$|[\s_-])/i.test(m[1])) continue;
    const after = pageText(html.slice(m.index + m[0].length, m.index + m[0].length + 400));
    const num = after.match(/^\s*(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?![\d.,:\/])/);
    if (num) return found(toInt(num[1]), 'лічильник на сторінці');
  }

  const text = pageText(html);
  const before = text.match(new RegExp(`(?:^|[^\\wа-яіїєґ])(?:${VIEW_WORDS})\\s*:?\\s*(\\d[\\d \\u00a0\\u202f]{0,12})(?![\\d])`, 'i'));
  const after = text.match(new RegExp(`(?:^|[^\\d.,])(\\d{1,3}(?:[ \\u00a0\\u202f]\\d{3})+|\\d+)\\s*(?:${VIEW_WORDS})(?![а-яіїєґa-z])`, 'i'));
  const m = after || before;
  if (m && toInt(m[1]) !== null) return found(toInt(m[1]), 'текст сторінки');

  throw new ViewsError('Сайт не показує кількість переглядів (або підвантажує її скриптом)');
}

// Optional: a real browser that renders the page (runs its scripts) and hands back the HTML.
// Set by the desktop app; the plain web version works without it.
let pageRenderer = null;

// renderer(url, extract) must load the page and call extract(html) until it returns a result
// or gives up, resolving with that result or null.
export function setPageRenderer(renderer) {
  pageRenderer = renderer;
}

function tryParseGeneric(html) {
  try {
    const result = parseGenericPage(html);
    return result.views > 0 ? result : null;
  } catch {
    return null;
  }
}

async function fetchGeneric(url) {
  let quick = null;
  let quickError = null;
  try {
    quick = parseGenericPage(await fetchText(url.href));
    // Many sites print 0 in the HTML and fill the real number in with a script
    if (quick.views > 0) return quick;
  } catch (err) {
    quickError = err;
  }

  const pageMissing = quickError?.status === 404 || quickError?.status === 410 || isDnsError(quickError);
  if (pageRenderer && !pageMissing) {
    const rendered = await pageRenderer(url.href, tryParseGeneric);
    if (rendered) return { ...rendered, method: `браузер: ${rendered.method}` };
  }

  if (quick) return quick;
  if (pageRenderer && !pageMissing) {
    throw new ViewsError('Сайт не показує кількість переглядів (перевірено й у вбудованому браузері)');
  }
  throw quickError;
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
  if (!platform) {
    try {
      return { ...base, ok: true, platform: url.hostname.replace(/^www\./, ''), ...(await fetchGeneric(url)) };
    } catch (err) {
      return { ...base, ok: false, platform: url.hostname.replace(/^www\./, ''), error: errorMessage(err) };
    }
  }
  if (platform.unsupported) return { ...base, ok: false, platform: platform.name, error: platform.unsupported };
  try {
    const result = await platform.fetchViews(url, id);
    // A channel link expands into one row per post
    if (result.posts) return result.posts.map((post) => ({ ok: true, platform: platform.name, ...post }));
    return { ...base, ok: true, platform: platform.name, ...result };
  } catch (err) {
    return { ...base, ok: false, platform: platform.name, error: errorMessage(err) };
  }
}

function isDnsError(err) {
  return ['ENOTFOUND', 'ENOENT', 'EAI_AGAIN'].includes(err?.cause?.code);
}

function errorMessage(err) {
  if (err instanceof ViewsError) return err.message;
  if (err.name === 'TimeoutError') return 'Сторінка не відповіла вчасно';
  if (isDnsError(err)) return 'Сайт недоступний (домен не знайдено)';
  return `Помилка запиту: ${err.cause?.code ?? err.message}`;
}
