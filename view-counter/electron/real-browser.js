import path from 'node:path';
import { chromium } from 'playwright-core';
import { PICK, PICKER_SCRIPT } from './picker-script.js';

// Drives the user's own Chrome (or Edge) for sites whose anti-bot check (Cloudflare) refuses the
// built-in browser. It uses a separate profile owned by the app, so the user's everyday browser
// and its sign-ins are untouched; a check passed there once is remembered for later runs.
// Everything happens in one visible window, one page at a time.

// Installed browsers to try, in order (Playwright finds them in their standard install locations)
const BROWSERS = [{ channel: 'chrome' }, { channel: 'msedge' }];
const LOAD_TIMEOUT_MS = 30000;
const WAIT_AFTER_LOAD_MS = 20000; // anti-bot checks can take a while to clear
const POLL_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in the page: text of the element a taught rule points at
function readRuleElement({ selector, index }) {
  const els = document.querySelectorAll(selector);
  const el = els[index] || els[0];
  return el ? el.innerText : '';
}

export function createRealBrowser(userDataDir, browsers = BROWSERS) {
  let contextPromise = null;
  let queue = Promise.resolve();

  function getContext() {
    if (!contextPromise) {
      contextPromise = (async () => {
        for (const browser of browsers) {
          try {
            const profile = path.join(userDataDir, `browser-${browser.channel ?? 'custom'}`);
            const context = await chromium.launchPersistentContext(profile, {
              ...browser,
              headless: false,
              viewport: null,
              args: ['--no-first-run', '--no-default-browser-check'],
            });
            // The user may close the window; start a fresh one next time
            context.on('close', () => { contextPromise = null; });
            return context;
          } catch {
            // Not installed (or failed to start): try the next browser
          }
        }
        throw new Error('Не знайдено Google Chrome або Microsoft Edge на цьому комп’ютері');
      })();
      contextPromise.catch(() => { contextPromise = null; });
    }
    return contextPromise;
  }

  async function getPage() {
    const context = await getContext();
    const page = context.pages().find((p) => !p.isClosed()) ?? (await context.newPage());
    await page.bringToFront().catch(() => {});
    return page;
  }

  // One page in one window: run tasks one after another
  function serial(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  // Same contract as the built-in page renderer: extract(text) until it returns a result, or null
  const render = (url, extract, rule) => serial(async () => {
    const page = await getPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT_MS }).catch(() => {});
    const deadline = Date.now() + WAIT_AFTER_LOAD_MS;
    for (;;) {
      if (page.isClosed()) return null;
      try {
        const text = rule
          ? await page.evaluate(readRuleElement, { selector: rule.selector, index: Number(rule.index) || 0 })
          : await page.evaluate(() => document.documentElement.outerHTML);
        const result = extract(text);
        if (result) return result;
      } catch {
        // Navigating (e.g. the anti-bot check finished and reloaded the page): try again
      }
      if (Date.now() > deadline) return null;
      await sleep(POLL_MS);
    }
  });

  // Opens the page and waits for the user to click the view counter (see picker-script.js).
  // Resolves with { selector, index, text }, or null if the user cancels or closes the window.
  const teach = (url, isValid) => serial(async () => {
    const page = await getPage();
    return new Promise((resolve) => {
      let done = false;
      const inject = () => page.evaluate(PICKER_SCRIPT).catch(() => {});
      const finish = (value) => {
        if (done) return;
        done = true;
        page.off('console', onConsole);
        page.off('domcontentloaded', inject);
        page.off('close', onClose);
        // Drop the click-catching overlay
        if (!page.isClosed()) page.goto('about:blank').catch(() => {});
        resolve(value);
      };
      const onClose = () => finish(null);
      const onConsole = (msg) => {
        const text = msg.text();
        if (!text.startsWith(PICK)) return;
        const picked = JSON.parse(text.slice(PICK.length));
        if (picked === null) return finish(null);
        if (!isValid(picked.text)) {
          page.evaluate((hint) => window.__vcHint && window.__vcHint(hint),
            'Це не схоже на лічильник (немає числа або це дата). Клацніть саме на цифру переглядів.').catch(() => {});
          return;
        }
        finish(picked);
      };
      page.on('console', onConsole);
      page.on('domcontentloaded', inject);
      page.on('close', onClose);
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT_MS }).catch(() => {}).then(inject);
    });
  });

  async function close() {
    if (contextPromise) await (await contextPromise.catch(() => null))?.close().catch(() => {});
  }

  return { render, teach, close, getPage };
}
