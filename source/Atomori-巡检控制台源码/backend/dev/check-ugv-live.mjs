// 夹具回归使用临时业务文件；--real 仅查看当前 3000 页面与实机只读接口。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { RecordStore } from '../src/store.js';
import { createUpstreamIntegrations } from '../src/upstream.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const real = process.argv.includes('--real');
let directory, server;
let url = 'http://127.0.0.1:3000';
let status = {
  odom: { pose: [1, -2, 0], speed_mps: 0.18 }, topic_ages_s: { odom: 0.1, ugv_control_mux: 0.1 },
  environment: { available: true, stale: false, age_s: 0.1, temperature_c: 24.2, humidity_percent: 56,
    digital: { tilt: { available: true, stale: false, age_s: 0.1, triggered: true }, flame: { available: true, stale: false, age_s: 0.1, triggered: false }, mq2: { available: true, stale: false, age_s: 0.1, triggered: false } } },
  ugv_control_mux: { authority: 'navigation', emergency_stop: false },
  localization: { active: true, state: 'localized', age_s: 0.1, map_pose: [5.5, -1.2, 0.3], confidence: 'high' },
  camera: { ready: false }, camera_rear: { ready: false }
};
let offline = false, blocked = false, release;
const blockedRequest = () => new Promise(done => { release = done; });
let carRequests = 0;
const jpeg = Buffer.from('/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKoB2NP/2Q==', 'base64');
if (!real) {
  directory = await mkdtemp(join(tmpdir(), 'atomori-ugv-'));
  const store = new RecordStore(join(directory, 'records.json')); await store.init();
  const integrations = createUpstreamIntegrations({ carUrl: 'http://127.0.0.1:1', uavVisionUrl: 'http://127.0.0.1:2', fetchImpl: async input => {
    if (!input.startsWith('http://127.0.0.1:1/')) throw new Error('uav offline');
    if (offline) throw new Error('car offline');
    if (input.endsWith('/api/status')) {
      carRequests++;
      if (blocked) await blockedRequest();
      return new Response(JSON.stringify({ ...status, server_time_ms: Date.now() }));
    }
    if (input.endsWith('/api/scan.json')) return new Response(JSON.stringify({ age_s: 0.1, range_max: 10, points: [[0, 1], [90, 2], ['bad', 1]] }));
    if (input.endsWith('/api/camera_rear.jpg') && status.camera_rear.ready) return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
    return new Response('', { status: 503 });
  } });
  server = createServer(createApp({ store, integrations, webRoot: resolve(fileURLToPath(new URL('../../', import.meta.url))) }));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${server.address().port}`;
}
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 997, height: 1200 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('rover-state').textContent === '驻停' || document.getElementById('rover-state').textContent === '行驶中');
  const metrics = page.locator('.ugv-panel .metric-grid strong');
  assert.equal(await page.locator('.map-area.car-map').count(), 0);
  await page.locator('#toggle-map').click();
  assert.equal(await page.locator('.tunnel-map').isVisible(), true);
  await page.locator('#toggle-map').click();
  assert.equal(await page.locator('.twin-canvas').isVisible(), true);
  await page.waitForFunction(() => document.getElementById('car-map-image')?.naturalWidth > 0);
  assert.equal(await page.locator('.ugv-panel #ground-map-view').getAttribute('aria-pressed'), 'true');
  await page.locator('#expand-ground').click();
  await page.waitForFunction(() => document.getElementById('ugv-map-image')?.naturalWidth > 0);
  await page.locator('#close-dialog').click();
  console.log('PASS 全域二维与2.5D保持原图，车端地图在无人车画面内显示并可放大');
  assert.equal(await metrics.nth(0).textContent(), '—');
  assert.equal(await page.locator('.command-panel button:not([data-device]):enabled').count(), 0);
  if (!real) {
    assert.equal(await metrics.nth(1).textContent(), '0.18 m/s');
    assert.equal(await metrics.nth(2).textContent(), '24.2 °C');
    assert.equal(await metrics.nth(3).textContent(), '56 %RH');
    assert.equal(await page.locator('.environment-grid b').allTextContents().then(values => values.join(',')), '触发,未触发,正常');
    assert.match(await page.locator('.link-topology').textContent(), /地图 · X 5.50/);
    console.log('PASS 小车有效温湿度、速度、地图定位及数字触发状态同步');
    status.environment.stale = true;
    status.environment.digital.tilt.age_s = 3;
    status.odom.speed_mps = null;
    await page.waitForFunction(() => document.getElementById('rover-state').textContent === '里程计过期/缺失');
    assert.equal(await metrics.nth(1).textContent(), '—');
    assert.equal(await metrics.nth(2).textContent(), '—');
    assert.equal(await page.locator('.environment-grid b').first().textContent(), '—');
    console.log('PASS 缺失速度不显示驻停，过期温湿度与数字信号独立清空');
    status.environment.stale = false; status.odom.speed_mps = 0; status.environment.temperature_c = 0; status.environment.humidity_percent = 0;
    status.environment.digital.tilt.age_s = 0.1; status.localization.age_s = 3;
    await page.waitForFunction(() => document.querySelector('.ugv-panel .metric-grid .metric:nth-child(3) strong').textContent === '0.0 °C');
    assert.equal(await metrics.nth(1).textContent(), '0.00 m/s');
    assert.equal(await metrics.nth(3).textContent(), '0 %RH');
    assert.match(await page.locator('.link-topology').textContent(), /里程计 · X 1.00/);
    const before = carRequests;
    blocked = true;
    await page.waitForFunction(() => document.getElementById('rover-state').textContent === '里程计过期/缺失');
    assert.ok(carRequests > before);
    assert.equal(await metrics.nth(1).textContent(), '—');
    blocked = false; release?.();
    await page.waitForFunction(() => document.getElementById('rover-state').textContent === '驻停');
    console.log('PASS 零值有效、定位过期回退里程计，请求挂起时旧速度清空并自动恢复');
    status.ugv_control_mux.emergency_stop = true;
    await page.waitForFunction(() => document.getElementById('rover-state').textContent === '急停状态');
    status.ugv_control_mux.emergency_stop = false;
    await page.waitForFunction(() => document.getElementById('rover-state').textContent === '驻停');
  }
  await page.getByRole('button', { name: '车辆详情 ↗' }).click();
  await page.locator('#ugv-live-details').waitFor();
  assert.doesNotMatch(await page.locator('#ugv-live-details').innerHTML(), /<script/);
  await page.locator('#close-dialog').click();
  await page.getByRole('button', { name: '实时雷达 ↗' }).click();
  await page.waitForFunction(() => document.getElementById('ugv-scan-status')?.textContent.includes('有效扫描点'));
  await page.locator('#close-dialog').click();
  await page.getByRole('button', { name: '地面图传', exact: true }).click();
  await page.getByRole('button', { name: '切换后视' }).click();
  assert.equal(await page.locator('#ground-view').textContent(), '切换前视');
  await page.waitForFunction(() => document.querySelector('.ground-feed .feed-label').textContent.includes('后视'));
  if (!real) assert.equal(await page.locator('#ground-camera').evaluate(image => getComputedStyle(image).visibility), 'hidden');
  console.log('PASS 实时详情、雷达、前后视入口与无帧清空');
  if (!real) {
    status.camera_rear.ready = true;
    await page.waitForFunction(() => { const image = document.getElementById('ground-camera'); return image.naturalWidth === 8 && getComputedStyle(image).visibility === 'visible'; });
    await page.locator('#expand-ground').click();
    await page.waitForFunction(() => document.getElementById('ugv-expanded-camera')?.naturalWidth === 8);
    status.camera_rear.ready = false;
    await page.waitForFunction(() => document.getElementById('ugv-expanded-camera')?.getAttribute('src') === null);
    await page.locator('#close-dialog').click();
    console.log('PASS 相机帧恢复、放大同步，失效后清空旧画面');
    offline = true;
    await page.waitForFunction(() => document.getElementById('rover-state').textContent === '车端离线');
    for (const index of [1, 2, 3]) assert.equal(await metrics.nth(index).textContent(), '—');
    offline = false;
    await page.waitForFunction(() => document.getElementById('rover-state').textContent === '驻停');
    console.log('PASS 断连清空、自动恢复；UAV 故障不阻塞小车刷新');
  } else {
    const snapshots = [];
    for (let i = 0; i < 3; i++) snapshots.push((await fetch(url + '/api/v1/devices/UGV-01/telemetry').then(response => response.json())).data);
    assert.ok(new Set(snapshots.map(data => data.observedAt)).size > 1);
    const map = await fetch(url + '/api/v1/maps/current.png'); assert.equal(map.status, 200);
    assert.equal(await fetch(url + '/api/v1/commands', { method: 'POST', body: '{}' }).then(response => response.status), 503);
    console.log(JSON.stringify({ source: snapshots.at(-1).source, observedAt: snapshots.at(-1).observedAt, speed: snapshots.at(-1).odom.speedMps, environment: snapshots.at(-1).environment, mapHttp: map.status }));
  }
  await page.locator('#ground-map-view').click();
  assert.equal(await page.locator('.ground-map-layer').isVisible(), true);
  assert.equal(await page.locator('#ground-view').textContent(), '地面图传');
  assert.deepEqual(errors, []);
  if (process.env.ATOMORI_SCREENSHOT) await page.screenshot({ path: process.env.ATOMORI_SCREENSHOT, fullPage: true });
  console.log('PASS 浏览器无脚本错误');
} finally {
  blocked = false; release?.();
  await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  if (directory) await rm(directory, { recursive: true, force: true });
}
