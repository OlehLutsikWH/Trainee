import { app, BrowserWindow, session } from 'electron';

// Opens pages in hidden Chromium windows so counters that sites fill in with JavaScript
// (or that sit behind a "checking your browser" page) become visible to the parser.

const MAX_PARALLEL = 3;
const LOAD_TIMEOUT_MS = 30000;
const WAIT_AFTER_LOAD_MS = 12000;
const POLL_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function limiter(max) {
  let active = 0;
  const queue = [];
  return async (fn) => {
    if (active >= max) await new Promise((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export function createPageRenderer() {
  const ses = session.fromPartition('persist:page-renderer');
  // Look like regular Chrome: some sites refuse user agents that mention Electron
  ses.setUserAgent(app.userAgentFallback.replace(/ (Electron|view-counter)\/\S+/gi, ''));
  const limit = limiter(MAX_PARALLEL);

  // With a rule, read just the element the user pointed at on this site; otherwise the whole page
  const readScript = (rule) => rule
    ? `(() => { const els = document.querySelectorAll(${JSON.stringify(rule.selector)});
         const el = els[${Number(rule.index) || 0}] || els[0]; return el ? el.innerText : ''; })()`
    : 'document.documentElement.outerHTML';

  return (url, extract, rule) => limit(async () => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { session: ses, images: false, backgroundThrottling: false },
    });
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    try {
      // loadURL rejects on some redirects and slow pages; whatever has loaded is still worth reading
      await Promise.race([win.loadURL(url), sleep(LOAD_TIMEOUT_MS)]).catch(() => {});
      const deadline = Date.now() + WAIT_AFTER_LOAD_MS;
      for (;;) {
        if (win.isDestroyed()) return null;
        try {
          const result = extract(await win.webContents.executeJavaScript(readScript(rule)));
          if (result) return result;
          // Some counters load only once the article is scrolled into view
          await win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)');
        } catch {
          // The page may be navigating (e.g. after an anti-bot check); try again on the next tick
        }
        if (Date.now() > deadline) return null;
        await sleep(POLL_MS);
      }
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  });
}
