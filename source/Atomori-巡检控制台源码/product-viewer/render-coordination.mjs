// Render the actual platform model as transparent dashboard thumbnails.
// Run from this directory with Playwright resolvable through NODE_PATH and either
// a local `three` dependency or ATOMORI_NODE_MODULES pointing at node_modules.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const modules = process.env.ATOMORI_NODE_MODULES;
const threeRoot = modules ? resolve(modules, 'three') : resolve(dirname(require.resolve('three')), '..');
const modelPath = resolve(here, 'public/ugv.glb');
const output = resolve(here, '../assets/generated/console');
const rendererPage = `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
</head><body><script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true, preserveDrawingBuffer:true });
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
const environment = new RoomEnvironment();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(environment, .025).texture;
scene.environmentIntensity = .7;
environment.dispose(); pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xe3e7ef, 0x191b21, .6));
for (const [color, intensity, position] of [
 [0xfff6ec, 2.4, [-.8,1.5,.7]], [0xdce3f1, 1.5, [.65,1,-.1]],
 [0xff1520, .7, [-.15,.5,-.95]], [0xe8ecf2, .7, [-1,.3,1]]
]) { const lamp = new THREE.DirectionalLight(color, intensity); lamp.position.set(...position); scene.add(lamp); }
const model = (await new GLTFLoader().loadAsync('/model.glb')).scene;
scene.add(model);
const groups = [];
model.traverse(object => { if (object.userData.component_group) groups.push(object); });
window.renderCoordination = kind => {
  const bounds = new THREE.Box3();
  let components = 0;
  for (const object of groups) {
    object.visible = (object.userData.category === '无人机') === (kind === 'uav');
    if (object.visible) { bounds.union(new THREE.Box3().setFromObject(object)); components++; }
  }
  if (bounds.isEmpty() || !components) throw new Error('No model components for ' + kind);
  const center = bounds.getCenter(new THREE.Vector3());
  const direction = new THREE.Vector3(-1, kind === 'uav' ? .12 : .32, .24).normalize();
  const camera = new THREE.OrthographicCamera(-1,1,1,-1,.01,20);
  camera.position.copy(center).addScaledVector(direction, 3);
  camera.lookAt(center); camera.updateMatrixWorld(true);
  const projected = new THREE.Box3();
  for (const x of [bounds.min.x,bounds.max.x]) for (const y of [bounds.min.y,bounds.max.y]) for (const z of [bounds.min.z,bounds.max.z]) {
    projected.expandByPoint(new THREE.Vector3(x,y,z).applyMatrix4(camera.matrixWorldInverse));
  }
  const width = projected.max.x - projected.min.x;
  const height = projected.max.y - projected.min.y;
  camera.left = projected.min.x - width*.04; camera.right = projected.max.x + width*.04;
  camera.bottom = projected.min.y - height*.04; camera.top = projected.max.y + height*.04;
  camera.updateProjectionMatrix();
  renderer.setSize(512, Math.round(512*height/width));
  renderer.render(scene, camera);
  return { png:renderer.domElement.toDataURL('image/png'), components,
    width:renderer.domElement.width, height:renderer.domElement.height };
};
</script></body></html>`;

const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(rendererPage); }
    if (pathname === '/model.glb') { res.setHeader('content-type', 'model/gltf-binary'); return res.end(await readFile(modelPath)); }
    if (pathname.startsWith('/three/')) {
      const file = resolve(threeRoot, pathname.slice('/three/'.length));
      if (!file.startsWith(threeRoot + sep)) { res.writeHead(403); return res.end(); }
      res.setHeader('content-type', 'text/javascript'); return res.end(await readFile(file));
    }
    res.writeHead(404); res.end();
  } catch (error) { res.writeHead(500); res.end(error.message); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({ channel: process.env.ATOMORI_BROWSER_CHANNEL || 'msedge', headless:true });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => typeof window.renderCoordination === 'function', null, { timeout:60000 });
  await mkdir(output, { recursive:true });
  for (const kind of ['uav','ugv']) {
    const result = await page.evaluate(kind => window.renderCoordination(kind), kind);
    const file = resolve(output, 'coordination-' + kind + '.png');
    await writeFile(file, Buffer.from(result.png.split(',')[1], 'base64'));
    console.log(JSON.stringify({ file, width:result.width, height:result.height, components:result.components }));
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
