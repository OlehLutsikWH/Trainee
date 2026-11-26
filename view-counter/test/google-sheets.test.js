// Runs google-sheets/*.gs against a small in-memory imitation of the Apps Script services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CODE = ['ViewCounter.gs', 'LooqmeImport.gs']
  .map((f) => readFileSync(new URL(`../google-sheets/${f}`, import.meta.url), 'utf8'))
  .join('\n');

function createSheet(name, rows) {
  const width = Math.max(...rows.map((r) => r.length));
  const values = rows.map((r) => [...r, ...Array(width - r.length).fill('')]);
  const notes = values.map((r) => r.map(() => ''));
  const backgrounds = {};
  const ensure = (row, col) => {
    while (values.length < row) { values.push(Array(values[0].length).fill('')); notes.push(Array(values[0].length).fill('')); }
    while (values[0].length < col) { values.forEach((r) => r.push('')); notes.forEach((r) => r.push('')); }
  };
  const sheet = {
    values, notes, backgrounds,
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
        setValues(rows2) {
          rows2.forEach((r, i) => r.forEach((v, j) => { values[row - 1 + i][col - 1 + j] = v; }));
          return range;
        },
        getNotes: () => notes.slice(row - 1, row - 1 + numRows).map((r) => r.slice(col - 1, col - 1 + numCols)),
        setBackground(color) { backgrounds[row] = color; return range; },
        setNumberFormat() { return range; },
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

function createEnv(sheet, pages, extra = {}) {
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
      openById: (id) => extra.openById(id),
    },
    MimeType: { GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet' },
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
    LockService: { getDocumentLock: () => ({ tryLock: () => true, waitLock: () => true, releaseLock: () => {} }) },
    UrlFetchApp: {
      fetchAll: (reqs) => reqs.map(respond),
      fetch: (url, req) => respond({ ...req, url }),
    },
    Utilities: { formatDate: () => '15.10.2026 10:00' },
    Session: { getScriptTimeZone: () => 'Europe/Kyiv', getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    ...extra.globals,
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
  // unn.ua: the byline under the heading beats a stale schema.org count, sidebars don't
  const unn = (byline) => '<script type="application/ld+json">{"interactionStatistic":{"interactionType":"https://schema.org/ViewAction","userInteractionCount":"3590"}}</script>' +
    `<h1>Кабмін</h1><div><p>Київ • УНН</p><p>16:06 • ${byline}</p></div><p>${'Текст статті. '.repeat(10)}</p><aside>11497 перегляди</aside>`;
  assert.equal(views(unn('9306 перегляди')), 9306);
  assert.equal(views(unn('Політика')), 3590);
  assert.equal(ctx.parseAudience_('1,2 млн'), 1200000);
  assert.equal(ctx.parseAudience_('85 тис.'), 85000);
  assert.equal(ctx.parseAudience_(150000), 150000);
  assert.equal(ctx.parseAudience_('abc'), null);
  assert.equal(ctx.parseAudience_('76.68M'), 76680000);
  assert.equal(ctx.parseAudience_('1,200,000'), 1200000);
  assert.equal(ctx.parseAudience_('7 668'), 7668);
});

// ---------------------------------------------------------------- LOOQME import

// The columns of LOOQME's "Статті" sheet the import reads (the real export has ~56)
const LQ_HEAD = ['Заголовок', 'Тип ЗМІ', 'Джерело', 'Анотація', 'Текст', 'Ключове слово', 'Роль', 'Код', 'Дата виходу', 'URL',
  'Потенційні перегляди (ЗМІ)', 'Рівень видання', 'Потенційні перегляди (Соцмережі)', 'Назва місця публікації'];
const lq = (o) => LQ_HEAD.map((h) => o[h] ?? '');
const LQ_TABLE = [
  LQ_HEAD,
  lq({ 'Заголовок': 'Бригада шукає саме Вас', 'Тип ЗМІ': 'Соціальні мережі', 'Джерело': 'telegram.me', 'Ключове слово': '46 ОАеМБР', 'Код': '1', 'URL': 'https://t.me/x/1' }),
  lq({ 'Заголовок': 'Валерія Вовк Повернення додому', 'Тип ЗМІ': 'Соціальні мережі', 'Джерело': 'telegram.me', 'Назва місця публікації': 'Куди піти? Львів',
    'Текст': 'кошти будуть спрямовані на збір фонду «Тихо»', 'Ключове слово': 'БФ Тихо', 'Роль': 'Другорядна', 'Код': '2', 'Дата виходу': '2026-10-13',
    'URL': 'https://telegram.me/kudy_lviv/100', 'Потенційні перегляди (Соцмережі)': '1648' }),
  lq({ 'Заголовок': 'Духмяний благодійний проєкт', 'Тип ЗМІ': 'Соціальні мережі', 'Джерело': 'instagram', 'Назва місця публікації': 'БЛАГОДІЙНИЙ ФОНД «ТИХО»',
    'Текст': 'про запах дому', 'Ключове слово': 'БФ Тихо', 'Роль': 'Головна', 'Код': '3', 'Дата виходу': '2026-09-28', 'URL': 'https://www.instagram.com/p/AAA/' }),
  lq({ 'Заголовок': 'Нощта на любовта', 'Тип ЗМІ': 'Соціальні мережі', 'Джерело': 'facebook.com', 'Назва місця публікації': 'Книги за хората',
    'Текст': 'тя просто изпищя тихо', 'Ключове слово': 'БФ Тихо', 'Роль': 'Епізодична', 'Код': '4', 'Дата виходу': '2026-08-30',
    'URL': 'https://www.facebook.com/permalink.php?story_fbid=pfbid0X&id=1' }),
  lq({ 'Заголовок': 'Вже є в таблиці', 'Тип ЗМІ': 'Онлайн', 'Джерело': 'radioclub.ua', 'Текст': 'разом із фондом "Тихо"', 'Ключове слово': 'БФ Тихо',
    'Код': '5', 'Дата виходу': '2026-09-16', 'URL': 'http://radioclub.ua/news/vovk/' }),
  lq({ 'Заголовок': 'Розшифровано автоматично', 'Тип ЗМІ': 'Радіо', 'Джерело': 'Українське радіо (радіо)', 'Текст': 'на території майбутнього тихо фонду',
    'Ключове слово': 'БФ Тихо', 'Роль': 'Другорядна', 'Код': '6', 'Дата виходу': '2026-11-06', 'Потенційні перегляди (ЗМІ)': '1911' }),
  lq({ 'Заголовок': 'Хірург рятує руки', 'Тип ЗМІ': 'Онлайн', 'Джерело': 'ukrinfo.org.ua', 'Текст': 'Юрій Лазаренко; благодійний фонд «Тихо» допомагає', 'Ключове слово': 'БФ Тихо',
    'Роль': 'Епізодична', 'Код': '7', 'Дата виходу': '2026-11-08', 'URL': 'https://ukrinfo.org.ua/ukraine/hirurg', 'Рівень видання': 'Національний' }),
  lq({ 'Заголовок': 'Той самий пост ще раз', 'Ключове слово': 'БФ Тихо', 'Код': '2', 'URL': 'https://t.me/kudy_lviv/100' }),
];

// The real sheet's columns
const LQ_SHEET_HEAD = ['№', 'Проєкт / інфопривід', 'Заголовок / сторінка', 'Джерело', 'URL', 'Дата', 'Тип джерела', 'Перегляди',
  'Охоплення (оцінка)', 'Рівень', 'Тип згадки', 'Короткий контекст'];

function lqSheet() {
  return createSheet('Виходи в медіа', [
    LQ_SHEET_HEAD,
    [1, 'тур Валерії_Повернення додому', 'Валерія Вовк вирушає', 'Radioclub', 'https://radioclub.ua/news/vovk', '16.09.2026', 'Медіа', '', '', '', '', ''],
    [2, 'ReBone', 'Хірург (посилання лише в тексті)', 'https://ukrinfo.org.ua/', 'Хірург Юрій Лазаренко рятує руки', '08.11.2026', 'Медіа', '', '', '', '', ''],
    [3],
  ]);
}

test('LOOQME rows: own posts, projects, doubtful mentions and duplicates', () => {
  const sheet = lqSheet();
  const { ctx } = createEnv(sheet, {});
  const keys = ctx.existingKeys_(sheet, ctx.findColumns_(sheet));
  const plan = ctx.planLooqmeRows_(LQ_TABLE, keys);
  assert.equal(plan.skipped, 1, 'the brigade keyword is left out');
  assert.equal(plan.duplicates, 2, 'already in the sheet (http/https, trailing slash) and repeated in the report');
  const byCode = Object.fromEntries(plan.items.map((i) => [i.code, i]));
  assert.deepEqual(Object.keys(byCode), ['2', '3', '4', '6', '7']);

  const kudy = byCode['2'];
  assert.equal(kudy.values.project, 'тур Валерії_Повернення додому');
  assert.equal(kudy.values.source, 'Куди піти? Львів');
  assert.equal(kudy.values.type, 'Telegram');
  assert.equal(kudy.values.reach, 1648);
  assert.equal(kudy.values.mention, 'Пряма згадка');
  assert.equal(kudy.values.date.getFullYear(), 2026);
  assert.equal(kudy.check.length, 0);

  const own = byCode['3'];
  assert.equal(own.values.type, 'Власний канал фонду');
  assert.equal(own.values.mention, 'Власний пост');
  assert.deepEqual([...own.check].map((c) => c.split(' ')[0]), ['проєкт']);

  assert.match(byCode['4'].check.join(), /хибна згадка/);
  assert.equal(byCode['4'].values.type, 'Facebook');
  assert.match(byCode['6'].check.join(), /немає посилання/);
  assert.equal(byCode['6'].values.type, 'Радіо');
  assert.equal(byCode['6'].values.reach, 1911);
  // The sheet's ukrinfo row has no real URL, so it can't be matched: imported, but flagged as a likely duplicate
  assert.equal(byCode['7'].values.project, 'ReBone');
  assert.match(byCode['7'].check.join(), /можливий дубль рядка 3/);
  assert.equal(byCode['7'].values.level, 'Національний');
});

test('LOOQME rows are appended after the last filled row, numbered, marked and not imported twice', () => {
  const sheet = lqSheet();
  const { ctx } = createEnv(sheet, {});
  const cols = ctx.findColumns_(sheet);
  const plan = ctx.planLooqmeRows_(LQ_TABLE, ctx.existingKeys_(sheet, cols));
  const rows = ctx.writeLooqmeRows_(sheet, plan.items);
  assert.deepEqual([...rows], [4, 5, 6, 7, 8], 'row 4 had only a number in it');
  assert.deepEqual(sheet.values[3].slice(0, 7).map(String).slice(0, 5),
    ['3', 'тур Валерії_Повернення додому', 'Валерія Вовк Повернення додому', 'Куди піти? Львів', 'https://telegram.me/kudy_lviv/100']);
  assert.equal(sheet.values[3][6], 'Telegram');
  assert.equal(sheet.values[3][8], 1648);
  assert.equal(sheet.notes[3][2], 'LOOQME #2');
  assert.match(sheet.notes[3][8], /^LOOQME/, 'reach from LOOQME is not an "авто" value, so updates keep it');
  assert.equal(sheet.backgrounds[5], '#fff2cc', 'own post without a project is marked for checking (row 5)');
  assert.equal(sheet.backgrounds[4], undefined);
  assert.equal(sheet.values[7][0], 7);

  // The same report again: nothing new
  const again = ctx.planLooqmeRows_(LQ_TABLE, ctx.existingKeys_(sheet, cols));
  assert.equal(again.items.length, 0);
  assert.equal(again.duplicates, 7);
});

test('the LOOQME folder is imported end to end and the report moved to "Імпортовано"', () => {
  const sheet = lqSheet();
  const moved = [];
  const done = { getId: () => 'done' };
  const file = {
    getId: () => 'f1', getName: () => 'bftikho_articles.xlsx', getMimeType: () => 'application/vnd.google-apps.spreadsheet',
    getDateCreated: () => new Date(2026, 10, 11), moveTo: (f) => moved.push(f.getId()),
  };
  const folder = {
    getFiles: () => { const l = [file]; return { hasNext: () => l.length > 0, next: () => l.shift() }; },
    getFoldersByName: () => ({ hasNext: () => true, next: () => done }),
    isTrashed: () => false,
  };
  const report = { getSheetByName: (n) => (n === 'Статті' ? { getDataRange: () => ({ getValues: () => LQ_TABLE }) } : null), getSheets: () => [] };
  const env = createEnv(sheet, { 'https://telegram.me/': '<span class="tgme_widget_message_views">2.1K</span>', 'https://t.me/': '<span class="tgme_widget_message_views">2.1K</span>' }, {
    openById: (id) => { assert.equal(id, 'f1'); return report; },
    globals: { DriveApp: { getFolderById: () => folder } },
  });
  env.props.set('looqmeFolder', 'folder');
  env.props.set('sheetName', 'Виходи в медіа');
  env.ctx.importLooqme();
  assert.deepEqual(moved, ['done']);
  assert.match(env.toasts.join('\n'), /додано 5 нових згадок, з них 4 позначено/);
  // New rows are counted like pasted links, by a separate run a minute later
  assert.equal(sheet.values[3][7], '');
  assert.deepEqual(env.triggers.map((t) => [t.handler, t.after]), [['continueUpdate', 60000]]);
  env.ctx.continueUpdate();
  assert.equal(sheet.values[3][7], 2100);
});
