import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCompactNumber,
  detectPlatform,
  parseYouTubePage,
  parseTelegramEmbed,
  parseTikTokPage,
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
  assert.equal(detectPlatform('https://t.me/durov').platform, null);
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
  const unknown = await getViews('https://example.com/post/1');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.platform, 'example.com');
});
