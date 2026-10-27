import { setupGestures } from './gesture/control.js';
import { createLayouts } from './layouts.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';

const $ = id => document.getElementById(id);
const canvas = $('viewer');
const stage = canvas.parentElement;
const dashboardMode = document.documentElement.classList.contains('dashboard');
if (dashboardMode) {
  document.querySelector('.stage-title h1').textContent = '整机总览';
  document.querySelector('.stage-title p').textContent = 'F330 · 空地协同平台';
  // Reuse the explorer controls so the two presentations share one state.
  const toolbar = document.querySelector('.overview-toolbar');
  const actions = toolbar.querySelector('.structure-actions');
  for (const id of ['explode', 'restore', 'layout', 'view', 'drawer-toggle']) actions.append($(id));
  document.querySelector('.panel-heading h2').textContent = '零件';
  $('drawer-close').setAttribute('aria-label', '关闭零件');
  $('part-search').setAttribute('aria-label', '查找部件');
}
$('retry').addEventListener('click', () => location.reload());
function showLoadError(message) {
  $('loading').querySelector('p').textContent = message;
  $('loading').querySelector('.spinner').hidden = true;
  $('retry').hidden = false;
}
function closeDrawer() {
  if (!document.documentElement.classList.contains('parts-open')) return;
  document.documentElement.classList.remove('parts-open');
  $('drawer-toggle').setAttribute('aria-expanded', 'false');
  $('drawer-toggle').focus({ preventScroll: true });
}
$('drawer-toggle').addEventListener('click', () => {
  if (document.documentElement.classList.contains('parts-open')) { closeDrawer(); return; }
  document.documentElement.classList.add('parts-open');
  $('drawer-toggle').setAttribute('aria-expanded', 'true');
  $('drawer-close').focus({ preventScroll: true });
});
$('drawer-close').addEventListener('click', closeDrawer);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDrawer(); });
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const groups = [];
const pickable = [];
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let renderer, model, selected, hovered, cameraMove;
let spread = 0, distanceScale = .5, layout = dashboardMode ? 'overview' : 'sphere', gestureControl;
function manual(){gestureControl?.manual();}
function offset(g){return g.layouts?.[layout] || g.offset;}
function setExpansion(value, hand=false){
 if(!hand)manual();
 value=Math.max(0,Math.min(.5,value));
 spread=value;groups.forEach(g=>g.open=value>0 && offset(g).lengthSq()>0);
 $('spread').value=value*100;$('spread-value').textContent=`${Math.round(value*100)}%`;
 refresh();frameModel();
}

try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
} catch (error) {
  showLoadError('无法启动三维显示，请使用支持 WebGL 2 的浏览器并开启硬件加速。');
  throw error;
}
// Supersample the compact dashboard canvas for crisp fine parts even on 1x displays.
renderer.setPixelRatio(dashboardMode ? 2 : Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = dashboardMode ? 1.3 : 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(dashboardMode ? '#12212a' : '#0c1016');
// Keep distant exploded parts visible.
const camera = new THREE.PerspectiveCamera(34, 1, .01, 100);
const initialDirection = new THREE.Vector3(...(dashboardMode ? [-1.1, .58, 1.8] : [-1.6, .63, 1.25])).normalize();
camera.position.copy(initialDirection);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = .08;
controls.enablePan = true;
controls.minDistance = .32;
controls.maxDistance = 60;
controls.minPolarAngle = .08;
controls.maxPolarAngle = Math.PI - .01;
controls.target.set(0, .105, 0);
controls.update();
controls.addEventListener('start', () => { cameraMove = null; hideHover(); gestureControl?.manual(true); });
controls.addEventListener('end', () => gestureControl?.manual(false));

const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
const environment = pmrem.fromScene(room, .025);
scene.environment = environment.texture;
scene.environmentIntensity = dashboardMode ? .85 : .6;
room.dispose();
pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xe3e7ef, 0x191b21, dashboardMode ? .65 : .35));
function light(color, intensity, position, shadow = false) {
  const lamp = new THREE.DirectionalLight(color, intensity);
  lamp.position.set(...position);
  lamp.castShadow = shadow;
  if (shadow) {
    lamp.shadow.mapSize.set(2048, 2048);
    Object.assign(lamp.shadow.camera, { left: -1, right: 1, top: 1, bottom: -1, near: .1, far: 5 });
    lamp.shadow.bias = -.00015;
    lamp.shadow.normalBias = .001;
    lamp.shadow.radius = 3;
  }
  scene.add(lamp);
}
light(0xfff6ec, 2.1, [-.8, 1.5, .7], true);
light(0xdce3f1, 1.3, [.65, 1, -.1]);
light(0xff1520, 1.1, [-.15, .5, -.95]);
light(0xe8ecf2, dashboardMode ? .8 : .45, [-1, .3, 1]);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: .42 }));
floor.rotation.x = -Math.PI / 2;
floor.position.y = -.001;
floor.receiveShadow = true;
scene.add(floor);
const reflection = new Reflector(new THREE.PlaneGeometry(200, 200), { textureWidth: 512, textureHeight: 512, multisample: 0, clipBias: .001 });
reflection.rotation.x = -Math.PI / 2;
reflection.position.y = -.002;
reflection.material.fragmentShader = reflection.material.fragmentShader
  .replace('vec4 base = texture2DProj( tDiffuse, vUv );', `
    vec2 uv = vUv.xy / vUv.w;
    vec4 base = vec4(0.0);
    float weightSum = 0.0;
    for (int x = -2; x <= 2; x++) for (int y = -2; y <= 2; y++) {
      float weight = exp(-float(x*x + y*y) * .5);
      base += texture2D(tDiffuse, uv + vec2(float(x), float(y)) * .003) * weight;
      weightSum += weight;
    }
    base /= weightSum;`)
  .replace('gl_FragColor = vec4( blendOverlay( base.rgb, color ), 1.0 );', 'gl_FragColor = vec4(mix(vec3(.014, .016, .020), base.rgb, .08), 1.0);');
scene.add(reflection);
if (dashboardMode) {
  reflection.visible = false;
  const grid = new THREE.GridHelper(3, 38, 0x273d48, 0x20313b);
  grid.position.y = -.003;
  grid.material.transparent = true;
  grid.material.opacity = .25;
  scene.add(grid);
}

function resize() {
  const { width, height } = stage.getBoundingClientRect();
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  if (model) frameModel(false);
}
new ResizeObserver(resize).observe(stage);
resize();

function targetBounds() {
  const bounds = new THREE.Box3();
  for (const g of groups) {
    const delta = offset(g).clone().multiplyScalar(g.open ? spread * distanceScale : 0);
    bounds.union(g.bounds.clone().translate(delta));
  }
  return bounds;
}
function frameModel(animate = true, reset = false) {
  const bounds = targetBounds();
  const center = bounds.getCenter(new THREE.Vector3());
  const direction = reset ? initialDirection.clone() : camera.position.clone().sub(controls.target).normalize();
  const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
  const up = new THREE.Vector3().crossVectors(direction, right);
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const tanH = tanV * camera.aspect;
  let distance = .5;
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    const p = new THREE.Vector3(x, y, z).sub(center);
    distance = Math.max(distance, p.dot(direction) + Math.max(Math.abs(p.dot(right)) / tanH, Math.abs(p.dot(up)) / tanV) * (dashboardMode ? 1.04 : 1.28));
  }
  const position = center.clone().addScaledVector(direction, distance);
  if (animate && !reducedMotion) {
    cameraMove = { start: performance.now(), from: camera.position.clone(), to: position, targetFrom: controls.target.clone(), targetTo: center };
  } else {
    cameraMove = null;
    camera.position.copy(position);
    controls.target.copy(center);
    controls.update();
  }
}
function refresh() {
  if (dashboardMode) {
    $('overview-whole').setAttribute('aria-pressed', String(spread === 0));
    $('overview-structure').setAttribute('aria-pressed', String(spread > 0));
  }
  const movable = groups.filter(g => offset(g).lengthSq() > 0);
  const count = movable.filter(g => g.open).length;
  $('moved-count').textContent = `${count} / ${movable.length} 已移开`;
  for (const g of groups) {
    g.button.setAttribute('aria-pressed', String(g.open));
    g.button.dataset.selected = String(g === selected);
    g.button.querySelector('.part-state').textContent = offset(g).lengthSq() === 0 ? '固定基准' : g.open ? '已移开 −' : '移开 ＋';
  }
}
function select(g) {
  selected = g;
  $('selection-title').textContent = g.object.userData.label;
  $('selection-description').textContent = g.object.userData.description;
}
function toggle(g) {
  hideHover();
  select(g);
  manual();
  if (layout === 'overview') {
    // Overview lifts the UAV as a whole; individual selection uses part offsets.
    layout = 'assembly'; $('layout').value = layout;
    groups.forEach(part => { part.open = false; });
  }
  if(spread===0){spread=.5;$('spread').value=50;$('spread-value').textContent='50%';}
  if (offset(g).lengthSq()) g.open = !g.open;
  refresh();
  frameModel();
}
function hideHover() {
  hovered = null;
  $('hover-label').style.display = 'none';
  canvas.style.cursor = 'grab';
}
function pick(event) {
  const r = canvas.getBoundingClientRect();
  pointer.set((event.clientX - r.left) / r.width * 2 - 1, -(event.clientY - r.top) / r.height * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(pickable, false)[0]?.object.userData.assembly;
}

try {
  const gltf = await new GLTFLoader().loadAsync(new URL('./ugv.glb', document.baseURI).href, event => {
    if(event.total)$('loading').querySelector('p').textContent=`正在载入最新模型… ${Math.round(event.loaded/event.total*100)}%`;
  });
  model = gltf.scene;
  scene.add(model);
  model.updateMatrixWorld(true);
  model.traverse(o => {
    if (!o.userData.component_group) return;
    const g = { object: o, offset: new THREE.Vector3(...o.userData.explode_offset), origin: o.position.clone(), bounds: new THREE.Box3().setFromObject(o), open: false, meshes: [] };
    o.traverse(mesh => {
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.assembly = g;
      mesh.material = mesh.material.clone();
      if (mesh.material.emissiveIntensity > 1) mesh.material.emissiveIntensity *= .4;
      mesh.userData.emissive = mesh.material.emissive.clone();
      mesh.userData.emissiveIntensity = mesh.material.emissiveIntensity;
      g.meshes.push(mesh);
      pickable.push(mesh);
    });
    groups.push(g);
  });
  createLayouts(groups);
  if (dashboardMode) {
    const option = new Option('空地协同结构', 'overview');
    $('layout').prepend(option); $('layout').value = 'overview';
    spread = .5;
    groups.forEach(g => { g.open = offset(g).lengthSq() > 0; g.object.position.copy(g.origin).addScaledVector(offset(g), spread * distanceScale); });
    $('spread').value = '50'; $('spread-value').textContent = '50%';
  }
  groups.sort((a, b) => a.object.userData.order - b.object.userData.order);
  for (const category of ['外观结构', '行走系统', '内部模块', '对接平台', '无人机']) {
    const heading = document.createElement('h3');
    heading.className = 'part-category';
    heading.textContent = category;
    $('parts').append(heading);
    for (const g of groups.filter(g => g.object.userData.category === category)) {
      const d = g.object.userData;
      g.button = document.createElement('button');
      g.button.className = 'part';
      g.button.dataset.group = g.object.name;
      const name = document.createElement('span');
      name.className = 'part-name';
      name.textContent = d.label;
      const count = document.createElement('small');
      count.textContent = `${d.part_count} 个模型构件`;
      name.append(count);
      const state = document.createElement('span');
      state.className = 'part-state';
      g.button.append(name, state);
      g.button.addEventListener('click', () => toggle(g));
      $('parts').append(g.button);
    }
  }
  $('part-total').textContent = `${groups.length} 个可选部件`;
  for (const id of ['explode', 'restore', 'spread', 'layout', 'distance', 'autorotate', 'snapshot', 'view']) $(id).disabled = false;
  for (const id of ['overview-whole', 'overview-structure', 'overview-rotate', 'overview-reset', 'drawer-toggle']) $(id).disabled = false;
  refresh();
  frameModel(false, true);
  $('loading').hidden = true;
} catch (error) {
  showLoadError('模型加载失败，请确认本地服务正常后刷新页面。');
  console.error(error);
}

let press = null;
const activePointers = new Set();
canvas.addEventListener('pointerdown', e => {
  activePointers.add(e.pointerId);
  if (activePointers.size === 1 && e.button === 0) press = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
  else press = null;
});
canvas.addEventListener('pointermove', e => {
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) press.moved = true;
  if (e.buttons || e.pointerType === 'touch') { hideHover(); return; }
  const g = pick(e);
  if (!g) { hideHover(); return; }
  hovered = g;
  const rect = stage.getBoundingClientRect();
  const label = $('hover-label');
  label.textContent = `${g.object.userData.label} · ${offset(g).lengthSq() === 0 ? '固定基准' : g.open ? '点击装回' : '点击移开'}`;
  label.style.display = 'block';
  label.style.left = `${Math.max(8, Math.min(e.clientX - rect.left + 16, rect.width - label.offsetWidth - 8))}px`;
  label.style.top = `${Math.max(8, Math.min(e.clientY - rect.top + 16, rect.height - label.offsetHeight - 8))}px`;
  canvas.style.cursor = 'pointer';
});
canvas.addEventListener('pointerup', e => {
  if (press && press.id === e.pointerId && !press.moved) {
    const g = pick(e);
    if (g) toggle(g);
  }
  activePointers.delete(e.pointerId);
  press = null;
});
canvas.addEventListener('pointercancel', e => { activePointers.delete(e.pointerId); press = null; });
canvas.addEventListener('pointerleave', hideHover);
$('explode').addEventListener('click', () => {
  if (layout === 'overview') { layout = 'assembly'; $('layout').value = layout; }
  setExpansion(.5);
});
$('restore').addEventListener('click', () => setExpansion(0));
$('spread').addEventListener('input', e => setExpansion(Number(e.target.value)/100));
$('layout').addEventListener('change', e => {
 layout=e.target.value;
 if (dashboardMode) setExpansion(spread);
 else { manual();refresh();frameModel(); }
});
$('distance').addEventListener('input',e=>{manual();distanceScale=Number(e.target.value)/100;$('distance-value').textContent=e.target.value+'%';frameModel();});
$('part-search').addEventListener('input',e=>{const q=e.target.value.toLowerCase();for(const g of groups)g.button.hidden=!g.object.userData.label.toLowerCase().includes(q);});
function setAutoRotate(value) {
  controls.autoRotate = value;
  for (const id of ['autorotate', 'overview-rotate']) $(id).setAttribute('aria-pressed', String(value));
}
$('autorotate').addEventListener('click',()=>{manual();setAutoRotate(!controls.autoRotate);});
$('view').addEventListener('change',e=>{
 manual();const dirs={front:[-1,.001,0],rear:[1,.001,0],left:[0,.001,1],right:[0,.001,-1],top:[0,1,.001],bottom:[0,-1,.001]};
 if(e.target.value==='perspective'){frameModel(true,true);return;}
 camera.position.copy(controls.target).add(new THREE.Vector3(...dirs[e.target.value]));frameModel(false);
});
$('snapshot').addEventListener('click',()=>{renderer.render(scene,camera);const a=document.createElement('a');a.download='IOTSC-'+layout+'.png';a.href=canvas.toDataURL('image/png');a.click();});
$('home').addEventListener('click', () => { manual();setAutoRotate(false);$('view').value='perspective';if (model) frameModel(true, true); });
$('overview-whole').addEventListener('click', () => setExpansion(0));
$('overview-structure').addEventListener('click', () => { layout = 'overview'; $('layout').value = layout; setExpansion(.5); });
$('overview-rotate').addEventListener('click', () => {
  $('autorotate').click();
  $('overview-rotate').setAttribute('aria-pressed', String(controls.autoRotate));
});
$('overview-reset').addEventListener('click', () => {
  $('home').click();
  $('overview-rotate').setAttribute('aria-pressed', 'false');
});
function zoom(factor) {
  cameraMove = null;
  const delta = camera.position.clone().sub(controls.target);
  delta.setLength(THREE.MathUtils.clamp(delta.length() * factor, controls.minDistance, controls.maxDistance));
  camera.position.copy(controls.target).add(delta);
  controls.update();
}
$('zoom-in').addEventListener('click', () => {manual();zoom(.82);});
$('zoom-out').addEventListener('click', () => {manual();zoom(1.22);});
canvas.addEventListener('keydown', e => {
  manual();
  if (e.key === '+' || e.key === '=') zoom(.9);
  else if (e.key === '-') zoom(1.1);
  else if (e.key.startsWith('Arrow')) {
    cameraMove = null;
    const orbit = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    if (e.key === 'ArrowLeft') orbit.theta -= .1;
    if (e.key === 'ArrowRight') orbit.theta += .1;
    if (e.key === 'ArrowUp') orbit.phi -= .1;
    if (e.key === 'ArrowDown') orbit.phi += .1;
    orbit.phi = THREE.MathUtils.clamp(orbit.phi, controls.minPolarAngle, controls.maxPolarAngle);
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(orbit));
    controls.update();
  } else return;
  e.preventDefault();
});
function handControl(){
 setAutoRotate(false);
 const p=camera.position.clone(),t=controls.target.clone();
 controls.enableDamping=false;controls.update();camera.position.copy(p);controls.target.copy(t);controls.update();controls.enableDamping=true;
}
gestureControl=setupGestures({ready:()=>groups.length>0,expand:value=>setExpansion(value,true),zoom:factor=>{handControl();zoom(factor);},rotate:(yaw,pitch)=>{
 handControl();cameraMove=null;
 const orbit=new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));orbit.theta+=yaw;orbit.phi=THREE.MathUtils.clamp(orbit.phi+pitch,controls.minPolarAngle,controls.maxPolarAngle);
 camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(orbit));controls.update();
}});
let lastTime = performance.now();
const destination = new THREE.Vector3();
const highlight = new THREE.Color(0x64191f);
const annotations = document.querySelector('.overview-annotations');
function updateAnnotations() {
  if (!dashboardMode || !model) return;
  const width = stage.clientWidth, height = stage.clientHeight;
  annotations.style.visibility = width > 400 && height > 300 ? 'visible' : 'hidden';
  annotations.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const specs = [
    ['uav', groups.filter(g => g.object.userData.category === '无人机'), .075, .25, false],
    ['vision', groups.filter(g => /相机|视觉|云台/.test(g.object.userData.label)), .89, .43, true],
    ['chassis', groups.filter(g => g.object.userData.category === '外观结构'), .075, .73, false]
  ];
  for (const [key, selectedGroups, tx, ty, right] of specs) {
    const node = annotations.querySelector(`[data-callout="${key}"]`);
    if (!selectedGroups.length) { node.style.display = 'none'; continue; }
    node.style.display = '';
    const bounds = new THREE.Box3();
    selectedGroups.forEach(g => bounds.union(g.bounds.clone().translate(g.object.position.clone().sub(g.origin))));
    const projected = bounds.getCenter(new THREE.Vector3()).project(camera);
    const x = (projected.x + 1) * width / 2, y = (1 - projected.y) * height / 2;
    const labelX = tx * width, labelY = ty * height;
    node.querySelector('text').setAttribute('x', labelX); node.querySelector('text').setAttribute('y', labelY - 8);
    node.querySelector('text').setAttribute('text-anchor', right ? 'end' : 'start');
    const elbow = labelX + (right ? -75 : 75);
    node.querySelector('path').setAttribute('d', `M${labelX} ${labelY}H${elbow}L${x} ${y}`);
    node.querySelector('circle').setAttribute('cx', x); node.querySelector('circle').setAttribute('cy', y);
  }
}
renderer.setAnimationLoop(time => {
  const dt = Math.min((time - lastTime) / 1000, .05);
  lastTime = time;
  updateAnnotations();
  let groundY = 0;
  for (const g of groups) {
    destination.copy(g.origin).addScaledVector(offset(g), g.open ? spread * distanceScale : 0);
    g.object.position.lerp(destination, reducedMotion ? 1 : 1 - Math.exp(-dt * 9));
    if (g.object.position.distanceToSquared(destination) < 1e-9) g.object.position.copy(destination);
    // Assembly offsets move wheels below their original contact plane. Follow
    // the current animated positions without changing any assembly coordinates.
    groundY = Math.min(groundY, g.bounds.min.y + g.object.position.y - g.origin.y);
    for (const mesh of g.meshes) {
      const accented = g === hovered;
      mesh.material.emissive.copy(mesh.userData.emissive);
      if (accented) mesh.material.emissive.add(highlight);
      mesh.material.emissiveIntensity = mesh.userData.emissiveIntensity;
    }
  }
  floor.position.y = groundY - .001;
  reflection.position.y = groundY - .002;
  if (cameraMove) {
    const t = Math.min((time - cameraMove.start) / 750, 1);
    const ease = 1 - (1 - t) ** 3;
    camera.position.lerpVectors(cameraMove.from, cameraMove.to, ease);
    controls.target.lerpVectors(cameraMove.targetFrom, cameraMove.targetTo, ease);
    if (t === 1) cameraMove = null;
  }
  controls.update();
  renderer.render(scene, camera);
});
