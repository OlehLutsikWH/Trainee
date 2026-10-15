// Runs google-sheets/ViewCounter.gs against a small in-memory imitation of the Apps Script services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CODE = readFileSync(new URL('../google-sheets/ViewCounter.gs', import.meta.url), 'utf8');

function createSheet(name, rows) {
  const width = Math.max(...rows.map((r) => r.length));
  const values = rows.map((r) => [...r, ...Array(width - r.length).fill('')]);
  const notes = values.map((r) => r.map(() => ''));
  const ensure = (row, col) => {
    while (values.length < row) { values.push(Array(values[0].length).fill('')); notes.push(Array(values[0].length).fill('')); }
    while (values[0].length < col) { values.forEach((r) => r.push('')); notes.forEach((r) => r.push('')); }
  };
  const sheet = {
    values, notes,
    getName: () => name,
    getLastRow: () => {
      for (let r = values.length; r > 0; r--) if (values[r - 1].some((v) => v !== '')) return r;
      return 0;
    },
    getLastColumn: () => values[0].length,
    insertColumnAfter(col) {
      values.forEach((r) => r.splice(col, 0, ''));
      notes.forEach((r) => r.splice(col, 0, ''));
    },
    getRange(row, col, numRows = 1, numCols = 1) {
      ensure(row + numRows - 1, col + numCols - 1);
      const range = {
        getSheet: () => sheet,
        getRow: () => row, getLastRow: () => row + numRows - 1,
        getColumn: () => col, getLastColumn: () => col + numCols - 1,
        getValues: () => values.slice(row - 1, row - 1 + numRows).map((r) => r.slice(col - 1, col - 1 + numCols)),
        getValue: () => values[row - 1][col - 1],
        setValue(v) { values[row - 1][col - 1] = v; return range; },
        getNote: () => notes[row - 1][col - 1],
        setNote(n) { notes[row - 1][col - 1] = n; return range; },
        getFormula: () => '',
        getRichTextValue: () => null,
        copyTo() {},
      };
      return range;
    },
  };
  return sheet;
}

function createEnv(sheet, pages) {
  const props = new Map();
  const triggers = [];
  const toasts = [];
  const alerts = [];
  const fetched = [];
  const respond = (req) => {
    fetched.push(req.url);
    const host = req.url.match(/^https?:\/\/([^/?#]+)/)[1];
    const page = Object.entries(pages).find(([prefix]) => req.url.startsWith(prefix));
    if (!page) throw new Error(`DNS error: ${host}`);
    const p = typeof page[1] === 'string' ? { body: page[1] } : page[1];
    return {
      getResponseCode: () => p.code ?? 200,
      getContentText: () => p.body,
      getHeaders: () => p.headers ?? {},
    };
  };
  const triggerBuilder = (handler) => {
    const t = { handler, getHandlerFunction: () => handler };
    const chain = {
      forSpreadsheet: () => chain, onEdit: () => { t.kind = 'edit'; return chain; },
      timeBased: () => chain, after: (ms) => { t.kind = 'time'; t.after = ms; return chain; },
      create: () => { triggers.push(t); return t; },
    };
    return chain;
  };
  const menu = { addItem: () => menu, addSeparator: () => menu, addToUi: () => {} };
  const ss = {
    toast: (text) => toasts.push(text),
    getSheetByName: (n) => (n === sheet.getName() ? sheet : null),
    getActiveSheet: () => sheet,
  };
  const ctx = vm.createContext({
    console,
    SpreadsheetApp: {
      getActive: () => ss,
      getActiveSheet: () => sheet,
      getUi: () => ({ alert: (t) => alerts.push(t), createMenu: () => menu }),
      CopyPasteType: { PASTE_FORMAT: 'format' },
    },
    PropertiesService: {
      getDocumentProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, String(v)),
        deleteProperty: (k) => props.delete(k),
      }),
    },
    ScriptApp: {
      getProjectTriggers: () => [...triggers],
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: triggerBuilder,
    },
    LockService: { getDocumentLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    UrlFetchApp: {
      fetchAll: (reqs) => reqs.map(respond),
      fetch: (url, req) => respond({ ...req, url }),
    },
    Utilities: { formatDate: () => '15.10.2026 10:00' },
    Session: { getScriptTimeZone: () => 'Europe/Kyiv' },
  });
  vm.runInContext(CODE, ctx);
  return { ctx, props, triggers, toasts, alerts, fetched };
}

// Columns: A №, B Проєкт, C URL, D Перегляди, E Рівень
const HEADER = ['№', 'Проєкт', 'URL', 'Перегляди', 'Рівень'];
const CHALLENGE = '<html><head><title>Just a moment...</title></head><script src="/cdn-cgi/challenge-platform/x.js"></script></html>';

function pagesFor(ytViews = 97186) {
  return {
    'https://www.youtube.com/watch?v=abc': `"viewCount":"${ytViews}"`,
    'https://t.me/oaembr46/1676?embed=1': '<span class="tgme_widget_message_views">3.4K</span>',
    'https://unn.ua/': '<h1>Новина</h1><span class="views">10 577</span>',
    'https://www.podilske.com/': '<h1>Новина</h1><p>Текст</p>',
    'https://podilske.com/': '<h1>Інша</h1><p>Текст</p>',
    'https://events.humanitix.com/': { code: 403, body: CHALLENGE, headers: { 'cf-mitigated': 'challenge' } },
  };
}

function makeSheet() {
  return createSheet('Виходи в медіа', [
    HEADER,
    [1, 'A', 'https://youtu.be/abc', '', 'Нац'],
    [2, 'B', 'https://t.me/oaembr46/1676', '', ''],
    [3, 'C', 'https://unn.ua/news/1', '', ''],
    [4, 'D', 'https://www.podilske.com/a', '', ''],
    [5, 'E', 'https://events.humanitix.com/x', '', ''],
    [6, 'F', 'https://www.instagram.com/p/X/', 524000, ''],
    [7, 'G', 'https://podilske.com/b', '', ''],
    [8, 'H', 'https://gone.example/a', '', ''],
  ]);
}

test('setup adds the reach column next to views and installs the edit trigger', () => {
  const sheet = makeSheet();
  const env = createEnv(sheet, pagesFor());
  env.ctx.setup();
  assert.deepEqual(sheet.values[0], ['№', 'Проєкт', 'URL', 'Перегляди', 'Охоплення (оцінка)', 'Рівень']);
  assert.equal(sheet.values[1][5], 'Нац', 'existing columns shift right intact');
  assert.equal(env.props.get('sheetName'), 'Виходи в медіа');
  assert.deepEqual(env.triggers.map((t) => [t.handler, t.kind]), [['handleEdit', 'edit']]);
  // Running setup again doesn't add a second column or trigger
  env.ctx.setup();
  assert.equal(sheet.values[0].filter((h) => h === 'Охоплення (оцінка)').length, 1);
  assert.equal(env.triggers.length, 1);
});

test('update fills views, keeps manual values and explains what was not found', () => {
  const sheet = makeSheet();
  const env = createEnv(sheet, pagesFor());
  env.ctx.setup();
  env.ctx.updateAll();
  const views = (row) => sheet.values[row - 1][3];
  const note = (row) => sheet.notes[row - 1][3];
  assert.equal(views(2), 97186);
  assert.match(note(2), /^авто · YouTube · оновлено/);
  assert.equal(views(3), 3400);
  assert.equal(views(4), 10577);
  assert.equal(views(5), '');
  assert.match(note(5), /не знайдено: лічильника на сторінці немає/);
  assert.equal(views(6), '');
  assert.match(note(6), /Cloudflare/);
  assert.equal(views(7), 524000, 'manual Instagram number is kept');
  assert.equal(note(7), '');
  assert.match(note(9), /не знайдено: сайт недоступний/);
  assert.ok(!env.fetched.some((u) => u.includes('instagram')), 'Instagram is not fetched');
  assert.match(env.toasts.at(-1), /Готово/);
});

test('typing a site audience once fills reach for every row of that site, now and later', () => {
  const sheet = makeSheet();
  const env = createEnv(sheet, pagesFor());
  env.ctx.setup();
  env.ctx.updateAll();
  const reach = (row) => sheet.values[row - 1][4];
  // User types "150K" into podilske's reach cell on row 5
  sheet.values[4][4] = '150K';
  env.ctx.handleEdit({ range: sheet.getRange(5, 5) });
  assert.equal(reach(5), 150000);
  assert.match(sheet.notes[4][4], /^вручну/);
  assert.equal(reach(8), 150000, 'other podilske row (without www) filled');
  assert.match(sheet.notes[7][4], /^авто · аудиторія podilske\.com/);
  assert.equal(reach(2), '', 'no reach for YouTube');
  assert.equal(reach(4), '', 'unknown site stays empty');

  // A new podilske link pasted later gets reach and views straight away
  sheet.values[9] = [9, 'I', 'https://podilske.com/new', '', '', ''];
  sheet.notes[9] = ['', '', '', '', '', ''];
  env.ctx.handleEdit({ range: sheet.getRange(10, 3) });
  assert.equal(reach(10), 150000);
  assert.match(sheet.notes[9][3], /не знайдено/);

  // Pasting a whole row with an empty reach cell must not wipe the site's audience
  sheet.values[10] = [10, 'J', 'https://podilske.com/z', '', '', ''];
  sheet.notes[10] = ['', '', '', '', '', ''];
  env.ctx.handleEdit({ range: sheet.getRange(11, 1, 1, 6) });
  assert.equal(reach(11), 150000);
  assert.equal(JSON.parse(env.props.get('audience'))['podilske.com'], 150000);

  // Clearing the one cell deliberately forgets the audience and clears the auto-filled rows
  sheet.values[4][4] = '';
  env.ctx.handleEdit({ range: sheet.getRange(5, 5) });
  assert.equal(reach(8), '');
  assert.equal(JSON.parse(env.props.get('audience'))['podilske.com'], undefined);
});

test('"Оновити дані" refreshes auto numbers but never overwrites manual ones', () => {
  const sheet = makeSheet();
  let env = createEnv(sheet, pagesFor(97186));
  env.ctx.setup();
  env.ctx.updateAll();
  // User corrects UNN by hand
  sheet.values[3][3] = 12000;
  env.ctx.handleEdit({ range: sheet.getRange(4, 4) });
  assert.match(sheet.notes[3][3], /^вручну/);

  // Next day: YouTube grew, the user presses the button again
  const props = env.props;
  env = createEnv(sheet, pagesFor(99000));
  for (const [k, v] of props) env.props.set(k, v);
  env.ctx.updateAll();
  assert.equal(sheet.values[1][3], 99000);
  assert.equal(sheet.values[3][3], 12000, 'manual UNN value kept');

  // A page that fails today keeps yesterday's number and says so
  const pages = pagesFor(99000);
  delete pages['https://www.youtube.com/watch?v=abc'];
  env = createEnv(sheet, pages);
  for (const [k, v] of props) env.props.set(k, v);
  env.ctx.updateAll();
  assert.equal(sheet.values[1][3], 99000);
  assert.match(sheet.notes[1][3], /не вдалося оновити/);
});

test('a long update continues by itself after the time limit', () => {
  const sheet = makeSheet();
  const env = createEnv(sheet, pagesFor());
  env.ctx.setup();
  vm.runInContext('VC.TIME_BUDGET_MS = -1', env.ctx); // out of time immediately
  env.ctx.updateAll();
  assert.equal(sheet.values[1][3], '');
  assert.ok(env.triggers.some((t) => t.handler === 'continueUpdate' && t.kind === 'time'));
  assert.equal(JSON.parse(env.props.get('pendingRows')).length, 8);

  vm.runInContext('VC.TIME_BUDGET_MS = 60000', env.ctx);
  env.ctx.continueUpdate();
  assert.equal(sheet.values[1][3], 97186);
  assert.equal(env.props.has('pendingRows'), false);
  assert.ok(!env.triggers.some((t) => t.handler === 'continueUpdate'));
});

test('page parsing matches the desktop app on the same samples', () => {
  const { ctx } = createEnv(createSheet('x', [HEADER]), {});
  const views = (html) => ctx.parseGenericPage_(html)?.views ?? null;
  assert.equal(views('<script type="application/ld+json">{"interactionStatistic":{"interactionType":"https://schema.org/ViewAction","userInteractionCount":"18462"}}</script>'), 18462);
  assert.equal(views('<div class="article__views"><i class="icon"></i> 3 641 </div>'), 3641);
  assert.equal(views('<span class="meta"><i class="fa fa-eye"></i> 1 360</span>'), 1360);
  assert.equal(views('<p>1,2 тис. переглядів</p>'), 1200);
  assert.equal(views('<span>👁 861</span>'), 861);
  assert.equal(views(`<aside><span class="views">9</span></aside><article><h1>Стаття</h1><span class="views">861</span></article>`), 861);
  assert.equal(views('<span class="views"><svg></svg></span><time>12.03.2026</time>'), null);
  assert.equal(ctx.parseAudience_('1,2 млн'), 1200000);
  assert.equal(ctx.parseAudience_('85 тис.'), 85000);
  assert.equal(ctx.parseAudience_(150000), 150000);
  assert.equal(ctx.parseAudience_('abc'), null);
  assert.equal(ctx.parseAudience_('76.68M'), 76680000);
  assert.equal(ctx.parseAudience_('1,200,000'), 1200000);
  assert.equal(ctx.parseAudience_('7 668'), 7668);
});
