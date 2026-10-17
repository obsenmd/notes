// Compare the eight sidebar plugins (file explorer, search, bookmarks, backlinks, outgoing links, tags, outline,
// properties) in the two running offscreen fixture vaults. See scripts/dev/README.md for how they are started.
// Usage: node scripts/dev/sidebar-audit.mjs [output dir] [--ref=9352] [--obsen=9342] [--only=explorer,search,...] [--setup-only]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixtureClient, delay } from './fixture-client.mjs';

const flags = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const output = process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'dist/todo-backup/sidebar-comparison';
const refPort = Number(flags.ref ?? process.env.OBSEN_REFERENCE_PORT ?? 9352), ownPort = Number(flags.obsen ?? process.env.OBSEN_SMOKE_PORT ?? 9342);
const only = typeof flags.only === 'string' ? flags.only.split(',') : null;
const apps = typeof flags.apps === 'string' ? flags.apps.split(',') : ['reference', 'obsen'];
await fs.mkdir(output, { recursive: true });

// 1x1 PNG used as the attachment.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const FOLDERS = ['Projects', 'Projects/Archive', 'Areas', 'Areas/Deep', 'Areas/Deep/Deeper', 'Attachments', 'Empty'];
// Created in this order with a pause between them, so the time-based sort orders are the same in both vaults.
const NOTES = [
  ['Projects/Alpha.md', '---\naliases:\n  - Alpha Project\n  - AP\ntags:\n  - project/active\nstatus: draft\npriority: 2\ndue: 2026-01-15\ndone: false\n---\n# Alpha\n\nIntro paragraph linking [[Beta]] and [[Gamma#Details]] and [[Missing note]].\n\n## Goals\n\n- [ ] Ship the plan #area/work\n- [x] Draft the outline\n- A plain item mentioning Delta and Zeta.\n\n### Sub goal\n\nNested text with #idea and an embed ![[diagram.png]].\n\n## Notes\n\nGamma is mentioned here without a link. Beta again: [[Beta|the beta note]].\n'],
  ['Projects/Beta.md', '---\ntags:\n  - project/active\n  - review\nstatus: final\npriority: 5\n---\n# Beta\n\nSee [[Alpha]] for the plan.\n\nAlpha is mentioned here in plain text, and so is Alpha Project.\n\n- A list item about alpha in lower case\n  - nested child line\n- Another item\n\nThe needle sits on this line.\nSecond needle line with Needle capitalised.\n'],
  ['Projects/Archive/Gamma.md', '---\ntags: [project/done]\nstatus: final\n---\n# Gamma\n\n## Details\n\nA block to reference. ^blk\n\nBeta is mentioned without a link. Links to [[Alpha]].\n\n## Other\n\n#idea #area/home\n'],
  ['Areas/Delta.md', '# Delta\n\nAlpha comes first.\n\nThen alpha appears again in this paragraph, with [[Alpha|the alpha]] linked once.\n\n- [ ] Call Alpha about the needle\n- [x] Done task\n\n[[Projects/Archive/Gamma#^blk]]\n'],
  ['Areas/Deep/Deeper/Epsilon.md', '---\nstatus: draft\ncssclasses: wide\n---\n# Epsilon\n\nDeep note. [[Zeta]]\n'],
  ['Zeta.md', '# Zeta\n\nNo properties here. needle\n'],
  ['Outline.md', '# One\n\ntext one\n\n## One A\n\ntext a\n\n### One A i\n\ntext i\n\n#### One A i deep\n\ntext deep\n\n## One B\n\ntext b\n\n# Two\n\ntext two\n\n## Two A with **bold** and [[Alpha|link]]\n\ntext\n\n# Three\n\nend\n'],
];
const SAMPLE_ROOTS = new Set(['Projects', 'Areas', 'Attachments', 'Empty', 'Zeta.md', 'Outline.md']);
const PLUGINS = ['file-explorer', 'global-search', 'bookmarks', 'backlink', 'outgoing-link', 'tag-pane', 'outline', 'properties'];

const report = {}, failures = [];
const clients = [];
if (apps.includes('reference')) clients.push(['reference', await fixtureClient(refPort, 'obsen-reference-audit-', { separateHistoricalErrors: true })]);
if (apps.includes('obsen')) clients.push(['obsen', await fixtureClient(ownPort, 'obsen-electron-smoke-', { separateHistoricalErrors: true })]);
const warm = c => Promise.race([c.send('Page.captureScreenshot', { format: 'png' }).catch(() => undefined), delay(3000)]);
const J = JSON.stringify;

/** Per-app driver: thin helpers over the fixture client that address elements by an expression. */
function driver(name, c) {
  const R = report[name] = { historicalErrors: c.historicalErrors };
  const ev = expression => c.evaluate(expression);
  const pointOf = async target => {
    const p = await ev(`(() => { const e=${target}; if (!e) return null; e.scrollIntoView?.({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
    if (!p) throw new Error(`Missing element: ${target}`);
    return p;
  };
  const mouse = (type, p, extra = {}) => c.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...extra });
  const hover = async target => { const p = await pointOf(target); await mouse('mouseMoved', p); return p; };
  /** A real click. `modifiers`: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
  const click = async (target, modifiers = 0) => { const p = await hover(target); await mouse('mousePressed', p, { button: 'left', clickCount: 1, modifiers }); await mouse('mouseReleased', p, { button: 'left', clickCount: 1, modifiers }); await delay(60); };
  const clickAt = async (p, modifiers = 0) => { await mouse('mouseMoved', p); await mouse('mousePressed', p, { button: 'left', clickCount: 1, modifiers }); await mouse('mouseReleased', p, { button: 'left', clickCount: 1, modifiers }); await delay(60); };
  const rclickAt = async p => { await mouse('mouseMoved', p); await mouse('mousePressed', p, { button: 'right', clickCount: 1 }); await mouse('mouseReleased', p, { button: 'right', clickCount: 1 }); await delay(150); };
  const rclick = async target => rclickAt(await pointOf(target));
  const q = selector => `document.querySelector(${J(selector)})`;
  /** First element matching `selector` whose trimmed text equals `text`. */
  const withText = (selector, text) => `[...document.querySelectorAll(${J(selector)})].find(e=>e.textContent.trim()===${J(text)})`;
  const wait = (expression, label) => c.wait(expression, `${name}: ${label}`);
  const type = text => c.send('Input.insertText', { text });
  const escape = async () => { await c.key('Escape'); await delay(80); };
  const closeMenus = async () => { for (let i = 0; i < 4 && await ev(`!!document.querySelector('.menu, .suggestion-container, .modal-container')`); i++) await escape(); };
  const snap = async (scenario, selector) => { R.captures ??= {}; R.captures[scenario] = await c.capture(output, `${name}-${scenario}`, selector); };
  /** Menu titles (with checked/disabled/warning state and separators) of the topmost menu. */
  const menuItems = () => ev(`(() => { const m=[...document.querySelectorAll('.menu')].at(-1); if (!m) return null; return [...m.querySelectorAll('.menu-item, .menu-separator')].map(e=>e.classList.contains('menu-separator')?'---':(e.querySelector('.menu-item-title')?.textContent??'')+(e.classList.contains('is-disabled')?' [disabled]':'')+(e.classList.contains('is-warning')?' [warning]':'')+(e.querySelector('.menu-item-icon.mod-checked, .mod-checked')?' [checked]':'')+(e.classList.contains('has-submenu')||e.querySelector('.mod-submenu')?' [submenu]':'')); })()`);
  const menuClick = title => click(withText('.menu:last-of-type .menu-item .menu-item-title, .menu .menu-item .menu-item-title', title) + `?.closest('.menu-item')`);
  const command = id => ev(`app.commands.executeCommandById(${J(id)})`);
  const record = (key, value) => { R[key] = value; return value; };
  const read = file => ev(`app.vault.adapter.read(${J(file)})`);
  return { name, c, R, ev, pointOf, mouse, hover, click, clickAt, rclick, rclickAt, q, withText, wait, type, escape, closeMenus, snap, menuItems, menuClick, command, record, read, key: c.key };
}

/** Brings both vaults to the same content: only the sample files, written in a fixed order. */
async function setup(d) {
  const { c, ev, name } = d;
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await d.closeMenus();
  await ev(`(async () => {
    const ids=${J(PLUGINS)};
    if (app.internalPlugins) { for (const id of ids) await app.internalPlugins.plugins[id].enable(false); }
    else { let data={}; try { data=JSON.parse(await app.vault.adapter.read('.obsidian/core-plugins.json')); } catch {} let changed=false; for (const id of ids) if (data[id]!==true) { data[id]=true; changed=true; } if (changed) await app.vault.adapter.write('.obsidian/core-plugins.json',JSON.stringify(data)); }
    const roots=[]; app.workspace.iterateRootLeaves(leaf=>{roots.push(leaf);});
    for (const leaf of roots) await leaf.setViewState({type:'empty',state:{}});
    // File-properties is created on demand. Remove its old file binding before
    // deleting a previous run's notes, just as in a fresh fixture.
    for (const leaf of app.workspace.getLeavesOfType('file-properties')) leaf.detach();
    for (const child of [...app.vault.getRoot().children]) await app.vault.delete(child, true);
    for (const f of ['.obsidian/bookmarks.json','.obsidian/types.json']) if (await app.vault.adapter.exists(f)) await app.vault.adapter.remove(f);
    const pause=ms=>new Promise(r=>setTimeout(r,ms));
    for (const folder of ${J(FOLDERS)}) await app.vault.createFolder(folder);
    for (const [p,text] of ${J(NOTES)}) { await app.vault.create(p,text); await pause(1100); }
    const bytes=Uint8Array.from(atob(${J(PNG)}),ch=>ch.charCodeAt(0));
    await app.vault.createBinary('Attachments/diagram.png',bytes.buffer); await pause(50);
    await app.vault.create('Attachments/raw.xyz','unsupported'); await pause(50);
    await app.vault.create('Attachments/Sketch.canvas','{"nodes":[{"id":"n1","type":"text","text":"Canvas needle card","x":0,"y":0,"width":250,"height":60}],"edges":[]}');
  })()`);
  // Local fold/recent state is per app id; clear the keys both apps use so each run starts from the same state.
  await ev(`(() => { for (const key of ['file-explorer-unfold','tag-pane-fold','bookmarks-folds','recent-searches']) app.saveLocalStorage(key, null); })()`);
  await c.send('Page.reload');
  await c.wait(name === 'obsen' ? `!!window.__obsenSmokeApp?.workspace?.layoutReady` : `!!window.app?.workspace?.layoutReady`, `${name}: reload after setup`);
  await delay(1500);
  await warm(c);
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // Same workspace in both: one tab with Alpha in source-free live preview, both sidebars open at their default tabs.
  await ev(`(async()=>{
    const states={
      search:{query:'',matchingCase:false,explainSearch:false,collapseAll:false,extraContext:false,sortOrder:'alphabetical'},
      backlink:{file:'Projects/Alpha.md',collapseAll:false,extraContext:false,sortOrder:'alphabetical',showSearch:false,searchQuery:'',backlinkCollapsed:false,unlinkedCollapsed:true},
      'outgoing-link':{file:'Projects/Alpha.md',linksCollapsed:false,unlinkedCollapsed:true},
      tag:{sortOrder:'frequency',useHierarchy:true,showSearch:false,searchQuery:''},
      outline:{file:'Projects/Alpha.md',followCursor:false,showSearch:false,searchQuery:''},
      'all-properties':{sortOrder:'frequency',showSearch:false,searchQuery:''},
    };
    // Lifecycle audits deliberately close popout panes while leaving plugins
    // enabled. Recreate missing audit panes instead of depending on enablement
    // to reopen them (the reference's internal enable call does so).
    for(const [type,state] of Object.entries(states)){
      const leaf=app.workspace.getLeavesOfType(type)[0] ?? app.workspace.createDockLeaf?.(['file-explorer','search','bookmarks'].includes(type)?'left':'right');
      if(!leaf)throw new Error('Unable to create audit pane '+type);
      await leaf.setViewState({type,state});
    }
  })()`);
  await ev(`(async () => {
    const root=[]; app.workspace.iterateRootLeaves(l=>{root.push(l);}); for (const l of root.slice(1)) l.detach();
    // Opening a file preserves an existing pane's reading/source mode. Set the
    // audit's live-preview mode explicitly instead of inheriting prior tests.
    const documentLeaf=app.workspace.getLeaf(false);
    await documentLeaf.setViewState({type:'markdown',state:{file:'Projects/Alpha.md',mode:'source',source:false}});
    app.workspace.setActiveLeaf(documentLeaf);
    app.workspace.leftSplit.expand(); app.workspace.rightSplit.expand();
  })()`);
  await d.wait(`!!document.querySelector('.workspace-leaf-content[data-type="markdown"] .cm-content')`, 'editor mounted');
  await d.wait(`!!app.metadataCache.resolvedLinks["Projects/Alpha.md"]?.["Projects/Beta.md"] && !!app.metadataCache.resolvedLinks["Areas/Delta.md"]`, 'metadata resolved');
  await delay(600);
}

/** Reveals a sidebar view and returns once its container is visible. */
async function show(d, type) {
  await d.ev(`(async () => { const leaf=app.workspace.getLeavesOfType(${J(type)})[0]; if (!leaf) throw new Error('No leaf of type ${type}'); await app.workspace.revealLeaf(leaf); })()`);
  await d.wait(`!!document.querySelector('.workspace-leaf-content[data-type=${J(type)}]')?.offsetParent`, `${type} visible`);
  await delay(250);
}
const LEAF = type => `.workspace-leaf-content[data-type="${type}"]`;

const sections = {};

sections.explorer = async d => {
  await show(d, 'file-explorer');
  await d.snap('explorer-collapsed', LEAF('file-explorer'));
  for (const folder of ['Projects','Projects/Archive','Attachments']) {
    const selector = `${LEAF('file-explorer')} .nav-folder-title[data-path=${J(folder)}] .collapse-icon`;
    await d.click(d.q(selector));
  }
  await delay(150);
  d.record('explorerRows',await d.ev(`([...document.querySelectorAll('${LEAF('file-explorer')} .tree-item-self[data-path]')].filter(e=>e.offsetParent).map(e=>({path:e.dataset.path,text:e.querySelector('.nav-file-title-content,.nav-folder-title-content')?.textContent})))`));
  await d.snap('explorer-expanded', LEAF('file-explorer'));
  await d.click(d.q(`${LEAF('file-explorer')} [aria-label="Change sort order"]`));
  d.record('explorerSort',await d.menuItems());
  await d.snap('explorer-sort','.menu');
  await d.escape();
  await d.rclick(d.q(`${LEAF('file-explorer')} .nav-file-title[data-path="Projects/Alpha.md"]`));
  d.record('explorerFileMenu',await d.menuItems());
  await d.snap('explorer-file-menu','.menu');
  await d.escape();
  await d.click(d.q(`${LEAF('file-explorer')} .nav-file-title[data-path="Attachments/diagram.png"]`));
  await d.wait(`app.workspace.getActiveFile()?.path==='Attachments/diagram.png' && !!document.querySelector('.workspace-leaf-content[data-type=image] img')`,'native image view');
  d.record('imageView',await d.ev(`({type:app.workspace.activeLeaf.view.getViewType(),icon:app.workspace.activeLeaf.view.getIcon(),state:app.workspace.activeLeaf.view.getState()})`));
  await d.snap('image-view','.workspace-leaf-content[data-type=image] .view-content');
  await d.ev(`app.workspace.getLeaf(false).openFile(app.vault.getFileByPath('Projects/Alpha.md'))`);
};

sections.search = async d => {
  await show(d,'search');
  const input=`${LEAF('search')} input[type=search]`;
  const query=async text=>{await d.click(d.q(input));await d.ev(`(() => { const e=document.querySelector(${J(input)}); e.focus(); e.select(); })()`);await d.type(text);await d.wait(`app.workspace.getLeavesOfType('search')[0].view.getState().query===${J(text)}`,'query persisted');await delay(650);await d.ev(`document.querySelector(${J(input)}).blur()`);await delay(100);};
  const rows=()=>d.ev(`([...document.querySelectorAll('${LEAF('search')} .search-result-file-title')].map(e=>e.querySelector('.search-result-file-title-text,.tree-item-inner')?.textContent??e.textContent))`);
  await query('needle');
  await d.wait(`document.querySelectorAll('${LEAF('search')} .search-result-file-match').length>=4`,'needle results');
  d.record('searchNeedle',await rows());
  await d.snap('search-needle',LEAF('search'));
  await d.click(d.q(`${LEAF('search')} .search-results-result-count`));
  d.record('searchResultsMenu',await d.menuItems());
  await d.snap('search-results-menu','.menu');
  await d.escape();
  await query('[status: draft]');
  d.record('searchProperty',await rows());
  await d.snap('search-property',LEAF('search'));
  await query('path:Projects needle');
  d.record('searchPath',await rows());
  await d.snap('search-path',LEAF('search'));
  await query('tag:#project/active');
  d.record('searchTag',await rows());
  await d.snap('search-tag',LEAF('search'));
  await query('obsen-no-such-text');
  await d.snap('search-empty',LEAF('search'));
};

sections.bookmarks = async d => {
  await show(d,'bookmarks');
  await d.snap('bookmarks-empty',LEAF('bookmarks'));
  d.record('bookmarkActions',await d.ev(`([...document.querySelectorAll('${LEAF('bookmarks')} .nav-action-button')].map(e=>e.getAttribute('aria-label')))`));
  const items=[
    {type:'file',ctime:1,path:'Projects/Alpha.md'},
    {type:'group',ctime:2,title:'Resources',items:[
      {type:'file',ctime:3,path:'Projects/Archive/Gamma.md',subpath:'#Details'},
      {type:'search',ctime:4,query:'needle'},
      {type:'folder',ctime:5,path:'Projects/Archive'},
    ]},
    {type:'file',ctime:6,path:'Attachments/Sketch.canvas'},
    {type:'graph',ctime:7,title:'Project graph',options:{search:'path:Projects',showTags:true}},
    {type:'url',ctime:8,title:'Reference site',url:'https://example.org/'},
    {type:'file',ctime:9,path:'Missing.md'},
  ];
  await d.ev(`app.vault.adapter.write('.obsidian/bookmarks.json',${J(JSON.stringify({items}))})`);
  await d.ev(`app.saveLocalStorage('bookmarks-folds',null)`);
  await d.c.send('Page.reload');
  await d.wait(`!!window.app?.workspace?.layoutReady`,'bookmark fixture reloaded');
  await warm(d.c); await d.c.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await show(d,'bookmarks');
  await d.wait(`document.querySelectorAll('${LEAF('bookmarks')} .bookmark').length>=8`,'populated bookmarks');
  await delay(250);
  const row=text=>d.withText(`${LEAF('bookmarks')} .tree-item-inner-text`,text)+`?.closest('.bookmark')`;
  const rows=()=>d.ev(`([...document.querySelectorAll('${LEAF('bookmarks')} .bookmark')].filter(e=>e.offsetParent).map(e=>({text:e.querySelector('.tree-item-inner')?.textContent,icon:e.querySelector('svg')?.getAttribute('class')})))`);
  d.record('bookmarkActiveContext',await d.ev(`({activeFile:app.workspace.getActiveFile()?.path??null,activeType:app.workspace.activeLeaf?.view.getViewType(),recentFile:app.workspace.getMostRecentLeaf()?.view.file?.path??null})`));
  d.record('bookmarkRows',await rows()); await d.snap('bookmarks-populated',LEAF('bookmarks'));
  await d.rclick(row('Resources'));
  d.record('bookmarkGroupMenu',await d.menuItems()); await d.snap('bookmarks-group-menu','.menu'); await d.escape();
  await d.rclick(row('Gamma#Details'));
  d.record('bookmarkFileMenu',await d.menuItems()); await d.snap('bookmarks-file-menu','.menu'); await d.escape();
  await d.rclick(row('Reference site'));
  d.record('bookmarkUrlMenu',await d.menuItems()); await d.snap('bookmarks-url-menu','.menu'); await d.escape();
  await d.rclick(row('Resources')); await d.menuClick('Rename');
  await d.wait(`!!document.querySelector('${LEAF('bookmarks')} [contenteditable=true]')`,'bookmark inline rename');
  await d.snap('bookmarks-rename',LEAF('bookmarks')); await d.type('Reference links'); await d.key('Enter');
  await d.wait(`!!${row('Reference links')}`,'bookmark renamed');
  await d.click(d.q(`${LEAF('bookmarks')} [aria-label="New group"]`));
  await d.wait(`!!document.querySelector('${LEAF('bookmarks')} [contenteditable=true]')`,'new bookmark group');
  await delay(150); await d.ev(`(() => { const e=document.querySelector('${LEAF('bookmarks')} [contenteditable=true]'); e.focus(); e.ownerDocument.getSelection().selectAllChildren(e); })()`);
  await d.type('Quick links'); await d.key('Enter');
  await d.wait(`!!${row('Quick links')}`,'new group committed');
  await d.ev(`app.workspace.getLeaf(false).openFile(app.vault.getFileByPath('Projects/Beta.md'))`);
  await delay(200);
  await d.click(d.q(`${LEAF('bookmarks')} [aria-label="Bookmark the active tab..."]`));
  await d.wait(`!!document.querySelector('.modal.mod-bookmark')`,'add bookmark dialog');
  await d.snap('bookmarks-add','.modal');
  await d.type('Beta shortcut'); await d.click(d.withText('.modal button','Save'));
  await d.wait(`!!${row('Beta shortcut')}`,'bookmark saved');
  await d.rclick(row('Beta shortcut')); await d.menuClick('Edit...');
  await d.wait(`!!document.querySelector('.modal.mod-bookmark')`,'edit bookmark dialog');
  await d.snap('bookmarks-edit','.modal');
  await d.type('Beta edited'); await d.click(d.withText('.modal button','Save'));
  await d.wait(`!!${row('Beta edited')}`,'bookmark edited');
  await d.click(row('Gamma#Details')); await d.wait(`app.workspace.getActiveFile()?.path==='Projects/Archive/Gamma.md'`,'heading bookmark opened');
  d.record('bookmarkHeadingState',await d.ev(`(() => { const {file,mode,source}=app.workspace.activeLeaf.view.getState(); return {file,mode,source}; })()`));
  await show(d,'bookmarks'); await d.click(row('needle'));
  await d.wait(`app.workspace.getLeavesOfType('search')[0].view.getState().query==='needle'`,'search bookmark opened');
  d.record('bookmarkSearch','needle');
  await show(d,'bookmarks'); await d.rclick(row('Beta edited')); await d.menuClick('Remove');
  await d.wait(`!${row('Beta edited')}`,'bookmark removed');
  await delay(350);
  d.record('bookmarkStored',await d.ev(`(async()=>{const data=JSON.parse(await app.vault.adapter.read('.obsidian/bookmarks.json'));const clean=items=>items.map(({ctime,...item})=>({...item,...(item.items?{items:clean(item.items)}:{})}));return clean(data.items)})()`));
  await d.click(row('Project graph'));
  await d.wait(`app.workspace.activeLeaf?.view.getViewType()==='graph'`,'graph bookmark opened');
  await d.wait(`!!document.querySelector('.graph-controls .mod-filter')`,'graph bookmark controls');
  if(await d.ev(`document.querySelector('.graph-controls').classList.contains('is-close')`))await d.click(d.q('.graph-controls-button.mod-open'));
  if(await d.ev(`document.querySelector('.graph-controls .mod-filter').classList.contains('is-collapsed')`))await d.click(d.q('.graph-controls .mod-filter > :first-child'));
  await d.wait(`!!document.querySelector('.graph-controls .mod-filter input:not([type=checkbox])')`,'graph bookmark filter');
  d.record('bookmarkGraphOptions',await d.ev(`(() => { const row=[...document.querySelectorAll('.graph-controls .setting-item')].find(e=>e.querySelector('.setting-item-name')?.textContent==='Tags'); return {search:document.querySelector('.graph-controls .mod-filter input:not([type=checkbox])').value,showTags:row?.querySelector('.checkbox-container')?.classList.contains('is-enabled')}; })()`));
  await d.ev(`app.workspace.activeLeaf.setViewState({type:'markdown',state:{file:'Projects/Alpha.md'}})`);
};

const openAlpha=async d=>{await d.ev(`app.workspace.getLeaf(false).openFile(app.vault.getFileByPath('Projects/Alpha.md'))`);await delay(350);};
sections.backlinks = async d => {
  await openAlpha(d); await show(d,'backlink');
  await d.wait(`document.querySelectorAll('${LEAF('backlink')} .search-result-file-title').length===4`,'linked mentions');
  await d.snap('backlinks-linked',LEAF('backlink'));
  await d.click(d.withText(`${LEAF('backlink')} .tree-item-inner`,'Unlinked mentions')+`?.closest('.tree-item-self')`);
  await delay(500);
  await d.snap('backlinks-unlinked',LEAF('backlink'));
  await d.click(d.q(`${LEAF('backlink')} [aria-label="Show search filter"]`));
  await d.type('path:Beta');
  await delay(500);
  await d.snap('backlinks-filter',LEAF('backlink'));
};

sections.outgoing = async d => {
  await openAlpha(d); await show(d,'outgoing-link');
  await delay(300);
  await d.snap('outgoing-linked',LEAF('outgoing-link'));
  d.record('outgoingRows',await d.ev(`([...document.querySelectorAll('${LEAF('outgoing-link')} .outgoing-link-item')].map(e=>({text:e.querySelector('.tree-item-inner')?.textContent,path:e.getAttribute('data-path'),tooltip:e.getAttribute('aria-label')})))`));
  const unlinked=d.withText(`${LEAF('outgoing-link')} .tree-item-inner`,'Unlinked mentions');
  await d.click(unlinked+`?.closest('.tree-item-self')`);
  await delay(500);
  await d.snap('outgoing-unlinked',LEAF('outgoing-link'));
};

sections.tags = async d => {
  await show(d,'tag'); await delay(300);
  await d.snap('tags-hierarchy',LEAF('tag'));
  d.record('tags',await d.ev(`([...document.querySelectorAll('${LEAF('tag')} .tag-pane-tag')].map(e=>({text:e.querySelector('.tree-item-inner')?.textContent,count:e.querySelector('.tag-pane-tag-count')?.textContent})))`));
  await d.click(d.q(`${LEAF('tag')} [aria-label="Show nested tags"]`));
  await delay(150); await d.snap('tags-flat',LEAF('tag'));
  await d.click(d.q(`${LEAF('tag')} [aria-label="Change sort order"]`));
  d.record('tagSort',await d.menuItems()); await d.snap('tags-sort','.menu'); await d.escape();
};

sections.outline = async d => {
  await d.ev(`app.workspace.getLeaf(false).openFile(app.vault.getFileByPath('Outline.md'))`);
  await show(d,'outline'); await delay(300);
  const collapse=d.q(`${LEAF('outline')} .nav-action-button[aria-label="Collapse all"]`), expand=d.q(`${LEAF('outline')} .nav-action-button[aria-label="Expand all"]`);
  if(await d.ev(`!!${collapse}`)) await d.click(collapse);
  if(await d.ev(`!!${expand}`)) await d.click(expand);
  await d.wait(`document.querySelectorAll('${LEAF('outline')} .tree-item-inner').length>=8`,'all outline headings');
  await d.snap('outline',LEAF('outline'));
  d.record('outlineRows',await d.ev(`([...document.querySelectorAll('${LEAF('outline')} .tree-item-inner')].map(e=>e.textContent))`));
  await d.click(d.q(`${LEAF('outline')} .nav-action-button[aria-label="Collapse all"]`));
  await delay(150); await d.snap('outline-collapsed',LEAF('outline'));
};

sections.properties = async d => {
  await show(d,'all-properties'); await delay(350);
  await d.snap('properties-all',LEAF('all-properties'));
  d.record('propertyRows',await d.ev(`([...document.querySelectorAll('${LEAF('all-properties')} .tree-item-self')].map(e=>e.textContent.trim()))`));
  await d.click(d.q(`${LEAF('all-properties')} [aria-label="Change sort order"]`));
  d.record('propertySort',await d.menuItems()); await d.snap('properties-sort','.menu'); await d.escape();
  const row=name=>d.withText(`${LEAF('all-properties')} .tree-item-inner-text`,name)+`?.closest('.tree-item-self')`;
  await d.rclick(row('status'));
  d.record('propertyMenu',await d.menuItems()); await d.snap('properties-menu','.menu');
  await d.hover(d.withText('.menu-item-title','Property type')+`?.closest('.menu-item')`);
  await d.wait(`document.querySelectorAll('.menu').length===2`,'property type submenu');
  await delay(300); d.record('propertyTypeMenu',await d.menuItems()); await d.ev(`[...document.querySelectorAll('.menu')].at(-1).setAttribute('data-audit-submenu','true')`); await d.snap('properties-type-menu','[data-audit-submenu]');
  await d.menuClick('Text');
  await d.wait(`(async()=>{try{return JSON.parse(await app.vault.adapter.read('.obsidian/types.json')).types.status==='text'}catch{return false}})()`,'property type persisted');
  d.record('propertyAssignedType','text');
  await d.rclick(row('status')); await d.menuClick('Rename');
  await d.wait(`!!document.querySelector('${LEAF('all-properties')} [contenteditable=true]')`,'property inline rename');
  await d.snap('properties-rename',LEAF('all-properties')); await d.type('stage'); await d.key('Enter');
  await d.wait(`!!${row('stage')} && !${row('status')}`,'property rename reflected');
  await d.wait(`(async()=>{const s=await app.vault.adapter.read('Projects/Alpha.md');return s.includes('stage: draft')&&!s.includes('status:')})()`,'property rename on disk');
  await delay(400);
  d.record('propertyRenamedValues',await d.ev(`(['Projects/Alpha.md','Projects/Beta.md','Projects/Archive/Gamma.md','Areas/Deep/Deeper/Epsilon.md'].map(path=>{const f=app.metadataCache.getCache(path)?.frontmatter;return {path,stage:f?.stage,status:f?.status,priority:f?.priority,tags:f?.tags}}))`));
  d.record('propertyRenamedType',await d.ev(`(async()=>{const types=JSON.parse(await app.vault.adapter.read('.obsidian/types.json')).types;return {stage:types.stage,status:types.status}})()`));
};

sections.propertyCrud = async d => {
  const notes=[['Property merge scalar.md','---\naudit_from: old\naudit_to: retained\n---\n# Scalar\n'],['Property merge list.md','---\naudit_from: [old, shared]\naudit_to: [new, shared]\n---\n# List\n'],['Property merge empty.md','---\naudit_from: fill\naudit_to: null\n---\n# Empty\n'],['Property merge list to scalar.md','---\naudit_from: [old, shared]\naudit_to: retained\n---\n# List to scalar\n'],['Property merge scalar to list.md','---\naudit_from: old\naudit_to: [new, shared]\n---\n# Scalar to list\n']];
  for(const [path,text] of notes)await d.ev(`(async()=>{const f=app.vault.getFileByPath(${J(path)});if(f)await app.vault.modify(f,${J(text)});else await app.vault.create(${J(path)},${J(text)});})()`);
  await d.ev(`app.workspace.rightSplit.expand()`);
  await show(d,'all-properties');
  const row=name=>d.withText(`${LEAF('all-properties')} .tree-item-inner-text`,name)+`?.closest('.tree-item-self')`;
  await d.wait(`!!${row('audit_from')} && !!${row('audit_to')}`,'merge properties indexed');
  await d.rclick(row('audit_from'));await d.menuClick('Rename');
  await d.wait(`!!document.querySelector('${LEAF('all-properties')} [contenteditable=true]')`,'merge rename editor');
  await delay(100);await d.ev(`(()=>{const e=document.querySelector('${LEAF('all-properties')} [contenteditable=true]');e.focus();e.ownerDocument.getSelection().selectAllChildren(e);})()`);
  await d.type('audit_to');await d.key('Enter');
  await d.wait(`!!document.querySelector('.modal')`,'merge confirmation');
  d.record('propertyMergeDialog',await d.ev(`document.querySelector('.modal').textContent`));
  await d.snap('properties-merge','.modal');
  await d.click(d.withText('.modal button','Save'));
  await d.wait(`!${row('audit_from')}`,'merge finished');await delay(400);
  d.record('propertyMergeValues',await d.ev(`(${J(notes.map(n=>n[0]))}.map(path=>({path,from:app.metadataCache.getCache(path)?.frontmatter?.audit_from,to:app.metadataCache.getCache(path)?.frontmatter?.audit_to})))`));
  await d.rclick(row('audit_to'));d.record('propertyDeleteMenu',await d.menuItems());await d.menuClick('Delete property');
  await delay(200);
  if(await d.ev(`!!document.querySelector('.modal')`)){d.record('propertyDeleteDialog',await d.ev(`document.querySelector('.modal').textContent`));await d.snap('properties-delete','.modal');await d.click(d.withText('.modal button','Delete'));}
  else d.record('propertyDeleteDialog',null);
  await d.wait(`!${row('audit_to')}`,'property deleted');await delay(300);
  d.record('propertyDeleteValues',await d.ev(`(${J(notes.map(n=>n[0]))}.map(path=>({path,keys:Object.keys(app.metadataCache.getCache(path)?.frontmatter??{}).filter(k=>k!=='position')})))`));
};

sections.propertyEdit = async d => {
  const path='Property values audit.md',text='---\naudit_text: original\naudit_number: 2\naudit_check: false\n---\n# Values\n';
  await d.ev(`(async()=>{let f=app.vault.getFileByPath(${J(path)});if(f)await app.vault.modify(f,${J(text)});else f=await app.vault.create(${J(path)},${J(text)});await app.workspace.getLeaf(false).openFile(f);app.workspace.rightSplit.expand();})()`);
  await d.command('properties:open-local');await show(d,'file-properties');
  const property=key=>`${LEAF('file-properties')} .metadata-property[data-property-key=${key}]`;
  await d.wait(`!!document.querySelector('${property('audit_text')} .metadata-property-value [contenteditable=true]')`,'property value inputs');
  for(const [key,value] of [['audit_text','Edited text'],['audit_number','17']]){
    const input=`${property(key)} .metadata-property-value ${key==='audit_text'?'[contenteditable=true]':'input'}`;
    await d.click(d.q(input));await d.ev(`(()=>{const e=document.querySelector(${J(input)});e.focus();if(e.select)e.select();else e.ownerDocument.getSelection().selectAllChildren(e);})()`);await d.type(value);await d.key('Tab','Tab',{windowsVirtualKeyCode:9});
    await d.wait(`app.metadataCache.getCache(${J(path)})?.frontmatter?.${key}===${key==='audit_number'?17:J(value)}`,'property edit persisted');
  }
  await d.click(d.q(`${property('audit_check')} input[type=checkbox]`));
  await d.wait(`app.metadataCache.getCache(${J(path)})?.frontmatter?.audit_check===true`,'checkbox property persisted');
  d.record('propertyEditedValues',await d.ev(`(()=>{const fm=app.metadataCache.getCache(${J(path)}).frontmatter;return {text:fm.audit_text,number:fm.audit_number,check:fm.audit_check};})()`));
  d.record('propertyEditedFocus',await d.ev(`(()=>{const e=document.activeElement;return{key:e?.closest('.metadata-property')?.getAttribute('data-property-key')??null,field:e?.className??null};})()`));
  await d.snap('properties-values-edited',LEAF('file-properties'));
  d.record('propertyEditedDisk',await d.read(path));
};

sections.canvasLinks = async d => {
  const path='Canvas-links-audit.canvas';
  const data={nodes:[{id:'text1',type:'text',text:'A canvas link to [[Projects/Alpha]]',x:0,y:0,width:300,height:100},{id:'file1',type:'file',file:'Projects/Alpha.md',x:350,y:0,width:300,height:100}],edges:[]};
  await d.ev(`(async()=>{await app.vault.create(${J(path)},${J(JSON.stringify(data))});return true})()`);
  await d.wait(`app.metadataCache.resolvedLinks[${J(path)}]?.['Projects/Alpha.md']===2`,'canvas text and file card resolved');
  d.record('canvasCache',await d.ev(`app.metadataCache.getCache(${J(path)})`));
  d.record('canvasResolved',await d.ev(`app.metadataCache.resolvedLinks[${J(path)}]`));
  await openAlpha(d);
  await d.ev(`app.workspace.getLeavesOfType('backlink')[0].setViewState({type:'backlink',state:{file:'Projects/Alpha.md',collapseAll:false,extraContext:false,showSearch:false,searchQuery:'',backlinkCollapsed:false,unlinkedCollapsed:true}})`);
  await show(d,'backlink');
  await d.wait(`([...document.querySelectorAll('${LEAF('backlink')} .search-result')].some(e=>e.querySelector('.tree-item-inner')?.textContent===${J(path)}&&e.querySelector('.search-result-file-match')))`,'canvas backlink excerpt');
  await d.snap('backlinks-canvas-text',LEAF('backlink'));
  data.nodes[0].text='Unlinked canvas card';
  await d.ev(`app.vault.modify(app.vault.getFileByPath(${J(path)}),${J(JSON.stringify(data))})`);
  await d.wait(`app.metadataCache.resolvedLinks[${J(path)}]?.['Projects/Alpha.md']===1`,'canvas edit reindexed');
  await delay(500); await d.snap('backlinks-canvas-file',LEAF('backlink'));
  d.record('canvasFileCardResolved',await d.ev(`app.metadataCache.resolvedLinks[${J(path)}]`));
  await d.ev(`app.vault.delete(app.vault.getFileByPath(${J(path)}),true)`);
  await d.wait(`!app.metadataCache.resolvedLinks[${J(path)}]`,'canvas deletion reindexed');
  d.record('canvasDeleted',true);
};

sections.queryEmbed = async d => {
  const path='Query audit.md',text='# Query audit\n\n```query\nneedle\n```\n\nA needle outside the query fence.\n';
  const embed='.markdown-reading-view .internal-query';
  await d.ev(`(async()=>{await app.vault.create(${J(path)},${J(text)});return true})()`);
  await d.ev(`app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(${J(path)}),{state:{mode:'preview'}})`);
  await d.wait(`document.querySelector(${J(embed)})?.offsetWidth>0 && document.querySelectorAll('${embed} .search-result-file-title').length>=5`,'embedded query results');
  await delay(300);
  d.record('queryEmbedRows',await d.ev(`([...document.querySelectorAll('${embed} .search-result-file-title .tree-item-inner')].map(e=>e.textContent))`));
  const result=title=>d.withText(`${embed} .search-result-file-title .tree-item-inner`,title)+`?.closest('.search-result')`;
  d.record('queryEmbedSelfMatches',await d.ev(`${result('Query audit')}.querySelectorAll('.search-result-file-matched-text').length`));
  await d.snap('query-embed',embed);
  await d.ev(`app.vault.modify(app.vault.getFileByPath('Zeta.md'),${J('# Zeta\n\nNo properties here. needle\n\nAnother needle.\n')})`);
  await d.wait(`${result('Zeta')}.querySelectorAll('.search-result-file-match').length===2`,'embedded query updated after edit');
  d.record('queryEmbedLiveMatches',2);
  await d.snap('query-embed-updated',embed);
};

sections.fileProperties = async d => {
  await openAlpha(d); await d.command('properties:open-local'); await show(d,'file-properties');
  await d.wait(`!!document.querySelector('${LEAF('file-properties')} .metadata-property')`,'file properties editor');
  await d.snap('properties-file',LEAF('file-properties'));
  d.record('filePropertyKeys',await d.ev(`([...document.querySelectorAll('${LEAF('file-properties')} .metadata-property')].map(e=>e.getAttribute('data-property-key')??e.dataset.key))`));
  await show(d,'all-properties');
  await d.rclick(d.withText(`${LEAF('all-properties')} .tree-item-inner-text`,'priority')+`?.closest('.tree-item-self')`);
  await d.hover(d.withText('.menu-item-title','Property type')+`?.closest('.menu-item')`);
  await d.wait(`document.querySelectorAll('.menu').length===2`,'priority type submenu'); await delay(300); await d.menuClick('Text');
  await d.wait(`(async()=>{try{return JSON.parse(await app.vault.adapter.read('.obsidian/types.json')).types.priority==='text'}catch{return false}})()`,'priority type saved');
  await show(d,'file-properties');
  await d.wait(`document.querySelector('${LEAF('file-properties')} .metadata-property[data-property-key=priority] .metadata-property-icon svg')?.classList.contains('lucide-text')`,'file property widget switched type');
  d.record('filePropertyAssignedType',await d.ev(`(() => { const row=document.querySelector('${LEAF('file-properties')} .metadata-property[data-property-key=priority]'); return {icon:row.querySelector('.metadata-property-icon svg').getAttribute('class'),input:row.querySelector('.metadata-property-value input')?.type,value:row.querySelector('.metadata-property-value input')?.value,warning:getComputedStyle(row.querySelector('.metadata-property-warning-icon')).display};})()`));
  await d.snap('properties-file-assigned',LEAF('file-properties'));
};

try {
  for (const [name, c] of clients) {
    const d = driver(name, c);
    console.log(`Preparing ${name} sidebar fixture`);
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await warm(c);
    if (!flags['no-setup']) await setup(d);
    if (flags['setup-only']) continue;
    for (const [section, run] of Object.entries(sections)) {
      if (only && !only.includes(section)) continue;
      const started = Date.now();
      try { await d.closeMenus(); await run(d); console.log(`${name}: ${section} done in ${Date.now() - started} ms`); }
      catch (error) { failures.push(`${name}: ${section}: ${error.message}`); console.log(`${name}: ${section} FAILED: ${error.message}`); await d.closeMenus().catch(() => undefined); }
    }
    d.R.errors = c.errors.slice();
    if (c.errors.length) failures.push(`${name}: renderer errors: ${c.errors.slice(0, 5).join(' | ')}`);
  }
} finally { for (const [, c] of clients) c.socket.close(); }

// ---------------------------------------------------------------- comparison
const differences = [];
if (report.reference && report.obsen && !flags['setup-only']) {
  const skip = new Set(['captures', 'errors', 'historicalErrors']);
  for (const key of new Set([...Object.keys(report.reference), ...Object.keys(report.obsen)])) {
    if (skip.has(key)) continue;
    const a = J(report.reference[key]), b = J(report.obsen[key]);
    if (a !== b) differences.push({ kind: 'state', key, reference: report.reference[key], obsen: report.obsen[key] });
  }
  // Structural comparison of the captured DOM outlines: tag, classes (order-insensitive), text and child lists.
  const norm = cls => cls.split(/\s+/).filter(Boolean).sort().join(' ');
  const walk = (a, b, where, out) => {
    if (out.length >= 12) return;
    if (!a || !b) { out.push(`${where}: ${a ? 'missing in obsen' : 'extra in obsen'} <${(a ?? b).tag} class="${(a ?? b).class}">`); return; }
    if (a.tag !== b.tag || norm(a.class) !== norm(b.class)) { out.push(`${where}: <${a.tag} class="${a.class}"> vs <${b.tag} class="${b.class}">`); return; }
    if ((a.placeholder ?? '') !== (b.placeholder ?? '')) out.push(`${where}: placeholder ${J(a.placeholder)} vs ${J(b.placeholder)}`);
    const ca = a.children ?? [], cb = b.children ?? [];
    if (!ca.length && !cb.length) { if ((a.text ?? '') !== (b.text ?? '')) out.push(`${where}: text ${J(a.text)} vs ${J(b.text)}`); return; }
    if (!!ca.length !== !!cb.length) { out.push(`${where} <${a.tag} class="${a.class}">: ${ca.length} vs ${cb.length} element children (text ${J(a.text ?? '')} vs ${J(b.text ?? '')})`); return; }
    for (let i = 0; i < Math.max(ca.length, cb.length); i++) walk(ca[i], cb[i], `${where}/${(ca[i] ?? cb[i]).tag}[${i}]`, out);
  };
  for (const scenario of Object.keys(report.reference.captures ?? {})) {
    if (!report.obsen.captures?.[scenario]) { differences.push({ kind: 'capture', scenario, problem: 'not captured in obsen' }); continue; }
    const [a, b] = await Promise.all(['reference', 'obsen'].map(async app => JSON.parse(await fs.readFile(path.join(output, `${app}-${scenario}.json`), 'utf8'))));
    const out = [];
    if (J(a.rect) !== J(b.rect)) out.push(`rect ${J(a.rect)} vs ${J(b.rect)}`);
    walk(a.outline, b.outline, a.outline.tag, out);
    if (out.length) differences.push({ kind: 'dom', scenario, details: out });
  }
  for (const scenario of Object.keys(report.obsen.captures ?? {})) if (!report.reference.captures?.[scenario]) differences.push({ kind: 'capture', scenario, problem: 'not captured in reference' });
}
await fs.writeFile(path.join(output, 'audit-report.json'), J({ report, failures, differences }, null, 2));
for (const failure of failures) console.log(`FAILED STEP  ${failure}`);
for (const difference of differences) console.log(difference.kind === 'state' ? `STATE DIFF   ${difference.key}\n   reference: ${J(difference.reference)}\n   obsen:     ${J(difference.obsen)}` : difference.kind === 'dom' ? `DOM DIFF     ${difference.scenario}\n   ${difference.details.join('\n   ')}` : `CAPTURE      ${difference.scenario}: ${difference.problem}`);
console.log(`${failures.length} failed steps, ${differences.length} differences. Report: ${path.join(output, 'audit-report.json')}`);
process.exitCode = failures.length || differences.length ? 1 : 0;
