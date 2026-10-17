import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {GraphSimulation,initSync} from '../src/graph/wasm/publish_graph.js';
initSync({module:await fs.readFile(new URL('../src/graph/wasm/publish_graph_bg.wasm',import.meta.url))});
const control=new GraphSimulation(),extended=new GraphSimulation();
try{
 for(const graph of [control,extended]){
  graph.init(['a','b'],new Float32Array([-100,50,100,-50]),[['a','b']]);
  graph.set_forces(0.1,1,120,400);
  graph.set_force_node('a',25,15);
  graph.simulate(0.3);
 }
 assert.deepEqual([...extended.complete()],[...control.complete()]);
 extended.add_nodes(['a','c'],new Float32Array([999,999,300,200]));
 const after=extended.complete(),expected=control.complete();
 assert.equal(after.length,6,'duplicate IDs do not add another node');
 assert.deepEqual([...after.slice(0,4)],[...expected],'existing positions, fixed coordinates and ongoing velocity survive append');
 assert.deepEqual([...after.slice(4)],[300,200],'new node starts at its supplied coordinates');
 extended.set_links([['a','b'],['b','c']]);extended.simulate(0.2);
 assert.ok([...extended.complete()].every(Number.isFinite),'appended nodes participate in the existing simulation');
 console.log('Graph WASM append preserves motion/fixed coordinates, rejects duplicates and accepts new links.');
}finally{control.free();extended.free();}
