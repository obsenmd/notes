import {fixtureClient,delay} from './fixture-client.mjs';
const c=await fixtureClient(9342,'obsen-electron-smoke-');
try {
 await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});
 await c.evaluate(`app.workspace.revealLeaf(app.workspace.getLeavesOfType('search')[0])`);
 await delay(250);
 await c.evaluate(`(()=>{const v=app.workspace.getLeavesOfType('search')[0].view;if(!window.__searchStateLog){window.__searchStateLog=[];const set=v.setState.bind(v);v.setState=(s,...a)=>{window.__searchStateLog.push({s,stack:new Error().stack});return set(s,...a);};}const e=document.querySelector('.workspace-leaf-content[data-type=search] input[type=search]');e.focus();e.select();})()`);
 await c.send('Input.insertText',{text:'needle'});
 await delay(700);
 console.log('before Escape',await c.evaluate(`({state:app.workspace.getLeavesOfType('search')[0].view.getState(),input:document.querySelector('.workspace-leaf-content[data-type=search] input').value,focused:document.activeElement.outerHTML.slice(0,220),log:window.__searchStateLog,html:document.querySelector('.workspace-leaf-content[data-type=search]').innerText})`));
 await c.key('Escape');
 await delay(100);
 console.log('after Escape',await c.evaluate(`({state:app.workspace.getLeavesOfType('search')[0].view.getState(),log:window.__searchStateLog})`));
}finally{c.socket.close();}
