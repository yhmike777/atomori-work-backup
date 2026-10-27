import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createLayouts } from '../layouts.js';
const data=fs.readFileSync(new URL('../public/ugv.glb',import.meta.url));
const gltf=await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength),'');
gltf.scene.updateMatrixWorld(true);
const groups=[];
gltf.scene.traverse(o=>{if(o.userData.component_group)groups.push({object:o,offset:new THREE.Vector3(...o.userData.explode_offset),bounds:new THREE.Box3().setFromObject(o)});});
assert.equal(groups.length,270);
const sphere=createLayouts(groups);
for(const g of groups){
 assert(['外观结构','行走系统','内部模块','对接平台','无人机'].includes(g.object.userData.category));
 for(const offset of Object.values(g.layouts))assert(offset.toArray().every(Number.isFinite));
 const start=g.bounds.getCenter(new THREE.Vector3()),end=start.clone().add(g.layouts.sphere);
 assert(Math.abs(end.distanceTo(sphere.center)-sphere.radius)<1e-5);
 assert(g.bounds.min.y+g.layouts.sphere.y>0);
 assert.equal(g.layouts.overview.x,0);
 assert.equal(g.layouts.overview.z,0);
 if(g.object.userData.category==='无人机')assert(g.layouts.overview.y>0);
 else assert.equal(g.layouts.overview.lengthSq(),0,'Overview keeps chassis components assembled');
 assert(start.clone().addScaledVector(g.layouts.sphere,0).equals(start));
 for(const factor of [.25,.5,.75])assert(start.clone().addScaledVector(g.layouts.sphere,factor).distanceTo(start)>0);
}
for(let i=0;i<groups.length;i++)for(let j=0;j<i;j++){
 const a=groups[i].bounds.clone().translate(groups[i].layouts.sphere),b=groups[j].bounds.clone().translate(groups[j].layouts.sphere);
 assert(!a.intersectsBox(b),`Sphere overlap ${i}, ${j}`);
}
let blades=0;
gltf.scene.traverse(o=>{if(o.isMesh&&o.name.includes('7寸双叶桨'))blades++;});assert.equal(blades,8);
const droneOffsets=groups.filter(g=>g.object.userData.category==='无人机').map(g=>g.layouts.overview.y);
assert(droneOffsets.every(y=>y===droneOffsets[0]),'Overview lifts the drone as one intact assembly');
console.log(`PASS: ${groups.length} parts, 8 blades, 4 finite layouts, rigid overview separation, intermediate states, assembled coordinates and separated spherical targets; sphere radius ${sphere.radius.toFixed(2)} m`);
