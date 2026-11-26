import { BrowserWindow, session } from 'electron';

// Opens the page in a visible window and lets the user click the view counter. Returns
// { selector, index, text } describing the clicked element, or null if the window is closed.

import { PICK, PICKER_SCRIPT } from './picker-script.js';

export function createTeacher({ parent, isValid }) {
  return (url) => new Promise((resolve) => {
    const win = new BrowserWindow({
      parent: parent(),
      width: 1200,
      height: 850,
      title: 'Вкажіть лічильник переглядів',
      autoHideMenuBar: true,
      // Same browser profile as the hidden checks, so cookies from passed anti-bot pages carry over
      webPreferences: { session: session.fromPartition('persist:page-renderer') },
    });
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
      if (!win.isDestroyed()) win.destroy();
    };

    const inject = () => win.webContents.executeJavaScript(PICKER_SCRIPT).catch(() => {});
    win.webContents.on('dom-ready', inject);
    win.webContents.on('did-finish-load', inject);

    // Electron 33 passes (event, level, message, ...); newer versions put details on the event
    win.webContents.on('console-message', (event, level, message) => {
      const text = event?.message ?? message;
      if (typeof text !== 'string' || !text.startsWith(PICK)) return;
      const picked = JSON.parse(text.slice(PICK.length));
      if (picked === null) return finish(null);
      if (!isValid(picked.text)) {
        win.webContents
          .executeJavaScript(`window.__vcHint && window.__vcHint(${JSON.stringify(
            'Це не схоже на лічильник (немає числа або це дата). Клацніть саме на цифру переглядів.')})`)
          .catch(() => {});
        return;
      }
      finish(picked);
    });
    win.on('closed', () => finish(null));
    win.loadURL(url).catch(() => {});
  });
}
