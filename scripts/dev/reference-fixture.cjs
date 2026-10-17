// Run installed Obsidian against an isolated profile/vault, with offscreen windows.
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const electron = require('electron');
const { app, BrowserWindow } = electron;
const directory = process.env.OBSEN_REFERENCE_FIXTURE;
if (!directory || !path.isAbsolute(directory)) throw new Error('An absolute fixture directory is required.');
require('./fixture-crash-diagnostics.cjs')(electron, directory);
require('./fixture-deep-links.cjs')(electron, directory);
const profile = path.join(directory, 'profile'), vault = path.join(directory, 'vault');
app.setPath('userData', profile);
app.name = 'Obsidian';
electron.protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }]);
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// Use the same text rasterization mode in both offscreen comparison processes.
app.commandLine.appendSwitch('disable-lcd-text');
app.commandLine.appendSwitch('remote-debugging-port', process.env.OBSEN_REFERENCE_PORT || '9351');
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'obsidian.json'), JSON.stringify({ language: 'en', updateDisabled: true, vaults: { 'obsen-audit': { path: vault, ts: Date.now(), open: true } } }));
const shadow = Object.create(electron);
require('./fixture-external-urls.cjs')(shadow, electron);
const nativeOs = require('node:os'), fixtureOs = Object.create(nativeOs);
fixtureOs.userInfo = (...args) => ({ ...nativeOs.userInfo(...args), username: `obsen-reference-${process.pid}` });
Object.defineProperty(shadow, 'BrowserWindow', { value: class BrowserWindow extends electron.BrowserWindow {
  constructor(options) { super({ ...options, width: 1280, height: 900, show: false, focusable: false, webPreferences: { ...options.webPreferences, offscreen: true } }); }
} });
const Module = require('node:module'), load = Module._load;
Module._load = function(id, ...args) { return id === 'electron' ? shadow : id === 'os' ? fixtureOs : load.call(this, id, ...args); };
const remoteMain = require('@electron/remote/main');
remoteMain.initialize();
electron.dialog.showErrorBox = (title, detail) => { console.error(title, detail); app.exit(1); };
app.on('browser-window-created', (_event, window) => {
  remoteMain.enable(window.webContents);
  window.show = window.showInactive = window.focus = () => {};
  window.webContents.setBackgroundThrottling(false);
  if (window.webContents.isOffscreen()) {
    window.webContents.on('paint', () => {});
    window.webContents.setFrameRate(60);
    window.webContents.startPainting();
  }
  window.webContents.on('did-finish-load', async () => {
    console.log('Reference window loaded:', window.id);
    const changed = await window.webContents.executeJavaScript(`(() => { if (localStorage.getItem('language') === 'en') return false; localStorage.setItem('language', 'en'); return true; })()`);
    if (changed) window.webContents.reload();
  });
});
process.argv = [process.argv[0], __filename];
require('C:/Program Files/Obsidian/resources/obsidian.asar/main.js')('C:/Program Files/Obsidian/resources/obsidian.asar', new EventEmitter());
setTimeout(async () => {
  try {
    const window = BrowserWindow.getAllWindows()[0];
    const result = await window.webContents.executeJavaScript(`({ ready: Boolean(window.app?.workspace?.layoutReady), appVersion: typeof app !== 'undefined' ? app.appId : null })`);
    console.log('Reference fixture state:', JSON.stringify(result));
    fs.writeFileSync(path.join(directory, 'ready.json'), JSON.stringify(result));
  } catch (error) { console.error(error.message); }
}, 8000);
