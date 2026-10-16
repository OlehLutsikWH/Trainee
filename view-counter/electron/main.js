import { app, BrowserWindow, shell } from 'electron';
import { startServer, setTeacher, setDataDir } from '../src/server.js';
import { setPageRenderer, setSiteRules, setRealBrowser, siteKey, parseCountText, isCounterText } from '../src/platforms.js';
import { createPageRenderer } from './page-renderer.js';
import { createRealBrowser } from './real-browser.js';
import { createSiteRules } from './site-rules.js';
import { createTeacher } from './teacher.js';

// Desktop wrapper: runs the same local server on a free port and shows the page in an app window.

if (!app.requestSingleInstanceLock()) app.quit();

let win;
let realBrowser;

async function createWindow() {
  setDataDir(app.getPath('userData'));
  setPageRenderer(createPageRenderer());
  const rules = createSiteRules();
  setSiteRules(rules);
  realBrowser = createRealBrowser(app.getPath('userData'));
  setRealBrowser(realBrowser.render);
  const teach = createTeacher({ parent: () => win, isValid: isCounterText });
  // via 'chrome': the site blocks the built-in browser, so teach (and later read) it in Chrome/Edge
  setTeacher(async (url, via) => {
    const picked = via === 'chrome' ? await realBrowser.teach(url, isCounterText) : await teach(url);
    if (!picked) return null;
    rules.set(siteKey(url), { selector: picked.selector, index: picked.index, ...(via === 'chrome' ? { via } : {}) });
    return { views: parseCountText(picked.text) };
  }, { realBrowser: true });
  const port = await startServer(0);
  win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    title: 'View Counter',
    autoHideMenuBar: true,
  });
  // Links from the results table open in the normal browser, not inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { realBrowser?.close(); });
