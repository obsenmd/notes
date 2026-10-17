import { fixtureClient, delay } from './fixture-client.mjs';
const styles=[];
for (const [port, prefix] of [[9352,'obsen-reference-audit-'],[9342,'obsen-electron-smoke-']]) {
  const c = await fixtureClient(port,prefix);
  try {
    await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    await c.key('Escape');
    await c.evaluate(`app.workspace.revealLeaf(app.workspace.getLeavesOfType('file-explorer')[0])`);
    await delay(150);
    await c.click('.workspace-leaf-content[data-type=file-explorer] [aria-label="Change sort order"]');
    await delay(350);
    styles.push(await c.evaluate(`Object.fromEntries([...getComputedStyle(document.querySelector('.menu-item-title'))].map(k=>[k,getComputedStyle(document.querySelector('.menu-item-title')).getPropertyValue(k)]))`));
    console.log(port, await c.evaluate(`(() => {
      const root=document.querySelector('.menu'), title=root.querySelector('.menu-item-title');
      const style=e=>{const s=getComputedStyle(e);return Object.fromEntries(['fontFamily','fontSize','fontWeight','color','transform','opacity','filter','backdropFilter','webkitFontSmoothing','willChange'].map(k=>[k,s[k]]))};
      return {rect:root.getBoundingClientRect().toJSON(),width:root.offsetWidth,height:root.offsetHeight,inline:root.style.cssText,styles:style(root),title:style(title),titleRect:title.getBoundingClientRect().toJSON(),items:[...root.querySelectorAll('.menu-item')].map(e=>({rect:e.getBoundingClientRect().toJSON(),style:style(e)})),animations:root.getAnimations().map(a=>({state:a.playState,frames:a.effect.getKeyframes()})),body:style(document.body)};
    })()`));
    await c.key('Escape');
  } finally { c.socket.close(); }
}
console.log('Style differences',Object.keys(styles[0]).filter(k=>styles[0][k]!==styles[1][k]).map(k=>[k,styles[0][k],styles[1][k]]));
