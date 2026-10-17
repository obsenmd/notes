// Local-only diagnostics for isolated audit processes; never uploads crash reports.
const fs = require('node:fs');
const path = require('node:path');
module.exports = function installFixtureCrashDiagnostics(electron, directory) {
  const { app, crashReporter } = electron;
  const dumps = path.join(directory, 'crashes');
  fs.mkdirSync(dumps, { recursive: true });
  app.setPath('crashDumps', dumps);
  crashReporter.start({ uploadToServer: false });
  const record = (event, details = {}) => {
    fs.appendFileSync(path.join(directory, 'crash-events.jsonl'), JSON.stringify({
      time: new Date().toISOString(), pid: process.pid, event, ...details,
    }) + '\n');
  };
  record('diagnostics-installed', { electron: process.versions.electron, chrome: process.versions.chrome });
  app.on('child-process-gone', (_event, details) => record('child-process-gone', details));
  app.on('web-contents-created', (_event, contents) => {
    const id = contents.id;
    contents.on('render-process-gone', (_event, details) => record('render-process-gone', { id, ...details }));
    contents.on('unresponsive', () => record('unresponsive', { id }));
  });
  app.on('will-quit', () => record('will-quit'));
};
