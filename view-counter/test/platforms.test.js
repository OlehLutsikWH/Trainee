import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCompactNumber,
  detectPlatform,
  parseYouTubePage,
  parseTelegramEmbed,
  parseTelegramFeed,
  parseTikTokPage,
  parseGenericPage,
  getViews,
  setPageRenderer,
  setSiteRules,
  parseCountText,
  isCounterText,
} from '../src/platforms.js';

test('parseCompactNumber', () => {
  assert.equal(parseCompactNumber('987'), 987);
  assert.equal(parseCompactNumber('1.2K'), 1200);
  assert.equal(parseCompactNumber('3,4M'), 3400000);
  assert.equal(parseCompactNumber('1,234,567'), 1234567);
  assert.equal(parseCompactNumber('abc'), null);
});

test('detectPlatform recognises supported links', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'YouTube', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'YouTube', 'dQw4w9WgXcQ'],
    ['https://youtube.com/shorts/abc_123-X', 'YouTube', 'abc_123-X'],
    ['https://m.youtube.com/watch?v=xyz', 'YouTube', 'xyz'],
    ['https://t.me/durov/300', 'Telegram', 'durov/300'],
    ['https://t.me/s/durov/300', 'Telegram', 'durov/300'],
    ['https://www.tiktok.com/@user/video/7234567890123456789', 'TikTok', '7234567890123456789'],
    ['https://vm.tiktok.com/ZMabc/', 'TikTok', 'short'],
  ];
  for (const [url, name, id] of cases) {
    const r = detectPlatform(url);
    assert.equal(r.platform?.name, name, url);
    assert.equal(r.id, id, url);
  }
  const feed = detectPlatform('https://t.me/s/oaembr46?before=1677');
  assert.equal(feed.platform?.name, 'Telegram');
  assert.deepEqual(feed.id, { feed: 'oaembr46', before: '1677' });
  assert.deepEqual(detectPlatform('https://t.me/durov').id, { feed: 'durov', before: null });
  assert.deepEqual(detectPlatform('https://t.me/c/1315782736/18737').id, { private: true });
  assert.equal(detectPlatform('https://t.me/joinchat').platform, null);
  assert.equal(detectPlatform('https://t.me/+AbCdEf').platform, null);
  assert.equal(detectPlatform('not a url').url, null);
});

test('parseYouTubePage', () => {
  const html = `<meta property="og:title" content="Rick's Astley &amp; Friends">
    <script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"x","viewCount":"1234567890"}};</script>`;
  assert.deepEqual(parseYouTubePage(html), { views: 1234567890, title: "Rick's Astley & Friends" });
  assert.throws(() => parseYouTubePage('<html></html>'));
});

test('parseTelegramEmbed', () => {
  const html = `<div class="tgme_widget_message_text js-message_text" dir="auto">Hello<br/>world</div>
    <span class="tgme_widget_message_views">1.5M</span>`;
  assert.deepEqual(parseTelegramEmbed(html), { views: 1500000, title: 'Hello world', approximate: true });
  const exact = parseTelegramEmbed('<span class="tgme_widget_message_views">842</span>');
  assert.equal(exact.views, 842);
  assert.equal(exact.approximate, false);
  assert.throws(() => parseTelegramEmbed('<div>no views</div>'));
});

test('parseTelegramFeed', () => {
  const html = `
    <div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="chan/1675">
      <div class="tgme_widget_message_text js-message_text">First &amp; post</div>
      <span class="tgme_widget_message_views">12.3K</span></div></div>
    <div class="tgme_widget_message_wrap"><div class="tgme_widget_message service_message" data-post="chan/1676">
      <div class="tgme_widget_message_text">Channel created</div></div></div>
    <div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="chan/1677">
      <span class="tgme_widget_message_views">540</span></div></div>`;
  assert.deepEqual(parseTelegramFeed(html).posts, [
    { url: 'https://t.me/chan/1675', views: 12300, title: 'First & post', approximate: true },
    { url: 'https://t.me/chan/1677', views: 540, title: null, approximate: false },
  ]);
  assert.throws(() => parseTelegramFeed('<html></html>'));
});

test('parseTikTokPage', () => {
  const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{"itemStruct":{"desc":"My \\"cool\\" video","stats":{"diggCount":10,"playCount":45678}}}</script>`;
  assert.deepEqual(parseTikTokPage(html), { views: 45678, title: 'My "cool" video' });
  assert.throws(() => parseTikTokPage('<html></html>'));
});

test('getViews reports unsupported platforms without network calls', async () => {
  const ig = await getViews('https://www.instagram.com/p/abc/');
  assert.equal(ig.ok, false);
  assert.equal(ig.platform, 'Instagram');
  const bad = await getViews('hello');
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'Некоректне посилання');
  const priv = await getViews('https://t.me/c/1315782736/18737');
  assert.equal(priv.ok, false);
  assert.match(priv.error, /Приватний/);
});

test('parseGenericPage finds view counters on news sites', () => {
  const views = (html) => parseGenericPage(html).views;
  assert.equal(views('<script type="application/ld+json">{"interactionStatistic":{"interactionType":"https://schema.org/ViewAction","userInteractionCount":"18462"}}</script>'), 18462);
  assert.equal(views('<div class="article__views"><i class="icon"></i> 3 641 </div>'), 3641);
  assert.equal(views('<span class="post-views-count">766</span>'), 766);
  assert.equal(views('<p>Опубліковано 12.03.2026 10:15 · 1 525 переглядів</p>'), 1525);
  assert.equal(views('<span>Переглядів: 202</span>'), 202);
  assert.equal(parseGenericPage('<meta property="og:title" content="Новина"><b>Views 5</b>').title, 'Новина');
  assert.equal(views('<span class="meta"><i class="fa fa-eye"></i> 1 360</span>'), 1360);
  assert.equal(views('<span><svg class="ico"><use xlink:href="/img/sprite.svg#icon-eye"></use></svg> 205</span>'), 205);
  assert.equal(views('<div class="stats" data-views="3200"></div>'), 3200);
  assert.equal(views('<p>1,2 тис. переглядів</p>'), 1200);
  assert.equal(views('<span class="views-count">12.5K</span>'), 12500);
  assert.equal(views('<span>👁 861</span>'), 861);
  assert.equal(views('<span>Переглянуто: 45</span>'), 45);
  assert.equal(views('<script>window.__DATA__={"article":{"id":7,"views":2723,"title":"x"}}</script>'), 2723);
  // A "popular news" sidebar before the article must not win over the article's own counter
  assert.equal(views(`<aside><span class="views">9</span></aside>
    <article><h1>Стаття</h1><span class="views">861</span></article>`), 861);
  // Counter in the meta line above the heading beats an embedded video's counter further down
  assert.equal(views(`<aside>${'<p>меню</p>'.repeat(50)}<span class="views">9</span></aside>
    <article><div class="meta"><span class="views">2 849</span></div><h1>Стаття</h1>
    <p>${'Текст статті. '.repeat(100)}</p><div class="video"><span class="views">2 760</span></div></article>`), 2849);
  // Look-alike classes and dates must not be taken as views
  assert.throws(() => parseGenericPage('<div class="preview">12</div><a class="viewport">5</a>'));
  assert.throws(() => parseGenericPage('<span class="views"><svg></svg></span><time>12.03.2026</time>'));
  assert.throws(() => parseGenericPage('<p>Nothing here 2026</p>'));
});

test('generic sites fall back to the page renderer', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    setPageRenderer(null);
  });
  const rendered = [];
  setPageRenderer(async (url, extract) => {
    rendered.push(url);
    return extract('<meta property="og:title" content="Стаття"><span class="post-views">1 234</span>');
  });

  // Counter filled in by a script: the raw HTML says 0
  globalThis.fetch = async () => new Response('<span class="views">0</span>');
  let r = await getViews('https://news.example/a');
  assert.equal(r.ok, true);
  assert.equal(r.views, 1234);
  assert.equal(r.title, 'Стаття');
  assert.match(r.method, /^браузер/);

  // Site blocks plain requests
  globalThis.fetch = async () => new Response('Forbidden', { status: 403 });
  r = await getViews('https://news.example/b');
  assert.equal(r.views, 1234);

  // Missing page: no point opening a browser
  globalThis.fetch = async () => new Response('Not found', { status: 404 });
  r = await getViews('https://news.example/c');
  assert.equal(r.ok, false);
  assert.match(r.error, /404/);
  assert.deepEqual(rendered, ['https://news.example/a', 'https://news.example/b']);

  // Browser finds nothing either
  setPageRenderer(async (url, extract) => extract('<p>no counter</p>'));
  globalThis.fetch = async () => new Response('<p>no counter</p>');
  r = await getViews('https://news.example/d');
  assert.equal(r.ok, false);
  assert.match(r.error, /браузері/);
});

test('titles decode numeric and named entities', () => {
  const { title } = parseTelegramEmbed(
    '<div class="tgme_widget_message_text">Привіт&#33; Це &laquo;тест&raquo; &#8211; так</div><span class="tgme_widget_message_views">5</span>',
  );
  assert.equal(title, 'Привіт! Це «тест» – так');
});

test('parseCountText reads the number from a clicked element', () => {
  assert.equal(parseCountText('👁 3 641'), 3641);
  assert.equal(parseCountText('Переглядів: 1,2 тис.'), 1200);
  assert.equal(parseCountText('немає'), null);
  assert.equal(isCounterText('861'), true);
  assert.equal(isCounterText('👁 1,2 тис.'), true);
  assert.equal(isCounterText('12.03.2026'), false);
  assert.equal(isCounterText('10:15'), false);
});

test('a taught site rule is used before automatic detection', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    setPageRenderer(null);
    setSiteRules(null);
  });
  const seen = [];
  setSiteRules({ get: (site) => (site === 'news.example' ? { selector: '.meta span', index: 1 } : null) });
  setPageRenderer(async (url, extract, rule) => {
    seen.push(rule);
    return rule ? extract('👁 2 612') : extract('<span class="views">5</span>');
  });
  globalThis.fetch = async () => new Response('<span class="views">9</span>');

  const taught = await getViews('https://www.news.example/article');
  assert.equal(taught.views, 2612);
  assert.equal(taught.method, 'за вказаним зразком');
  assert.deepEqual(seen, [{ selector: '.meta span', index: 1 }]);

  const other = await getViews('https://other.example/a');
  assert.equal(other.views, 9);
});

test('a zero counter is returned but flagged', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => new Response('<span class="post-views">0</span>');
  const r = await getViews('https://zero.example/a');
  assert.equal(r.views, 0);
  assert.match(r.method, /показує 0/);
});
