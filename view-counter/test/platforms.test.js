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
  const html = `<meta property="og:title" content="Rick Astley &amp; Friends">
    <script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"x","viewCount":"1234567890"}};</script>`;
  assert.deepEqual(parseYouTubePage(html), { views: 1234567890, title: 'Rick Astley & Friends' });
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
  assert.match(priv.error, /приватний/);
});

test('parseGenericPage finds view counters on news sites', () => {
  const views = (html) => parseGenericPage(html).views;
  assert.equal(views('<script type="application/ld+json">{"interactionStatistic":{"interactionType":"https://schema.org/ViewAction","userInteractionCount":"18462"}}</script>'), 18462);
  assert.equal(views('<div class="article__views"><i class="icon"></i> 3 641 </div>'), 3641);
  assert.equal(views('<span class="post-views-count">766</span>'), 766);
  assert.equal(views('<p>Опубліковано 12.03.2026 10:15 · 1 525 переглядів</p>'), 1525);
  assert.equal(views('<span>Переглядів: 202</span>'), 202);
  assert.equal(parseGenericPage('<meta property="og:title" content="Новина"><b>Views 5</b>').title, 'Новина');
  // Look-alike classes and dates must not be taken as views
  assert.throws(() => parseGenericPage('<div class="preview">12</div><a class="viewport">5</a>'));
  assert.throws(() => parseGenericPage('<span class="views"><svg></svg></span><time>12.03.2026</time>'));
  assert.throws(() => parseGenericPage('<p>Nothing here 2026</p>'));
});
