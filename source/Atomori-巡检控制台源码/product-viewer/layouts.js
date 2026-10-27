import * as THREE from 'three';

// Bounding spheres keep the final spherical layout separated, even with large shells.
export function createLayouts(groups) {
  const bounds=new THREE.Box3();groups.forEach(g=>bounds.union(g.bounds));
  const center=bounds.getCenter(new THREE.Vector3());
  const overviewLift = bounds.getSize(new THREE.Vector3()).y;
  const radii=groups.map(g=>g.bounds.getSize(new THREE.Vector3()).length()/2);
  const directions=groups.map((g,i)=>{
    const y=1-2*(i+.5)/groups.length,r=Math.sqrt(1-y*y),a=i*Math.PI*(3-Math.sqrt(5));
    return new THREE.Vector3(Math.cos(a)*r,y,Math.sin(a)*r);
  });
  let radius=.85;
  for(let i=0;i<groups.length;i++)for(let j=0;j<i;j++)radius=Math.max(radius,(radii[i]+radii[j]+.025)/directions[i].distanceTo(directions[j]));
  const sphereCenter=center.clone();sphereCenter.y=radius+Math.max(...radii)+.05;
  const levels={'行走系统':.15,'内部模块':.5,'外观结构':.9,'对接平台':1.4,'无人机':1.95};
  groups.forEach((g,i)=>{
    const c=g.bounds.getCenter(new THREE.Vector3());
    g.layouts={assembly:g.offset.clone(),sphere:directions[i].clone().multiplyScalar(radius).add(sphereCenter).sub(c),layers:new THREE.Vector3((c.x-center.x)*1.2,levels[g.object.userData.category],(c.z-center.z)*1.2),overview:new THREE.Vector3(0,g.object.userData.category==='无人机'?overviewLift:0,0)};
  });
  return { radius, center:sphereCenter };
}
