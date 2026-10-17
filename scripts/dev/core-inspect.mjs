import { fixtureClient, delay } from './fixture-client.mjs';
for (const [name,port,prefix] of [['reference',9351,'obsen-reference-audit-'],['obsen',9341,'obsen-electron-smoke-']]) {
 const c=await fixtureClient(port,prefix);
 try {
  await c.key('Escape');
  await c.evaluate(`(async()=>{await app.workspace.getLeaf().openFile(app.vault.getFileByPath('Core audit.md'));})()`);
  await delay(150);
  await c.evaluate(`app.commands.executeCommandById('workspaces:open-modal')`);
  await delay(150);
  console.log(name,'focus',await c.evaluate(`(()=>{const e=document.querySelector('.modal input');return {active:document.activeElement?.className,hasFocus:document.hasFocus(),focused:e.matches(':focus'),visible:e.matches(':focus-visible'),box:getComputedStyle(e).boxShadow};})()`));
  await c.key('Escape');
  await c.evaluate(`app.commands.executeCommandById('slides:start')`);
  await delay(400);
  console.log(name,'slides',await c.evaluate(`(()=>{const root=document.querySelector('.reveal'),h=root.querySelector('h1'),p=root.querySelector('p'),css=e=>{const c=getComputedStyle(e);return {color:c.color,font:c.font,background:c.backgroundColor,opacity:c.opacity,width:c.width,height:c.height,transform:c.transform,display:c.display};};return {root:css(root),h:css(h),p:css(p),slides:css(root.querySelector('.slides')),overlay:css(root.querySelector('.pause-overlay'))};})()`));
  await c.click('.slides-close-btn');
 } finally {c.socket.close();}
}
