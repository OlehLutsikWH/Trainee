// Platform detection, page fetching and view-count parsing.
// Each platform has: match(url) -> id|null, and fetchViews(url, id) -> { views, title }.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 15000;

export class ViewsError extends Error {
  // code 'cloudflare': the site showed an anti-bot check instead of the page
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CLOUDFLARE_BLOCKED = 'Сайт захищений від ботів (Cloudflare)';

// Cloudflare's "Just a moment… / checking your browser" interstitial
export function isChallengePage(html) {
  return /\/cdn-cgi\/challenge-platform\/|window\._cf_chl_opt|<title>\s*Just a moment/i.test(String(html ?? ''));
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    if (res.headers.get('cf-mitigated') === 'challenge' || isChallengePage(await res.text().catch(() => ''))) {
      throw new ViewsError(CLOUDFLARE_BLOCKED, res.status, 'cloudflare');
    }
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
    `<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=(?:"([^"]*)"|'([^']*)')`,
    'i',
  );
  const m = html.match(re);
  return m ? decodeHtml(m[1] ?? m[2]).replace(/\s+/g, ' ').trim() : null;
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
    throw new ViewsError('Приватний канал — перегляди видно лише учасникам');
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

const VIEW_WORDS =
  'переглядів|перегляди|перегляд|переглянуто|переглянули|прочитали|прочитано|хітів|' +
  'просмотров|просмотра|просмотры|просмотр|просмотрено|views|view|hits|reads';

// A counter as sites print it: "3 641", "1525", "1,2 тис.", "12.5K"
const COUNT = String.raw`(\d+(?:[.,]\d+)?\s*(?:тис\.?|тыс\.?|k|к)(?![а-яіїєґa-z])|\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)`;

function toInt(str) {
  const s = String(str).trim();
  const short = s.match(/^(\d+(?:[.,]\d+)?)\s*(?:тис|тыс|k|к)/i);
  if (short) return Math.round(Number(short[1].replace(',', '.')) * 1000);
  const n = Number(s.replace(/[\s\u00a0\u202f.,]/g, ''));
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

// An element marked as a view counter — by class ("article__views", "fa-eye", "post-views-count")
// or an eye icon (<use href="#icon-eye">) — followed by the number.
function findMarkedCounter(html, near = 0) {
  const markers = /<[a-z][^>]*\sclass=["']([^"']*)["'][^>]*>|<(?:use|img|svg)[^>]*(?:href|src)=["']([^"']*)["'][^>]*>/gi;
  const countFirst = new RegExp(`^\\s*(?:👁️?\\s*)?${COUNT}(?![\\d.,:/])`, 'i');
  let best = null;
  for (const m of html.matchAll(markers)) {
    const isCounter = m[1] !== undefined
      ? /(?:^|[\s_-])(?:views?|eye|перегляд\w*|hits|watch(?:ed)?)(?:$|[\s_-])/i.test(m[1])
      : /(?:^|[#/_-])(?:icon-)?(?:eye|views?)(?:$|[._-])/i.test(m[2]);
    if (!isCounter) continue;
    const after = pageText(html.slice(m.index + m[0].length, m.index + m[0].length + 400));
    const num = after.match(countFirst);
    if (!num) continue;
    // The article's own counter sits next to its heading (just above or below it);
    // sidebars and embedded widgets are further away
    const distance = Math.abs(m.index - near);
    if (!best || distance < best.distance) best = { distance, value: toInt(num[1]) };
  }
  return best ? best.value : null;
}

function findCounterInText(text) {
  const eye = text.match(new RegExp(`👁️?\\s*${COUNT}`, 'i'));
  const before = text.match(new RegExp(`(?:^|[^\\wа-яіїєґ])(?:${VIEW_WORDS})\\s*:?\\s*${COUNT}(?![\\d])`, 'i'));
  const after = text.match(new RegExp(`(?:^|[^\\d.,])${COUNT}\\s*(?:${VIEW_WORDS})(?![а-яіїєґa-z])`, 'i'));
  const m = after || before || eye;
  return m ? toInt(m[1]) : null;
}

// The first number in a piece of text, e.g. the counter element a user pointed at: "👁 3 641" -> 3641
export function parseCountText(text) {
  const m = String(text ?? '').match(new RegExp(COUNT, 'i'));
  return m ? toInt(m[1]) : null;
}

// Whether a clicked element plausibly is a view counter: has a number and isn't a date or time
export function isCounterText(text) {
  const t = String(text ?? '');
  return parseCountText(t) !== null && !/\d{1,2}[.:/]\d{1,2}(?:[.:/]\d{2,4})?/.test(t);
}

// The counter in the article's byline, between its heading and the article text:
// "Київ • УНН • 16 жовтня 2026, 16:06 • 9306 перегляди". Null when there is none.
const BYLINE_TEXT_CHARS = 300;
// A paragraph this long is article text; the byline's own <p> items are short
const ARTICLE_PARAGRAPH_CHARS = 80;

export function findHeadingCounter(html) {
  const h1 = html.search(/<h1[\s>]/i);
  if (h1 < 0) return null;
  const rest = html.slice(h1, h1 + 50000);
  let end = rest.length;
  for (const p of rest.matchAll(/<p[\s>][\s\S]*?<\/p>/gi)) {
    if (pageText(p[0]).trim().length > ARTICLE_PARAGRAPH_CHARS) {
      end = p.index;
      break;
    }
  }
  return findCounterInText(pageText(rest.slice(0, end)).slice(0, BYLINE_TEXT_CHARS));
}

// Many news sites print a view counter on the article page. Tries, in order of reliability:
// schema.org interaction statistics, a "views" element in the markup, then "N переглядів" in the text.
// The counter readers see wins over schema.org.
export function parseGenericPage(html) {
  const title = metaContent(html, 'og:title');
  const found = (views, method) => ({ views, title, method });

  const ld =
    html.match(/"interactionType"\s*:\s*"[^"]*(?:WatchAction|ViewAction|ReadAction)"[^}]*?"userInteractionCount"\s*:\s*"?(\d+)/) ||
    html.match(/"userInteractionCount"\s*:\s*"?(\d+)"?[^}]*?"interactionType"\s*:\s*"[^"]*(?:WatchAction|ViewAction|ReadAction)"/) ||
    html.match(/itemprop=["']interactionCount["'][^>]*content=["'](?:UserPageVisits|UserViews):(\d+)/i);
  if (ld) {
    const visible = findHeadingCounter(html);
    if (visible > 0) return found(visible, 'лічильник біля заголовка');
    return found(Number(ld[1]), 'schema.org');
  }

  const attr = html.match(/\sdata-(?:views|view-count|views-count|post-views|count-views)=["'](\d+)["']/i);
  if (attr) return found(Number(attr[1]), 'лічильник на сторінці');

  // Sidebars ("popular news") and embedded widgets show other views too, so prefer the counter
  // closest to the article heading, and search the text after the heading first.
  const h1 = html.search(/<h1[\s>]/i);
  const fromTitle = h1 > 0 ? html.slice(h1) : null;

  const marked = findMarkedCounter(html, Math.max(h1, 0));
  if (marked !== null) return found(marked, 'лічильник на сторінці');

  // Counters kept in the page's embedded JSON (common on sites built with JS frameworks)
  const json = html.match(/"(?:views|viewsCount|views_count|view_count|viewCounter|pageviews|pageViews|page_views|hits|read_count|readCount)"\s*:\s*"?(\d+)"?[,}]/);
  if (json && Number(json[1]) > 0) return found(Number(json[1]), 'дані сторінки');

  const inText = (fromTitle && findCounterInText(pageText(fromTitle))) ?? findCounterInText(pageText(html));
  if (inText !== null) return found(inText, 'текст сторінки');

  throw new ViewsError('Лічильника на сторінці не знайдено');
}

// Optional: a real browser that renders the page (runs its scripts) and hands back the HTML.
// Set by the desktop app; the plain web version works without it.
let pageRenderer = null;

// renderer(url, extract, rule?) must load the page and call extract(html) until it returns a result
// or gives up, resolving with that result or null. With a rule ({ selector, index }) it passes the
// text of that element instead of the whole page.
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

// Where a user has shown the app the counter on a site: host -> { selector, index }.
// Set by the desktop app, which keeps these rules between runs.
let siteRules = null;

export function setSiteRules(rules) {
  siteRules = rules;
}

export function siteKey(url) {
  return new URL(url).hostname.replace(/^www\./, '');
}

// Optional: the user's own Chrome/Edge, for sites whose anti-bot check refuses the built-in
// browser. Same signature as pageRenderer. Set by the desktop app.
let realBrowser = null;

export function setRealBrowser(renderer) {
  realBrowser = renderer;
}

const readRuleText = (text) => {
  const views = parseCountText(text);
  return views === null ? null : { views };
};

// Sites whose counter a script updates after the page has loaded (unn.ua: the HTML says 3590,
// the page shows 12541 a moment later). Learned while the app runs: host -> true / false.
const liveCounters = new Map();

// Reads a counter in the built-in browser with read(text) -> number | null. The page may first
// show the number from its HTML (`known`, or else the first reading), so on sites that update
// it, wait for the update. When none comes, the last reading is returned with updated: false.
async function renderCounter(url, read, rule, known) {
  const host = siteKey(url);
  const live = liveCounters.get(host);
  let first = null;
  let last = null;
  const result = await pageRenderer(url, (text) => {
    const views = read(text);
    if (views === null) return null;
    last = views;
    first ??= views;
    const base = known ?? first;
    if (views !== base) return { views, updated: true };
    // Known not to update: no point waiting
    return live === false && views > 0 ? { views, updated: false } : null;
  }, rule);
  if (result) {
    if (result.updated) liveCounters.set(host, true);
    return result;
  }
  if (last === null) return null;
  if (live === undefined) liveCounters.set(host, false);
  return { views: last, updated: false };
}

async function fetchGeneric(url) {
  const rule = siteRules?.get(siteKey(url.href));
  // Sites taught in Chrome are only reachable through Chrome
  if (rule?.via === 'chrome') {
    if (!realBrowser) throw new ViewsError(CLOUDFLARE_BLOCKED, 403, 'cloudflare');
    const picked = await realBrowser(url.href, readRuleText, rule);
    if (picked) return { ...picked, title: null, method: 'Chrome: за вказаним зразком' };
    throw new ViewsError('Не вдалося прочитати лічильник через Chrome', 403, 'cloudflare');
  }

  let html = null;
  let quick = null;
  let quickError = null;
  try {
    html = await fetchText(url.href);
  } catch (err) {
    quickError = err;
  }

  if (rule && pageRenderer) {
    const picked = await renderCounter(url.href, parseCountText, rule, null);
    if (picked) return { views: picked.views, title: null, method: 'за вказаним зразком' };
  }

  if (html !== null) {
    try {
      quick = parseGenericPage(html);
    } catch (err) {
      quickError = err;
    }
  }
  // The byline's number in the HTML may be a snapshot the page updates once it loads
  const byline = html === null ? null : findHeadingCounter(html);
  if (quick && pageRenderer && byline !== null && liveCounters.get(siteKey(url.href)) !== false) {
    const fresh = await renderCounter(url.href, findHeadingCounter, null, byline);
    if (fresh?.updated) return { ...quick, views: fresh.views, method: 'браузер: оновлений лічильник' };
  }
  // Many sites print 0 in the HTML and fill the real number in with a script
  if (quick?.views > 0) return quick;

  const pageMissing = quickError?.status === 404 || quickError?.status === 410 || isDnsError(quickError);
  // Whether the built-in browser was last looking at an anti-bot check (null: never saw a page)
  let stuckOnChallenge = null;
  if (pageRenderer && !pageMissing) {
    const rendered = await pageRenderer(url.href, (html) => {
      stuckOnChallenge = isChallengePage(html);
      return stuckOnChallenge ? null : tryParseGeneric(html);
    });
    if (rendered) return { ...rendered, method: `браузер: ${rendered.method}` };
  }

  if (quick) return { ...quick, method: `${quick.method}: показує 0 — перевірте` };
  if (stuckOnChallenge || (stuckOnChallenge === null && quickError?.code === 'cloudflare')) {
    throw new ViewsError(CLOUDFLARE_BLOCKED, 403, 'cloudflare');
  }
  if (pageRenderer && !pageMissing) {
    throw new ViewsError('Лічильника на сторінці немає (перевірено й у браузері)');
  }
  throw quickError;
}

// ---------- Registry ----------

const NOT_PUBLIC = 'Перегляди видно лише власнику акаунта — впишіть вручну';

const PLATFORMS = [
  { name: 'YouTube', match: matchYouTube, fetchViews: fetchYouTube },
  { name: 'Telegram', match: matchTelegram, fetchViews: fetchTelegram },
  { name: 'TikTok', match: matchTikTok, fetchViews: fetchTikTok },
  { name: 'Instagram', match: (u) => /(^|\.)instagram\.com$/.test(u.hostname) || null, unsupported: NOT_PUBLIC },
  { name: 'Facebook', match: (u) => /(^|\.)(facebook\.com|fb\.watch)$/.test(u.hostname) || null, unsupported: NOT_PUBLIC },
  { name: 'X (Twitter)', match: (u) => /(^|\.)(x\.com|twitter\.com)$/.test(u.hostname) || null, unsupported: 'Перегляди X доступні лише через платний API — впишіть вручну' },
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
      const blocked = err.code === 'cloudflare' ? { blocked: 'cloudflare' } : {};
      return { ...base, ok: false, platform: url.hostname.replace(/^www\./, ''), error: errorMessage(err), ...blocked };
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
