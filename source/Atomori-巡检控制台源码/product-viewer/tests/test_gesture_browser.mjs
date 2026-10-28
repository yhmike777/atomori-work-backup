import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';

// Separate browser, public sample video only. Never opens the physical camera.
// node tests/test_gesture_browser.mjs <url> <upright_transition_camera.y4m> <node_modules>
const [url, videoPath, modules] = process.argv.slice(2);
if (!url || !videoPath || !modules) throw new Error('Expected URL, sample Y4M video and Playwright node_modules path');
const require = createRequire(import.meta.url);
const { chromium } = require(join(resolve(modules), 'playwright'));
const browser = await chromium.launch({ channel: process.env.ATOMORI_BROWSER_CHANNEL || 'msedge', headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader', `--use-file-for-fake-video-capture=${resolve(videoPath)}`] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], requests = [], samples = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => requests.push(request.url()));
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#loading').hidden, null, { timeout: 90000 });
  assert.equal(await page.locator('#spread').inputValue(), '0');
  assert.equal(await page.locator('#gesture-panel').getAttribute('open'), '');
  await page.locator('#camera-toggle').click();
  await page.waitForFunction(() => document.querySelector('#camera-toggle').getAttribute('aria-pressed') === 'true', null, { timeout: 60000 });
  let initialPalm = false, expanded = false, restored = false;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && !restored) {
    const sample = await page.evaluate(() => ({ time: document.querySelector('#camera-video').currentTime,
      spread: Number(document.querySelector('#spread').value), status: document.querySelector('#camera-status').textContent }));
    samples.push(sample);
    if (!initialPalm && /张掌已稳定/.test(sample.status) && sample.spread === 0) initialPalm = true;
    if (initialPalm && sample.spread === 50) expanded = true;
    if (expanded && sample.spread === 0 && /握拳/.test(sample.status)) restored = true;
    await page.waitForTimeout(180);
  }
  assert(initialPalm, 'Initial stable palm must leave the model assembled');
  assert(expanded, 'Real MediaPipe fist → palm must expand the current 270-part model');
  assert(restored, 'Real MediaPipe palm → fist must restore the model');
  const cameraLoads = requests.filter(request => /gesture\/(?:vision_bundle|wasm\/|gesture_recognizer)/.test(request));
  assert(cameraLoads.length >= 3, 'Recognizer, WASM and task model must load');
  assert(cameraLoads.every(request => new URL(request).origin === new URL(url).origin), 'All recognition assets must be local');
  await page.locator('#camera-toggle').click();
  assert.equal(await page.locator('#camera-toggle').getAttribute('aria-pressed'), 'false');
  assert(await page.locator('#camera-video').evaluate(video => video.srcObject === null));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', model: 'current 270-part Atomori platform', realMediaPipe: true,
    physicalCameraUsed: false, initialPalm, expanded, restored, localAssets: cameraLoads.length,
    elapsedVideoSeconds: samples.at(-1)?.time, errors }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', error: error.stack, errors, samples: samples.filter((_, index) => index % 5 === 0) }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
