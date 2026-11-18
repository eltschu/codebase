'use strict';
/**
 * CodeBase desktop app (Electron).
 *
 * By default it runs the CodeBase server inside the app, on this computer only, and opens the editor in a window:
 * everything works offline and projects stay on this computer. From the File menu you can instead connect to a
 * CodeBase server (for example your hosted site) to use your account and publish sites.
 */
const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

// The editor keeps projects in the page's storage, which is tied to the address it was opened from.
// So the built-in server always uses the same port; it only moves if that port is taken.
const PREFERRED_PORT = 47821;
let localUrl = null;
async function startLocalServer() {
  if (localUrl) return localUrl;
  process.env.DATA_DIR = path.join(app.getPath('userData'), 'data');
  process.env.CODEBASE_DESKTOP = '1';
  process.env.ACCOUNTS = 'false';
  const { server } = require('../server.js');
  const settings = readSettings();
  const tryPort = port =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(server.address().port);
      });
    });
  let port;
  for (const candidate of [settings.port || PREFERRED_PORT, PREFERRED_PORT + 1, PREFERRED_PORT + 2, 0]) {
    try {
      port = await tryPort(candidate);
      break;
    } catch {}
  }
  if (settings.port && settings.port !== port)
    dialog.showMessageBox({
      type: 'warning',
      message: 'CodeBase started on a different port',
      detail: `Port ${settings.port} was in use, so your saved projects may not appear. Close whatever is using it and restart CodeBase.`,
    });
  writeSettings({ ...readSettings(), port: settings.port || port });
  return (localUrl = `http://127.0.0.1:${port}/`);
}

let win = null;
const startUrl = async () => readSettings().server || (await startLocalServer());

async function openMain() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'CodeBase',
    backgroundColor: '#0b0d18',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  guard(win);
  await loadStart();
  win.on('closed', () => (win = null));
}

async function loadStart() {
  const url = await startUrl();
  try {
    await win.loadURL(url);
  } catch (e) {
    if (!readSettings().server) throw e;
    const r = await dialog.showMessageBox(win, {
      type: 'error',
      message: `Couldn't reach ${new URL(url).host}`,
      detail: 'Check your internet connection, or work offline on this computer instead.',
      buttons: ['Work offline', 'Try again'],
    });
    if (r.response === 1) return loadStart();
    setServer(null);
  }
}

// Keep the window on CodeBase. Links to other sites open in the normal browser; previews open in a new window.
function guard(w) {
  const sameApp = url => {
    try {
      return new URL(url).origin === new URL(w.webContents.getURL()).origin;
    } catch {
      return false;
    }
  };
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (sameApp(url))
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1100,
          height: 800,
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
        },
      };
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!sameApp(url)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  w.webContents.on('did-create-window', guard);
}

function setServer(url) {
  writeSettings({ ...readSettings(), server: url || undefined });
  buildMenu();
  if (win) loadStart();
}

function askForServer() {
  const w = new BrowserWindow({
    parent: win,
    modal: true,
    width: 460,
    height: 270,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Connect to a server',
    backgroundColor: '#f4f5fb',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  w.setMenu(null);
  w.loadFile(path.join(__dirname, 'connect.html'), { query: { current: readSettings().server || '' } });
}
ipcMain.handle('codebase:set-server', (e, url) => {
  let clean;
  try {
    const u = new URL(String(url).trim());
    if (!/^https?:$/.test(u.protocol)) throw new Error();
    clean = u.origin + u.pathname.replace(/\/?$/, '/');
  } catch {
    return { error: 'Enter a full address, like https://codebase.example.com' };
  }
  BrowserWindow.fromWebContents(e.sender)?.close();
  setServer(clean);
  return { ok: true };
});

function buildMenu() {
  const server = readSettings().server;
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(mac ? [{ role: 'appMenu' }] : []),
      {
        label: 'File',
        submenu: [
          {
            label: 'Work offline on this computer',
            type: 'radio',
            checked: !server,
            click: () => server && setServer(null),
          },
          {
            label: server ? `Connected to ${new URL(server).host}` : 'Connect to a server…',
            type: 'radio',
            checked: !!server,
            click: askForServer,
          },
          ...(server ? [{ label: 'Change server…', click: askForServer }] : []),
          { type: 'separator' },
          mac ? { role: 'close' } : { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          {
            label: 'CodeBase on GitHub',
            click: () => shell.openExternal('https://github.com/eltschu/codebase'),
          },
        ],
      },
    ]),
  );
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    buildMenu();
    openMain();
    app.on('activate', () => BrowserWindow.getAllWindows().length || openMain());
  });
  app.on('window-all-closed', () => process.platform === 'darwin' || app.quit());
}
