/**
 * Імпорт згадок із LOOQME у таблицю «Виходи в медіа».
 *
 * Як працює:
 *  - раз на тиждень вивантажуєте з LOOQME звіт «Статті» (Excel) і кладете його в папку
 *    «LOOQME звіти» на своєму Google Диску (папку створює «Налаштувати імпорт LOOQME»);
 *  - щодня зранку скрипт сам перевіряє папку (або меню «📊 Перегляди → Імпорт з LOOQME»),
 *    додає в таблицю згадки, яких там ще немає, і переносить звіт у «LOOQME звіти/Імпортовано»;
 *  - нові рядки одразу рахуються: перегляди — як для посилань, вставлених вручну,
 *    охоплення — «потенційні перегляди» з LOOQME;
 *  - рядки, де скрипт не впевнений (не вгадав проєкт, у тексті немає явної згадки фонду),
 *    підсвічуються жовтим із приміткою «перевірити: …».
 *
 * Цей файл додається в той самий проєкт Apps Script, що й ViewCounter.gs.
 */

var LQ = {
  FOLDER: 'LOOQME звіти',
  DONE_FOLDER: 'Імпортовано',
  // Згадки з якими ключовими словами LOOQME вносити (решту, напр. «46 ОАеМБР», пропускати)
  KEYWORDS: [/тихо/i],
  // Власні канали фонду: позначаються типом OWN_TYPE
  OWN_NAME: /(?:фонд|бф)\W{0,3}[«"“]?\s*тихо|tykho/i,
  OWN_SITES: ['tykho.org'],
  OWN_TYPE: 'Власний канал фонду',
  // Явна згадка фонду в тексті; без неї рядок позначається «перевірити»
  FUND_MENTION: /(?:фонд\w*|бф)\W{0,3}[«"“„]?\s*тихо|tykho|тихо\s*фонд|тихофонд/i,
  // Проєкт за словами в тексті — перше збігле правило. Назви як у колонці «Проєкт».
  PROJECTS: [
    [/повернення додому|возвращение домой|валер[іи][яїіи]\s+вовк|valeri+a vovk/i, 'тур Валерії_Повернення додому'],
    [/rebone|лазаренк|velta/i, 'ReBone'],
    [/boh\s*sup/i, 'BOH SUP Fest'],
    [/караоке на майдані/i, 'Караоке на майдані'],
    [/охана/i, 'Охана'],
    [/ловчик|лапланд|лист\w* до санти/i, 'Ловчики / Лапландія'],
    [/starlink|старлінк|зв['’ʼ]язок між нами/i, 'Звʼязок між нами'],
    [/фіолет|fiolet/i, 'Фіолет / збір 1 млн'],
  ],
  DEFAULT_PROJECT: 'Загальне',
  CHECK_COLOR: '#fff2cc',
  SUMMARY_EMAIL: true,          // лист власнику таблиці після автоматичного імпорту
  DAILY_HOUR: 9,
};

// ---------------------------------------------------------------- меню

/** Створює папку для звітів і вмикає щоденну перевірку. */
function setupLooqme() {
  var folder = looqmeFolder_(true);
  deleteTriggers_('importLooqmeScheduled');
  ScriptApp.newTrigger('importLooqmeScheduled').timeBased().everyDays(1).atHour(LQ.DAILY_HOUR).create();
  // Без діалогового вікна: запущене з редактора Apps Script, воно чекає на клік у вкладці таблиці
  // і за 6 хвилин обривається з «Перевищено максимальний час виконання»
  Logger.log('Папка для звітів LOOQME: ' + folder.getUrl());
  toast_('Готово! Кладіть звіти LOOQME (Excel) у папку «' + LQ.FOLDER + '» на Диску — щодня близько ' +
    LQ.DAILY_HOUR + ':00 таблиця сама додасть нові згадки. Одразу: «' + VC.MENU + ' → Імпорт з LOOQME».');
}

/** Меню «Імпорт з LOOQME». */
function importLooqme() {
  var summary = runLooqmeImport_();
  toast_(summary.text);
}

/** Щоденний тригер: мовчить, коли нових звітів немає. */
function importLooqmeScheduled() {
  var summary = runLooqmeImport_();
  if (summary.files && LQ.SUMMARY_EMAIL) {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'LOOQME → «Виходи в медіа»: ' + summary.text,
      summary.text + '\n\n' + SpreadsheetApp.getActive().getUrl());
  }
}

// ---------------------------------------------------------------- імпорт

function runLooqmeImport_() {
  var folder = looqmeFolder_(false);
  if (!folder) return { files: 0, text: 'Спершу запустіть «' + VC.MENU + ' → Налаштувати імпорт LOOQME».' };
  var done = subfolder_(folder, LQ.DONE_FOLDER);
  var files = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (/spreadsheet|excel|officedocument\.spreadsheetml/.test(f.getMimeType())) files.push(f);
  }
  if (!files.length) return { files: 0, text: 'Нових звітів LOOQME у папці «' + LQ.FOLDER + '» немає.' };

  var sheet = getSheet_();
  var cols = sheet && findColumns_(sheet);
  if (!cols || !cols.url) return { files: 0, text: 'Не знайшов аркуша з публікаціями — запустіть «' + VC.MENU + ' → Налаштувати таблицю».' };

  var lock = LockService.getDocumentLock();
  if (!lock.waitLock(60 * 1000)) return { files: 0, text: 'Таблиця зайнята оновленням — спробую пізніше.' };
  var added = [];
  var stats = { added: 0, check: 0, duplicates: 0, skipped: 0 };
  try {
    files.sort(function (a, b) { return a.getDateCreated() - b.getDateCreated(); });
    files.forEach(function (file) {
      var table = readLooqmeTable_(file);
      var plan = planLooqmeRows_(table, existingKeys_(sheet, cols));
      added = added.concat(writeLooqmeRows_(sheet, plan.items));
      stats.added += plan.items.length;
      stats.check += plan.items.filter(function (i) { return i.check.length; }).length;
      stats.duplicates += plan.duplicates;
      stats.skipped += plan.skipped;
      file.moveTo(done);
    });
  } finally {
    lock.releaseLock();
  }
  // Перегляди нових рядків — окремим запуском за хвилину: разом з імпортом вони можуть
  // не вкластися в 6 хвилин, які Google дає одному запуску
  if (added.length) {
    var props = PropertiesService.getDocumentProperties();
    var pending = JSON.parse(props.getProperty('pendingRows') || '[]');
    props.setProperty('pendingRows', JSON.stringify(pending.concat(added)));
    deleteTriggers_('continueUpdate');
    ScriptApp.newTrigger('continueUpdate').timeBased().after(60 * 1000).create();
  }
  return {
    files: files.length,
    text: 'додано ' + stats.added + ' нових згадок' + (stats.check ? ', з них ' + stats.check + ' позначено «перевірити» (жовті)' : '') +
      '; вже були в таблиці: ' + stats.duplicates + '; інші ключові слова: ' + stats.skipped + '.' +
      (added.length ? ' Перегляди нових рядків з\'являться за кілька хвилин.' : ''),
  };
}

function looqmeFolder_(create) {
  var props = PropertiesService.getDocumentProperties();
  var id = props.getProperty('looqmeFolder');
  if (id) {
    try {
      var f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* видалили — створимо знову */ }
  }
  if (!create) return null;
  var found = DriveApp.getFoldersByName(LQ.FOLDER);
  var folder = found.hasNext() ? found.next() : DriveApp.createFolder(LQ.FOLDER);
  subfolder_(folder, LQ.DONE_FOLDER);
  props.setProperty('looqmeFolder', folder.getId());
  return folder;
}

function subfolder_(folder, name) {
  var found = folder.getFoldersByName(name);
  return found.hasNext() ? found.next() : folder.createFolder(name);
}

/** Аркуш «Статті» зі звіту як масив рядків (перший — заголовки). Excel спершу конвертується в Google Таблицю. */
function readLooqmeTable_(file) {
  var id = file.getId();
  var temp = null;
  if (file.getMimeType() !== MimeType.GOOGLE_SHEETS) {
    var res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '/copy', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({ name: 'LOOQME (тимчасова копія)', mimeType: MimeType.GOOGLE_SHEETS }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) throw new Error('Не вдалося відкрити звіт «' + file.getName() + '»: ' + res.getContentText());
    temp = id = JSON.parse(res.getContentText()).id;
  }
  try {
    var ss = SpreadsheetApp.openById(id);
    var sh = ss.getSheetByName('Статті') || ss.getSheets().filter(function (s) {
      return s.getLastRow() > 1 && s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0].indexOf('URL') >= 0;
    })[0];
    if (!sh) throw new Error('У звіті «' + file.getName() + '» немає аркуша «Статті».');
    return sh.getDataRange().getValues();
  } finally {
    if (temp) DriveApp.getFileById(temp).setTrashed(true);
  }
}

// ---------------------------------------------------------------- що вносити

/**
 * Рядки звіту → нові рядки таблиці.
 * existing: { urls: {норм. URL: true}, codes: {код LOOQME: true}, siteDays: {'сайт|рррр-мм-дд': номер рядка} }.
 * Повертає { items: [{ code, values: {...}, check: [причини] }], duplicates, skipped }.
 */
function planLooqmeRows_(table, existing) {
  var head = table[0].map(function (h) { return String(h).trim(); });
  var col = function (row, name) {
    var i = head.indexOf(name);
    return i < 0 || row[i] == null ? '' : row[i];
  };
  var seenUrls = {};
  var seenCodes = {};
  Object.keys(existing.urls).forEach(function (k) { seenUrls[k] = true; });
  Object.keys(existing.codes).forEach(function (k) { seenCodes[k] = true; });
  var out = { items: [], duplicates: 0, skipped: 0 };

  table.slice(1).forEach(function (row) {
    if (!row.some(function (v) { return v !== '' && v != null; })) return;
    var keyword = String(col(row, 'Ключове слово'));
    if (!LQ.KEYWORDS.some(function (re) { return re.test(keyword); })) { out.skipped++; return; }
    var code = String(col(row, 'Код')).trim();
    var url = String(col(row, 'URL')).trim();
    var key = normUrl_(url);
    if ((code && seenCodes[code]) || (key && seenUrls[key])) { out.duplicates++; return; }
    if (code) seenCodes[code] = true;
    if (key) seenUrls[key] = true;

    var site = String(col(row, 'Джерело')).trim();
    var place = String(col(row, 'Назва місця публікації')).trim();
    var title = oneLine_(col(row, 'Заголовок'));
    var text = String(col(row, 'Текст')) + ' ' + title + ' ' + String(col(row, 'Анотація'));
    var own = LQ.OWN_SITES.indexOf(site) >= 0 || LQ.OWN_NAME.test(place);
    var check = [];

    var project = '';
    for (var p = 0; p < LQ.PROJECTS.length && !project; p++) if (LQ.PROJECTS[p][0].test(text)) project = LQ.PROJECTS[p][1];
    if (!project) {
      project = LQ.DEFAULT_PROJECT;
      check.push('проєкт не вгадав — стоїть «' + LQ.DEFAULT_PROJECT + '»');
    }
    if (!own && !LQ.FUND_MENTION.test(text)) check.push('у тексті немає явної згадки фонду — можливо, хибна згадка');
    if (!url) check.push('у звіті немає посилання (ефір / друк)');
    var date = looqmeDate_(col(row, 'Дата виходу'));
    var sameDay = existing.siteDays && existing.siteDays[siteDay_(url, date)];
    if (sameDay) check.push('можливий дубль рядка ' + sameDay + ' (той самий сайт і дата, інше посилання)');

    var reach = Number(col(row, 'Потенційні перегляди (ЗМІ)')) || Number(col(row, 'Потенційні перегляди (Соцмережі)')) || '';
    out.items.push({
      code: code,
      check: check,
      values: {
        project: project,
        title: title.slice(0, 200) || oneLine_(col(row, 'Анотація')).slice(0, 120),
        source: place || site,
        url: url,
        date: date,
        type: own ? LQ.OWN_TYPE : sourceType_(site, String(col(row, 'Тип ЗМІ'))),
        reach: reach,
        level: String(col(row, 'Рівень видання')),
        mention: own ? 'Власний пост' : mentionType_(String(col(row, 'Роль'))),
        context: oneLine_(col(row, 'Анотація')).slice(0, 250),
      },
    });
  });
  return out;
}

function sourceType_(site, mediaType) {
  var bySite = {
    'facebook.com': 'Facebook', 'instagram': 'Instagram', 'telegram.me': 'Telegram', 't.me': 'Telegram',
    'youtube': 'YouTube', 'youtube.com': 'YouTube', 'tiktok.com': 'TikTok', 'threads': 'Threads', 'twitter': 'X (Twitter)',
  };
  if (bySite[site]) return bySite[site];
  var byType = { 'Онлайн': 'Медіа', 'Радіо': 'Радіо', 'ТБ': 'ТБ', 'Інформаційне агентство': 'Інформагентство', 'Преса': 'Преса', 'Форум': 'Форум' };
  return byType[mediaType] || mediaType || 'Медіа';
}

function mentionType_(role) {
  if (role === 'Головна') return 'Пряма згадка (головна тема)';
  if (role === 'Другорядна') return 'Пряма згадка';
  if (role === 'Епізодична') return 'Згадка мимохідь';
  return '';
}

function looqmeDate_(v) {
  if (v instanceof Date) return v;
  var m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : '';
}

function oneLine_(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

/** 'сайт|рррр-мм-дд' для пошуку того самого виходу з іншим посиланням (крім соцмереж). */
function siteDay_(url, date) {
  var site = normUrl_(url).split('/')[0];
  if (!site || !(date instanceof Date) || isNaN(date)) return '';
  if (/(^|\.)(facebook\.com|instagram\.com|t\.me|youtube\.com|youtu\.be|tiktok\.com|threads\.net|x\.com|twitter\.com)$/.test(site)) return '';
  return site + '|' + date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate();
}

function sheetDate_(v) {
  if (v instanceof Date) return v;
  var m = String(v).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
}

/** Посилання для порівняння: без www, протоколу, «/» у кінці; telegram.me = t.me. */
function normUrl_(url) {
  var m = String(url || '').trim().match(/^(?:https?:\/\/)?([^/?#]+)([^?#]*)(\?[^#]*)?/i);
  if (!m || !m[1] || m[1].indexOf('.') < 0) return '';
  var host = m[1].toLowerCase().replace(/^(?:www|m)\./, '').replace(/^telegram\.me$/, 't.me');
  var query = /facebook\.com$/.test(host) && m[3] ? m[3] : ''; // permalink.php?story_fbid=…
  return host + m[2].replace(/\/+$/, '') + query;
}

// ---------------------------------------------------------------- запис у таблицю

/** Посилання і коди LOOQME, які вже є в таблиці. */
function existingKeys_(sheet, cols) {
  var keys = { urls: {}, codes: {}, siteDays: {} };
  var n = sheet.getLastRow() - cols.headerRow;
  if (n <= 0) return keys;
  var urlRange = sheet.getRange(cols.headerRow + 1, cols.url, n, 1);
  var values = urlRange.getValues();
  var rich = urlRange.getRichTextValues ? urlRange.getRichTextValues() : null;
  values.forEach(function (r, i) {
    var link = rich && rich[i][0] && rich[i][0].getLinkUrl();
    [r[0], link].forEach(function (u) { var k = normUrl_(u); if (k) keys.urls[k] = true; });
  });
  var map = tableColumns_(sheet, cols.headerRow);
  if (map.date) {
    var dates = sheet.getRange(cols.headerRow + 1, map.date, n, 1).getValues();
    var sources = map.source ? sheet.getRange(cols.headerRow + 1, map.source, n, 1).getValues() : null;
    values.forEach(function (r, i) {
      var link = rich && rich[i][0] && rich[i][0].getLinkUrl();
      // Сайт — з посилання, а якщо його немає, то з «Джерела», коли там адреса сайту
      [r[0], link, sources && sources[i][0]].forEach(function (u) {
        var k = siteDay_(u, sheetDate_(dates[i][0]));
        if (k && !keys.siteDays[k]) keys.siteDays[k] = cols.headerRow + 1 + i;
      });
    });
  }
  var title = map.title;
  if (title) {
    sheet.getRange(cols.headerRow + 1, title, n, 1).getNotes().forEach(function (r) {
      var m = String(r[0]).match(/LOOQME #(\d+)/);
      if (m) keys.codes[m[1]] = true;
    });
  }
  return keys;
}

/** Колонки таблиці за заголовками (порядок колонок може бути будь-який). */
function tableColumns_(sheet, headerRow) {
  var head = sheet.getRange(headerRow, 1, 1, sheet.getLastColumn()).getValues()[0];
  var map = {};
  var rules = [
    ['number', /^№$|^n$|^#$/], ['project', /^проєкт|^проект|^подія/], ['title', /^заголовок/], ['source', /^джерело/],
    ['url', /^url$|^посилання/], ['date', /^дата/], ['type', /^тип джерела|^тип змі/], ['reach', /^охоплення/],
    ['level', /^рівень/], ['mention', /^тип згадки/], ['context', /контекст|^коментар/],
  ];
  head.forEach(function (h, i) {
    var t = String(h).trim().toLowerCase();
    if (t === '=char(8470)') t = '№';
    rules.forEach(function (r) { if (!map[r[0]] && r[1].test(t)) map[r[0]] = i + 1; });
  });
  return map;
}

/** Дописує рядки після останнього заповненого. Повертає номери нових рядків. */
function writeLooqmeRows_(sheet, items) {
  if (!items.length) return [];
  var cols = findColumns_(sheet);
  var map = tableColumns_(sheet, cols.headerRow);
  var width = sheet.getLastColumn();
  // Останній рядок із даними (рядки, де заповнено лише «№», вважаються порожніми)
  var data = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), width).getValues();
  var last = cols.headerRow;
  var maxNumber = 0;
  data.forEach(function (r, i) {
    if (i < cols.headerRow) return;
    if (map.number && Number(r[map.number - 1]) > maxNumber) maxNumber = Number(r[map.number - 1]);
    if (r.some(function (v, c) { return c + 1 !== map.number && v !== ''; })) last = i + 1;
  });

  var rows = [];
  var next = maxNumber + 1;
  items.forEach(function (item, k) {
    var row = last + 1 + k;
    var line = sheet.getRange(row, 1, 1, width).getValues()[0];
    var v = item.values;
    var put = function (name, value) { if (map[name]) line[map[name] - 1] = value; };
    // Рядок із наперед проставленим «№» зберігає свій номер
    var number = map.number && Number(line[map.number - 1]);
    if (number) next = Math.max(next, number + 1);
    else put('number', next++);
    put('project', v.project);
    put('title', v.title);
    put('source', v.source);
    put('url', v.url);
    put('date', v.date);
    put('type', v.type);
    put('reach', v.reach);
    put('level', v.level);
    put('mention', v.mention);
    put('context', v.context);
    sheet.getRange(row, 1, 1, width).setValues([line]);
    if (map.date && v.date) sheet.getRange(row, map.date).setNumberFormat('dd.mm.yyyy');
    if (map.title) {
      sheet.getRange(row, map.title).setNote('LOOQME #' + item.code + (item.check.length ? '\nперевірити: ' + item.check.join('; ') : ''));
    }
    if (map.reach && v.reach !== '') {
      sheet.getRange(row, map.reach).setNote('LOOQME · потенційні перегляди цієї публікації');
    }
    if (item.check.length) sheet.getRange(row, 1, 1, width).setBackground(LQ.CHECK_COLOR);
    rows.push(row);
  });
  return rows;
}
