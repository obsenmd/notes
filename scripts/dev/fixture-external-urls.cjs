// Native fallback recorder for isolated fixtures; never opens an OS browser.
module.exports = function install(shadow, electron) {
  const urls = [], opens = [];
  const shell = Object.create(electron.shell);
  shell.openExternal = async url => { urls.push(url); };
  Object.defineProperty(shadow, 'shell', { value: shell });
  electron.ipcMain.handle('fixture:external-urls', (_event, clear) => { const copy = urls.slice(); if (clear) urls.length = 0; return copy; });
  electron.ipcMain.handle('fixture:record-external-url', (_event, url) => { if (typeof url !== 'string') return false; urls.push(url); return true; });
  electron.ipcMain.handle('fixture:window-opens', (_event, clear) => { const copy = opens.slice(); if (clear) opens.length = 0; return copy; });
  electron.app.on('web-contents-created', (_event, contents) => {
    const set = contents.setWindowOpenHandler.bind(contents);
    contents.setWindowOpenHandler = handler => set(details => { opens.push({ url: details.url, frameName: details.frameName, disposition: details.disposition }); return handler(details); });
  });
};
