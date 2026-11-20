// Brain Desk: Electron main process. Owns the vault connection, the git
// queue, Claude drafting, and the local server the Chrome button talks to.
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Actions, Store } = require('./lib/actions');
const { GitQueue } = require('./lib/git');
const { Vault } = require('./lib/vault');
const server = require('./lib/server');

let win = null, actions = null, gitQueue = null, watcher = null, store = null;
const configFile = () => path.join(app.getPath('userData'), 'config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch (_) { return {}; } };
const writeConfig = c => { fs.mkdirSync(path.dirname(configFile()), { recursive: true }); fs.writeFileSync(configFile(), JSON.stringify(c, null, 2)); };

const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
let changeTimer = null;
const changed = () => { clearTimeout(changeTimer); changeTimer = setTimeout(() => { send('changed'); updateBadge(); }, 250); };

function updateBadge() {
  if (!actions || !app.dock) return;
  try {
    const s = actions.snapshot();
    const n = s.people.filter(p => s.drafts[p.id] || p.owe || (p.next && p.next <= s.today)).length
      + s.inbound.filter(c => c.reach_out_on && c.reach_out_on <= s.today && c.status !== 'reached-out').length;
    app.dock.setBadge(n ? String(n) : '');
  } catch (_) { /* vault mid-write */ }
}

async function connect(vaultPath) {
  const v = new Vault(vaultPath);
  if (!v.isVault()) throw new Error('That folder doesn\'t look like the canaan-brain vault (no People/, Inbound/, Companies/ or VAULT_SCHEMA.md).');
  gitQueue = new GitQueue(vaultPath);
  const gitCheck = await gitQueue.check();
  gitQueue.on('status', st => send('git', st));
  store = store || new Store(path.join(app.getPath('userData'), 'state.json'));
  actions = new Actions({ vaultRoot: vaultPath, store, gitQueue, onChange: changed });
  if (watcher) watcher.close();
  try {
    watcher = fs.watch(vaultPath, { recursive: true }, (_e, f) => {
      if (f && /^(People|Inbound|Companies)\/.*\.md$/.test(f)) changed();
    });
  } catch (_) { /* watching is a convenience */ }
  writeConfig({ ...readConfig(), vaultPath });
  updateBadge();
  return { vaultPath, git: gitCheck };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 900, minHeight: 600,
    title: 'Brain Desk', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#F7F8FA', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
}

function openExternal(url) {
  if (/^(https?:|mailto:|obsidian:)/i.test(url)) shell.openExternal(url);
}

// Actions the window may call. Anything else is refused.
const ALLOWED = ['draft', 'saveDraft', 'discardDraft', 'logSent', 'logReply', 'snooze', 'closeOut', 'setupOutreach',
  'addPerson', 'addInbound', 'setInboundStatus', 'setDealSheet', 'setReachOut', 'addTouch', 'startOutreach'];

ipcMain.handle('init', async () => {
  const cfg = readConfig();
  const suggestion = path.join(os.homedir(), 'Desktop/canaan-brain');
  if (cfg.vaultPath && !actions) {
    try { await connect(cfg.vaultPath); } catch (e) { return { connected: false, suggestion, error: e.message }; }
  }
  return { connected: !!actions, vaultPath: cfg.vaultPath || null, suggestion: fs.existsSync(suggestion) ? suggestion : null,
    loginItem: app.getLoginItemSettings().openAtLogin, extensionDir: path.join(__dirname, 'extension'), port: server.PORT };
});
ipcMain.handle('connect', async (_e, p) => connect(p));
ipcMain.handle('choose-vault', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose your canaan-brain vault folder', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return connect(r.filePaths[0]);
});
ipcMain.handle('snapshot', () => (actions ? actions.snapshot() : null));
ipcMain.handle('act', async (_e, name, ...args) => {
  if (!actions) throw new Error('No vault connected');
  if (!ALLOWED.includes(name)) throw new Error('Unknown action ' + name);
  return actions[name](...args);
});
ipcMain.handle('copy', (_e, text) => { clipboard.writeText(String(text)); return true; });
ipcMain.handle('open', (_e, url) => openExternal(url));
ipcMain.handle('open-note', (_e, rel) => {
  const cfg = readConfig();
  if (!cfg.vaultPath) return;
  const vaultName = path.basename(cfg.vaultPath);
  shell.openExternal(`obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(rel.replace(/\.md$/, ''))}`);
});
ipcMain.handle('reveal-extension', () => shell.openPath(path.join(__dirname, 'extension')));
ipcMain.handle('login-item', (_e, on) => { app.setLoginItemSettings({ openAtLogin: !!on }); return app.getLoginItemSettings().openAtLogin; });
ipcMain.handle('git-status', () => (gitQueue ? gitQueue.status : null));

app.setName('Brain Desk');
// Test hooks: run against a scratch profile/vault and capture screenshots.
if (process.env.BRAIN_DESK_USERDATA) app.setPath('userData', process.env.BRAIN_DESK_USERDATA);
async function shotMode() {
  const dir = process.env.BRAIN_DESK_SHOTS;
  if (!dir) return;
  win.webContents.once('did-finish-load', async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    await wait(1200);
    const steps = JSON.parse(process.env.BRAIN_DESK_STEPS || '[["today",""]]');
    for (const [name, js] of steps) {
      if (js) await win.webContents.executeJavaScript(js).catch(e => console.error('step', name, e.message));
      await wait(700);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
    }
    app.exit(0);
  });
}
app.whenReady().then(async () => {
  server.start(() => actions, { log: (...a) => console.error(...a) });
  if (process.env.BRAIN_DESK_SHOTS && process.env.BRAIN_DESK_VAULT) await connect(process.env.BRAIN_DESK_VAULT);
  createWindow();
  shotMode().catch(e => { console.error(e); app.exit(1); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
// Stay running with the window closed so the Chrome button keeps working.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', async () => { if (gitQueue) await gitQueue.flush(); });
