import { app, BrowserWindow, shell } from 'electron';
import { startServer } from '../src/server.js';
import { setPageRenderer } from '../src/platforms.js';
import { createPageRenderer } from './page-renderer.js';

// Desktop wrapper: runs the same local server on a free port and shows the page in an app window.

if (!app.requestSingleInstanceLock()) app.quit();

let win;

async function createWindow() {
  setPageRenderer(createPageRenderer());
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
