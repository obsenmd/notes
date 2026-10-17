const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
module.exports = (electron, directory) => {
  const root = fs.realpathSync(directory);
  if (path.dirname(root).toLowerCase() !== fs.realpathSync(os.tmpdir()).toLowerCase() || !/^obsen-(?:electron-smoke|reference-audit)-/.test(path.basename(root))) throw new Error('Deep-link emitter requires a guarded TEMP fixture');
  electron.ipcMain.handle('dev:fixture-open-url', (_event, uri) => {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'obsidian:' || parsed.searchParams.has('clipboard')) throw new Error('Only clipboard-free Obsidian fixture requests are permitted');
    return electron.app.emit('open-url', {preventDefault() {}}, uri);
  });
};
