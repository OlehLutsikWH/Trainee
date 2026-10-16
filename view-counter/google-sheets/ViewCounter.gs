/**
 * View Counter для Google Таблиць.
 *
 * Що робить:
 *  - поруч із колонкою «Перегляди» веде колонку «Охоплення (оцінка)»;
 *  - коли в колонку з посиланнями вставляють посилання, сам підтягує перегляди;
 *  - меню «📊 Перегляди → Оновити дані» оновлює всі рядки на сьогодні;
 *  - значення, вписані вручну, не перезаписує: оновлює лише клітинки з приміткою «авто»;
 *  - аудиторію сайту досить вписати в «Охоплення» одного рядка — вона підставиться
 *    в усі рядки цього сайту (і в нові) та запам'ятається.
 *
 * Встановлення: Розширення → Apps Script → вставити цей файл → зберегти →
 * оновити таблицю → меню «📊 Перегляди → Налаштувати таблицю».
 */

var VC = {
  MENU: '📊 Перегляди',
  REACH_HEADER: 'Охоплення (оцінка)',
  HEADER_ROWS_TO_SCAN: 5,
  BATCH_SIZE: 15,               // сторінок, що завантажуються паралельно
  TIME_BUDGET_MS: 4.5 * 60 * 1000, // Google обмежує один запуск ~6 хв; решту — наступним запуском
  MAX_ROWS_ON_EDIT: 25,         // скільки вставлених рядків рахувати одразу при вставці
  AUTO: 'авто',
  MANUAL: 'вручну',
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

// ---------------------------------------------------------------- меню та налаштування

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu(VC.MENU)
    .addItem('Оновити дані', 'updateAll')
    .addItem('Оновити виділені рядки', 'updateSelected')
    .addSeparator()
    .addItem('Налаштувати таблицю', 'setup')
    .addToUi();
}

/** Додає колонку «Охоплення (оцінка)» і вмикає автоматичний підрахунок при вставці посилань. */
function setup() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();
  var cols = findColumns_(sheet);
  if (!cols.url || !cols.views) {
    ui.alert('Не знайшов на цьому аркуші колонок «URL» (або «Посилання») і «Перегляди» у перших ' +
      VC.HEADER_ROWS_TO_SCAN + ' рядках. Відкрийте аркуш з публікаціями й запустіть ще раз.');
    return;
  }
  if (!cols.reach) {
    sheet.insertColumnAfter(cols.views);
    var header = sheet.getRange(cols.headerRow, cols.views + 1);
    sheet.getRange(cols.headerRow, cols.views).copyTo(header, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    header.setValue(VC.REACH_HEADER);
    header.setNote('Місячна аудиторія сайту (оцінка, не перегляди). Впишіть її в одному рядку сайту — ' +
      'вона підставиться в усі рядки цього сайту.');
  }
  PropertiesService.getDocumentProperties().setProperty('sheetName', sheet.getName());

  // Підрахунок при вставці посилання потребує «встановлюваного» тригера (простий onEdit не може завантажувати сторінки)
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'handleEdit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('handleEdit').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();

  ui.alert('Готово!\n\nТепер:\n• вставте посилання в колонку «' + sheet.getRange(cols.headerRow, cols.url).getValue() +
    '» — перегляди підтягнуться самі;\n• меню «' + VC.MENU + ' → Оновити дані» оновить усі рядки;\n' +
    '• аудиторію сайту впишіть у «' + VC.REACH_HEADER + '» одного рядка — вона з\'явиться в усіх рядках цього сайту.');
}

// ---------------------------------------------------------------- оновлення

/** Оновлює перегляди та охоплення в усіх рядках (кнопка / меню «Оновити дані»). */
function updateAll() {
  startUpdate_(null);
}

/** Оновлює лише виділені рядки. */
function updateSelected() {
  var range = SpreadsheetApp.getActiveRange();
  var rows = [];
  for (var r = range.getRow(); r <= range.getLastRow(); r++) rows.push(r);
  startUpdate_(rows);
}

/** Продовження довгого оновлення (запускається тригером за часом). */
function continueUpdate() {
  deleteTriggers_('continueUpdate');
  var props = PropertiesService.getDocumentProperties();
  var pending = JSON.parse(props.getProperty('pendingRows') || '[]');
  if (pending.length) startUpdate_(pending, true);
}

function startUpdate_(rows, isContinuation) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(2000)) {
    toast_('Оновлення вже триває — зачекайте, будь ласка.');
    return;
  }
  try {
    var sheet = getSheet_();
    var cols = sheet && findColumns_(sheet);
    if (!cols || !cols.url || !cols.views) {
      toast_('Спершу запустіть «' + VC.MENU + ' → Налаштувати таблицю» на аркуші з публікаціями.');
      return;
    }
    if (!rows) {
      rows = [];
      for (var r = cols.headerRow + 1; r <= sheet.getLastRow(); r++) rows.push(r);
    }
    rows = rows.filter(function (r) { return r > cols.headerRow; });
    if (!isContinuation) toast_('Оновлюю ' + rows.length + ' рядків…');
    var left = updateRows_(sheet, cols, rows, Date.now() + VC.TIME_BUDGET_MS);
    var props = PropertiesService.getDocumentProperties();
    if (left.length) {
      // Не встигли за один запуск — продовжимо за хвилину автоматично
      props.setProperty('pendingRows', JSON.stringify(left));
      deleteTriggers_('continueUpdate');
      ScriptApp.newTrigger('continueUpdate').timeBased().after(60 * 1000).create();
      toast_('Оновлено ' + (rows.length - left.length) + ' рядків, решту (' + left.length + ') оновлю за хвилину.');
    } else {
      props.deleteProperty('pendingRows');
      toast_('Готово: дані оновлено ' + now_() + '.');
    }
  } finally {
    lock.releaseLock();
  }
}

/** Рахує рядки пачками, поки є час. Повертає рядки, до яких не дійшли. */
function updateRows_(sheet, cols, rows, deadline) {
  var audience = getAudience_();
  var queue = rows.slice();
  while (queue.length) {
    if (Date.now() > deadline) return queue;
    var batch = queue.splice(0, VC.BATCH_SIZE);
    var items = [];
    batch.forEach(function (row) {
      var url = getUrl_(sheet.getRange(row, cols.url));
      if (url) items.push({ row: row, url: url });
    });
    var results = fetchViews_(items.map(function (i) { return i.url; }));
    items.forEach(function (item, i) {
      writeViews_(sheet.getRange(item.row, cols.views), results[i]);
      if (cols.reach) writeReach_(sheet.getRange(item.row, cols.reach), item.url, audience);
    });
  }
  return [];
}

// ---------------------------------------------------------------- реакція на ручні зміни

/** Встановлюваний тригер onEdit (створюється в setup). */
function handleEdit(e) {
  var sheet = e.range.getSheet();
  if (sheet.getName() !== PropertiesService.getDocumentProperties().getProperty('sheetName')) return;
  var cols = findColumns_(sheet);
  if (!cols.url || !cols.views) return;
  var first = e.range.getRow();
  var last = e.range.getLastRow();
  var left = e.range.getColumn();
  var right = e.range.getLastColumn();
  if (last <= cols.headerRow) return;
  first = Math.max(first, cols.headerRow + 1);

  // Спершу — ручні зміни (до автоматичного підрахунку, щоб не сплутати його значення з ручними)
  // Вручну вписали перегляди → позначити, щоб оновлення їх не перезаписувало
  if (left <= cols.views && cols.views <= right) {
    for (var v = first; v <= last; v++) {
      var cell = sheet.getRange(v, cols.views);
      cell.setNote(cell.getValue() === '' ? '' : VC.MANUAL + ' · ' + now_());
    }
  }

  // Вписали аудиторію сайту → запам'ятати й підставити в усі рядки цього сайту.
  // Видаляти аудиторію сайту можна лише очищенням однієї клітинки (а не вставкою рядка з порожньою)
  if (cols.reach && left <= cols.reach && cols.reach <= right) {
    var singleCell = first === last && left === right;
    for (var a = first; a <= last; a++) rememberAudience_(sheet, cols, a, singleCell);
  }

  // Вставили / змінили посилання → порахувати ці рядки
  if (left <= cols.url && cols.url <= right) {
    var rows = [];
    for (var r = first; r <= last; r++) rows.push(r);
    if (rows.length > VC.MAX_ROWS_ON_EDIT) {
      toast_('Вставлено багато посилань — рахую перші ' + VC.MAX_ROWS_ON_EDIT +
        '. Для решти натисніть «' + VC.MENU + ' → Оновити дані».');
      rows = rows.slice(0, VC.MAX_ROWS_ON_EDIT);
    }
    updateRows_(sheet, cols, rows, Date.now() + VC.TIME_BUDGET_MS);
  }
}

function rememberAudience_(sheet, cols, row, allowClear) {
  var url = getUrl_(sheet.getRange(row, cols.url));
  var site = siteOf_(url);
  if (!site || isPlatform_(site)) return;
  var cell = sheet.getRange(row, cols.reach);
  var value = parseAudience_(cell.getValue());
  if (!value && !allowClear) return;
  var audience = getAudience_();
  if (value) {
    audience[site] = value;
    cell.setValue(value).setNote(VC.MANUAL + ' · аудиторія ' + site + ' на місяць');
  } else {
    delete audience[site];
    cell.setNote('');
  }
  saveAudience_(audience);
  // Решта рядків цього сайту (не чіпаємо вписані вручну)
  for (var r = cols.headerRow + 1; r <= sheet.getLastRow(); r++) {
    if (r === row || siteOf_(getUrl_(sheet.getRange(r, cols.url))) !== site) continue;
    var other = sheet.getRange(r, cols.reach);
    if (other.getValue() !== '' && !isAuto_(other.getNote())) continue;
    if (value) other.setValue(value).setNote(VC.AUTO + ' · аудиторія ' + site + ' (вказана в рядку ' + row + ')');
    else other.setValue('').setNote('');
  }
}

// ---------------------------------------------------------------- запис у клітинки

function isAuto_(note) {
  return String(note || '').indexOf(VC.AUTO) === 0;
}

function writeViews_(cell, result) {
  var current = cell.getValue();
  var note = cell.getNote();
  // Вписане вручну не чіпаємо
  if (current !== '' && !isAuto_(note)) return;
  if (result.views != null) {
    cell.setValue(result.views).setNote(VC.AUTO + ' · ' + result.method + ' · оновлено ' + now_());
  } else if (current === '') {
    cell.setNote('не знайдено: ' + result.error + ' · ' + now_());
  } else {
    // Раніше знайдене лишаємо, але показуємо, що сьогодні оновити не вдалося
    cell.setNote(note.replace(/ · не вдалося оновити.*$/, '') + ' · не вдалося оновити ' + now_() + ': ' + result.error);
  }
}

function writeReach_(cell, url, audience) {
  var site = siteOf_(url);
  if (!site || isPlatform_(site)) return;
  var current = cell.getValue();
  if (current !== '' && !isAuto_(cell.getNote())) return;
  if (audience[site]) {
    cell.setValue(audience[site]).setNote(VC.AUTO + ' · аудиторія ' + site + ' на місяць');
  }
}

// ---------------------------------------------------------------- пошук колонок

function findColumns_(sheet) {
  var lastCol = sheet.getLastColumn();
  var rows = Math.min(VC.HEADER_ROWS_TO_SCAN, sheet.getLastRow());
  if (!lastCol || !rows) return {};
  var values = sheet.getRange(1, 1, rows, lastCol).getValues();
  for (var r = 0; r < values.length; r++) {
    var found = {};
    for (var c = 0; c < values[r].length; c++) {
      var h = String(values[r][c]).trim().toLowerCase();
      if (!found.url && /^(url|посилання|лінк|link|посилання на публікацію)$/.test(h)) found.url = c + 1;
      else if (!found.views && /^перегляди/.test(h)) found.views = c + 1;
      else if (!found.reach && /^охоплення/.test(h)) found.reach = c + 1;
    }
    if (found.url && found.views) {
      found.headerRow = r + 1;
      return found;
    }
  }
  return {};
}

function getSheet_() {
  var name = PropertiesService.getDocumentProperties().getProperty('sheetName');
  var ss = SpreadsheetApp.getActive();
  return (name && ss.getSheetByName(name)) || ss.getActiveSheet();
}

/** Посилання з клітинки: текст, =HYPERLINK(...) або посилання в тексті клітинки. */
function getUrl_(cell) {
  var formula = cell.getFormula();
  var m = formula && formula.match(/^=HYPERLINK\(\s*"([^"]+)"/i);
  if (m) return m[1];
  var value = String(cell.getValue()).trim();
  if (/^https?:\/\//i.test(value)) return value;
  var rich = cell.getRichTextValue && cell.getRichTextValue();
  var link = rich && rich.getLinkUrl();
  return link && /^https?:\/\//i.test(link) ? link : '';
}

// ---------------------------------------------------------------- аудиторії сайтів

function getAudience_() {
  return JSON.parse(PropertiesService.getDocumentProperties().getProperty('audience') || '{}');
}

function saveAudience_(audience) {
  PropertiesService.getDocumentProperties().setProperty('audience', JSON.stringify(audience));
}

/** 150000, "150 000", "150K", "1.2M", "85 тис.", "1,2 млн" → число */
function parseAudience_(value) {
  if (typeof value === 'number') return value > 0 ? Math.round(value) : null;
  var compact = String(value).replace(/[\s\u00a0\u202f]/g, '').toLowerCase();
  // Число з роздільниками тисяч: 1,200,000 / 1.200.000
  if (/^\d{1,3}([.,])\d{3}(\1\d{3})*$/.test(compact)) return Number(compact.replace(/[.,]/g, ''));
  var m = compact.match(/^(\d+(?:[.,]\d+)?)(k|к|тис\.?|m|м|млн\.?)?$/);
  if (!m) return null;
  var n = Number(m[1].replace(',', '.'));
  var mult = m[2] ? (/^(k|к|тис)/.test(m[2]) ? 1e3 : 1e6) : 1;
  return n > 0 ? Math.round(n * mult) : null;
}

// ---------------------------------------------------------------- завантаження сторінок

/** Для кожного посилання: { views, method } або { error }. */
function fetchViews_(urls) {
  var plans = urls.map(planFetch_);
  var requests = [];
  plans.forEach(function (p) {
    if (p.fetchUrl) {
      p.requestIndex = requests.length;
      requests.push({
        url: p.fetchUrl,
        muteHttpExceptions: true,
        followRedirects: true,
        headers: { 'User-Agent': VC.USER_AGENT, 'Accept-Language': 'uk,en;q=0.8' },
      });
    }
  });
  var responses = fetchAllSafe_(requests);
  return plans.map(function (p) {
    if (p.error) return { error: p.error };
    var res = responses[p.requestIndex];
    if (res.error) return { error: res.error };
    try {
      return p.parse(res);
    } catch (err) {
      return { error: String(err.message || err) };
    }
  });
}

/** fetchAll падає цілком, якщо хоч один сайт недоступний — тоді по одному. */
function fetchAllSafe_(requests) {
  if (!requests.length) return [];
  try {
    return UrlFetchApp.fetchAll(requests).map(wrapResponse_);
  } catch (e) {
    return requests.map(function (req) {
      try {
        return wrapResponse_(UrlFetchApp.fetch(req.url, req));
      } catch (err) {
        return { error: 'сайт недоступний' };
      }
    });
  }
}

function wrapResponse_(res) {
  var headers = res.getHeaders ? res.getHeaders() : {};
  return { code: res.getResponseCode(), body: res.getContentText(), headers: headers };
}

function parseUrl_(url) {
  var m = String(url).trim().match(/^https?:\/\/([^\/?#:]+)(?::\d+)?([^?#]*)(\?[^#]*)?/i);
  if (!m) return null;
  var query = {};
  (m[3] || '').replace(/^\?/, '').split('&').forEach(function (pair) {
    if (!pair) return;
    var kv = pair.split('=');
    query[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
  });
  return { host: m[1].toLowerCase().replace(/^www\.|^m\./, ''), path: m[2] || '/', query: query };
}

function siteOf_(url) {
  var u = url && parseUrl_(url);
  return u ? u.host : '';
}

function isPlatform_(site) {
  return /(^|\.)(youtube\.com|youtu\.be|t\.me|telegram\.me|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|x\.com|twitter\.com)$/.test(site);
}

/** Що завантажити для посилання й як розібрати відповідь. */
function planFetch_(url) {
  var u = parseUrl_(url);
  if (!u) return { error: 'некоректне посилання' };
  var host = u.host;

  // YouTube
  var yt = null;
  if (host === 'youtu.be') yt = u.path.split('/')[1];
  else if (host === 'youtube.com') yt = u.query.v || (u.path.match(/^\/(?:shorts|live|embed)\/([\w-]+)/) || [])[1];
  if (yt) {
    return {
      fetchUrl: 'https://www.youtube.com/watch?v=' + encodeURIComponent(yt) + '&hl=en',
      parse: function (res) {
        var m = res.body.match(/"viewCount"\s*:\s*"(\d+)"/);
        return m ? { views: Number(m[1]), method: 'YouTube' } : { error: 'YouTube не показав перегляди' };
      },
    };
  }

  // Telegram
  if (host === 't.me' || host === 'telegram.me') {
    if (/^\/c\//.test(u.path)) return { error: 'приватний канал — перегляди видно лише учасникам' };
    var post = u.path.match(/^\/(?:s\/)?(\w+)\/(\d+)/);
    if (post) {
      return {
        fetchUrl: 'https://t.me/' + post[1] + '/' + post[2] + '?embed=1&mode=tme',
        parse: function (res) {
          var v = telegramViews_(res.body);
          return v === null ? { error: 'пост приватний або видалений' } : { views: v, method: 'Telegram' };
        },
      };
    }
    var feed = u.path.match(/^\/(?:s\/)?(\w+)\/?$/);
    if (feed && u.query.before) {
      return {
        fetchUrl: 'https://t.me/s/' + feed[1] + '?before=' + encodeURIComponent(u.query.before),
        parse: function (res) {
          // Сторінка відкривається на останньому пості перед «before»
          var chunks = res.body.split('data-post="').slice(1);
          for (var i = chunks.length - 1; i >= 0; i--) {
            var v = telegramViews_(chunks[i]);
            if (v !== null) return { views: v, method: 'Telegram' };
          }
          return { error: 'пост не знайдено' };
        },
      };
    }
    return { error: 'посилання на канал, а не на пост' };
  }

  // TikTok
  if (host === 'tiktok.com' || host === 'vm.tiktok.com' || host === 'vt.tiktok.com') {
    return {
      fetchUrl: url,
      parse: function (res) {
        var m = res.body.match(/"playCount"\s*:\s*"?(\d+)"?/);
        return m ? { views: Number(m[1]), method: 'TikTok' } : { error: 'TikTok не показав перегляди' };
      },
    };
  }

  if (/(^|\.)(instagram\.com|facebook\.com|fb\.watch)$/.test(host)) {
    return { error: 'перегляди видно лише власнику акаунта — впишіть вручну' };
  }
  if (/(^|\.)(x\.com|twitter\.com)$/.test(host)) return { error: 'перегляди X недоступні — впишіть вручну' };

  // Будь-який інший сайт
  return {
    fetchUrl: url,
    parse: function (res) {
      if (isChallengePage_(res) ) {
        return { error: 'сайт захищений від ботів (Cloudflare) — порахуйте в програмі View Counter або впишіть вручну' };
      }
      if (res.code === 404 || res.code === 410) return { error: 'сторінку не знайдено (' + res.code + ')' };
      if (res.code >= 400) return { error: 'сайт відповів кодом ' + res.code };
      var found = parseGenericPage_(res.body);
      if (!found) return { error: 'лічильника на сторінці немає (або сайт показує його скриптом)' };
      if (!found.views) return { error: 'лічильник показує 0 — сайт, імовірно, рахує скриптом; перевірте вручну' };
      return found;
    },
  };
}

function isChallengePage_(res) {
  var h = res.headers || {};
  var mitigated = h['cf-mitigated'] || h['Cf-Mitigated'];
  return mitigated === 'challenge' ||
    /\/cdn-cgi\/challenge-platform\/|window\._cf_chl_opt|<title>\s*Just a moment/i.test(res.body || '');
}

// ---------------------------------------------------------------- розбір сторінок
// (та сама логіка, що й у програмі View Counter: src/platforms.js)

function telegramViews_(html) {
  var m = html.match(/class="tgme_widget_message_views"[^>]*>([^<]+)</);
  return m ? parseCompact_(m[1]) : null;
}

/** "1.2K" → 1200, "3,4M" → 3400000, "987" → 987 */
function parseCompact_(text) {
  var m = String(text).trim().replace(/\s/g, '').match(/^([\d.,]+)([KMB])?$/i);
  if (!m) return null;
  var suffix = (m[2] || '').toUpperCase();
  var num = suffix ? Number(m[1].replace(',', '.')) : Number(m[1].replace(/[.,]/g, ''));
  if (!isFinite(num)) return null;
  return Math.round(num * ({ K: 1e3, M: 1e6, B: 1e9 }[suffix] || 1));
}

var VIEW_WORDS =
  'переглядів|перегляди|перегляд|переглянуто|переглянули|прочитали|прочитано|хітів|' +
  'просмотров|просмотра|просмотры|просмотр|просмотрено|views|view|hits|reads';

// Лічильник, як його друкують сайти: "3 641", "1525", "1,2 тис.", "12.5K"
var COUNT = '(\\d+(?:[.,]\\d+)?\\s*(?:тис\\.?|тыс\\.?|k|к)(?![а-яіїєґa-z])|\\d{1,3}(?:[ \\u00a0\\u202f]\\d{3})+|\\d+)';

function toInt_(str) {
  var s = String(str).trim();
  var short = s.match(/^(\d+(?:[.,]\d+)?)\s*(?:тис|тыс|k|к)/i);
  if (short) return Math.round(Number(short[1].replace(',', '.')) * 1000);
  var n = Number(s.replace(/[\s  .,]/g, ''));
  return isFinite(n) ? n : null;
}

var ENTITIES = {
  quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', bull: '•', ndash: '–', mdash: '—',
  laquo: '«', raquo: '»', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '„',
};

function decodeHtml_(str) {
  return str
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCodePoint(Number(n)); })
    .replace(/&#x([\da-f]+);/gi, function (_, n) { return String.fromCodePoint(parseInt(n, 16)); })
    .replace(/&([a-z]+);/gi, function (m, name) { return ENTITIES[name.toLowerCase()] || m; })
    .replace(/&amp;/g, '&');
}

function pageText_(html) {
  return decodeHtml_(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')).replace(/\s+/g, ' ');
}

/** Елемент-лічильник (клас «views», «fa-eye», іконка ока) з числом; найближчий до заголовка статті. */
function findMarkedCounter_(html, near) {
  var markers = /<[a-z][^>]*\sclass=["']([^"']*)["'][^>]*>|<(?:use|img|svg)[^>]*(?:href|src)=["']([^"']*)["'][^>]*>/gi;
  var countFirst = new RegExp('^\\s*(?:👁️?\\s*)?' + COUNT + '(?![\\d.,:/])', 'i');
  var best = null;
  var m;
  while ((m = markers.exec(html)) !== null) {
    var isCounter = m[1] !== undefined
      ? /(?:^|[\s_-])(?:views?|eye|перегляд\w*|hits|watch(?:ed)?)(?:$|[\s_-])/i.test(m[1])
      : /(?:^|[#/_-])(?:icon-)?(?:eye|views?)(?:$|[._-])/i.test(m[2]);
    if (!isCounter) continue;
    var after = pageText_(html.slice(m.index + m[0].length, m.index + m[0].length + 400));
    var num = after.match(countFirst);
    if (!num) continue;
    var distance = Math.abs(m.index - near);
    if (!best || distance < best.distance) best = { distance: distance, value: toInt_(num[1]) };
  }
  return best ? best.value : null;
}

function findCounterInText_(text) {
  var eye = text.match(new RegExp('👁️?\\s*' + COUNT, 'i'));
  var before = text.match(new RegExp('(?:^|[^\\wа-яіїєґ])(?:' + VIEW_WORDS + ')\\s*:?\\s*' + COUNT + '(?![\\d])', 'i'));
  var after = text.match(new RegExp('(?:^|[^\\d.,])' + COUNT + '\\s*(?:' + VIEW_WORDS + ')(?![а-яіїєґa-z])', 'i'));
  var m = after || before || eye;
  return m ? toInt_(m[1]) : null;
}

/** Лічильник у рядку під заголовком («16 жовтня, 16:06 • 9306 перегляди») — до першого справжнього абзацу. */
function findHeadingCounter_(html) {
  var h1 = html.search(/<h1[\s>]/i);
  if (h1 < 0) return null;
  var rest = html.slice(h1, h1 + 50000);
  var end = rest.length;
  var paragraphs = /<p[\s>][\s\S]*?<\/p>/gi;
  var p;
  while ((p = paragraphs.exec(rest)) !== null) {
    if (pageText_(p[0]).trim().length > 80) { end = p.index; break; }
  }
  return findCounterInText_(pageText_(rest.slice(0, end)).slice(0, 300));
}

/** { views, method } або null, якщо лічильника не видно. */
function parseGenericPage_(html) {
  var ld = html.match(/"interactionType"\s*:\s*"[^"]*(?:WatchAction|ViewAction|ReadAction)"[^}]*?"userInteractionCount"\s*:\s*"?(\d+)/) ||
    html.match(/"userInteractionCount"\s*:\s*"?(\d+)"?[^}]*?"interactionType"\s*:\s*"[^"]*(?:WatchAction|ViewAction|ReadAction)"/) ||
    html.match(/itemprop=["']interactionCount["'][^>]*content=["'](?:UserPageVisits|UserViews):(\d+)/i);
  if (ld) {
    // Видимий лічильник важливіший: деякі сайти (unn.ua) оновлюють schema.org рідко
    var visible = findHeadingCounter_(html);
    if (visible > 0) return { views: visible, method: 'лічильник біля заголовка' };
    return { views: Number(ld[1]), method: 'schema.org' };
  }

  var attr = html.match(/\sdata-(?:views|view-count|views-count|post-views|count-views)=["'](\d+)["']/i);
  if (attr) return { views: Number(attr[1]), method: 'лічильник на сторінці' };

  var h1 = html.search(/<h1[\s>]/i);
  var marked = findMarkedCounter_(html, Math.max(h1, 0));
  if (marked !== null) return { views: marked, method: 'лічильник на сторінці' };

  var json = html.match(/"(?:views|viewsCount|views_count|view_count|viewCounter|pageviews|pageViews|page_views|hits|read_count|readCount)"\s*:\s*"?(\d+)"?[,}]/);
  if (json && Number(json[1]) > 0) return { views: Number(json[1]), method: 'дані сторінки' };

  var inText = (h1 > 0 ? findCounterInText_(pageText_(html.slice(h1))) : null);
  if (inText === null) inText = findCounterInText_(pageText_(html));
  if (inText !== null) return { views: inText, method: 'текст сторінки' };
  return null;
}

// ---------------------------------------------------------------- дрібниці

function now_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm');
}

function toast_(text) {
  SpreadsheetApp.getActive().toast(text, VC.MENU, 8);
}

function deleteTriggers_(handler) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
}
