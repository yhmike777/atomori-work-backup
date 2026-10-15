// 只用本机 HTTP 夹具验证参数同步；不连接实机、不发送设备控制。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { RecordStore } from '../src/store.js';
import { createUpstreamIntegrations } from '../src/upstream.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const webRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const output = resolve(webRoot, '../../output/playwright');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'atomori-ugv-parameters-'));
const store = new RecordStore(join(directory, 'records.json'));
await store.init();
const jpeg = Buffer.from('/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKoB2NP/2Q==', 'base64');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=', 'base64');
let offline = false, navigationOffline = false;
let raw = {
  gateway: { ok: true, service: 'car-web-gateway', schema_version: '1.0', uptime_s: 600, camera_backend: true },
  avoidance: { available: true, cruise_enabled: false },
  odom: { pose: [0, 0, 0], speed_mps: 0 },
  topic_ages_s: { odom: 0.1, scan: 0.1, ugv_control_mux: 0.1, ugv_command_gateway: 0.1, leadscrew: 0.1 },
  environment: { available: true, stale: false, age_s: 0.1, temperature_c: 0, humidity_percent: 0, consecutive_errors: 0,
    digital: Object.fromEntries(['tilt', 'flame', 'mq2'].map((key, index) => [key, { available: true, stale: false, age_s: 0.1, triggered: false, gpio: [13, 6, 18][index], level: 1, raw_level: 1, active_level: 0, changes: 0 }])) },
  gps: { fix: { status: 0, latitude: 0, longitude: 0, altitude: 0 }, age_s: 0.1 },
  localization: { active: true, state: 'localized', age_s: 0.1, backend: 'amcl', map_name: 'map_demo_new', map_pose: [0, 0, 0], confidence: 'high', xy_sigma_m: 0, yaw_sigma_rad: 0 },
  ultrasonic: { range: 0, age_s: 0.1 }, battery_voltage: null,
  ugv_control_mux: { authority: 'operator_steering', enabled: true, emergency_stop: false, gate_open: true, output_linear_mps: 0, output_angular_rps: 0, ages_s: { operator: 0.1 } },
  ugv_command_gateway: { enabled: true, emergency_stop: false, reason: 'forwarding', input_age_s: 0.1, command_timeout_s: 0.5, output_linear_mps: 0, output_angular_rps: 0 },
  leadscrew: { status: { state: [4, 4], pos_mm: [0, 0], enabled: [false, true] }, closed: true, age_s: 0.1 },
  map: { info: { width: 1, height: 1, resolution: 0.1, origin: [0, 0, 0] }, age_s: 50 },
  mapping: { active: false, since_s: null, current_pose: null, initial_pose: null },
  camera: { ready: false, age_s: null }, camera_rear: { ready: false, age_s: null }
};
let manual = {
  available: true, simulated: true, busy: false, moving: false, resetting: false, speed: 0, state: [4, 4], pos_mm: [0, 0], enabled: [false, true],
  position_reference: 'relative_to_node_start', alarm_feedback: false, simulation_clamped: false, simulation_next_action: 'clamp',
  message: '<img src=x onerror="window.bad=1">', output: '<script>window.bad=1</script>',
  pins: [{ step: 17, direction: 27, enable: 22 }, { step: 23, direction: 24, enable: 5 }],
  simulation_geometry: { 1: { open_gap_mm: 262, target_gap_mm: 142, travel_mm: 60, turns: 30, pulses: 48000 } }
};
const calls = [];
const upstream = createServer((req, res) => {
  calls.push([req.method, req.url]);
  const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (offline) return json({ error: 'offline' }, 503);
  if (req.url === '/api/status') return json({ ...raw, server_time_ms: Date.now() });
  if (req.url === '/api/nav/status') return navigationOffline ? json({ error: 'old_gateway' }, 404) : json({ active: false, has_map: true, goal: [0, 0], path: [[0, 0], [1, 2]] });
  if (req.url === '/api/auto_cruise/status') return json({ active: false, initial: [0, 0], map_name: 'map_demo_new', map_info: { width: 1, height: 1, resolution: 0.1, origin: [0, 0, 0] } });
  if (req.url === '/api/maps') return json({ maps: ['map_20260924_224659', 'map_demo_new', '../unsafe'] });
  if (req.url === '/api/leadscrew/manual/status') return json(manual);
  if (req.url === '/api/scan.json') return json({ age_s: 0.1, range_max: 10, points: [[0, 1], [90, 2]], escape_path: [[0.3, 0.1], [0.5, 0.2]] });
  if (req.url === '/api/camera_top.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(jpeg); }
  if (req.url === '/api/map.png' || /^\/api\/maps\/[A-Za-z0-9_-]+\.png$/.test(req.url)) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png); }
  return json({ error: 'not_available' }, 503);
});
await new Promise(done => upstream.listen(0, '127.0.0.1', done));
const integrations = createUpstreamIntegrations({ carUrl: `http://127.0.0.1:${upstream.address().port}` });
const app = createServer(createApp({ store, webRoot, integrations }));
await new Promise(done => app.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${app.address().port}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('dock-state').textContent === '仿真 · 机构保持');
  assert.equal(await page.locator('#rover-speed').innerText(), '0.00 m/s');
  assert.equal(await page.locator('.ugv-panel .metric-grid strong').nth(0).innerText(), '—');
  assert.equal(await page.locator('#drone-state').innerText(), '机载未连接');
  assert.equal(await page.locator('.command-panel button:not([data-device]):enabled').count(), 0);
  assert.equal(await page.locator('.twin-canvas').isVisible(), true);
  await page.screenshot({ path: join(output, 'ugv-parameters-main.png'), fullPage: true });
  console.log('PASS 主布局与原态势图保留，零速度有效，电池与机载不伪造，控制关闭');

  const openDetails = () => page.getByRole('button', { name: '车辆详情 ↗' }).click();
  const openGroup = name => page.locator(`#ugv-live-details > details[data-group="${name}"] > summary`).click();
  const value = (group, name) => page.locator(`#ugv-live-details > [data-group="${group}"] .business-list > div`).filter({ hasText: name }).locator('b');
  await openDetails();
  await openGroup('location');
  assert.equal(await value('location', 'GPS 纬度 / 经度').innerText(), '0.0000000 ° / 0.0000000 °');
  assert.equal(await value('location', 'XY 不确定度 / 航向不确定度').innerText(), '0.000 m / 0.00 °');
  await openGroup('control');
  assert.equal(await value('control', '控制权').innerText(), '巡航转向辅助');
  await openGroup('mechanism');
  assert.match(await value('mechanism', '位置基准').innerText(), /相对脉冲估算/);
  assert.equal(await value('mechanism', '驱动报警硬件反馈').innerText(), '无硬件反馈');
  assert.equal(await page.locator('#ugv-live-details img, #ugv-live-details script').count(), 0);
  assert.equal(await page.evaluate(() => window.bad), undefined);
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('[data-group="mechanism"]').evaluate(element => element.open), true);
  await page.screenshot({ path: join(output, 'ugv-parameters-details.png'), fullPage: true });
  console.log('PASS GPS/定位零值、完整控制权、推杆估算与仿真标记同步，折叠状态保持，文本安全');

  raw.leadscrew.age_s = 99; raw.gps.age_s = 99;
  await page.waitForFunction(() => document.getElementById('dock-state').textContent === '机构未连接');
  assert.equal(await value('location', 'GPS 纬度 / 经度').innerText(), '—');
  assert.equal(await page.locator('[data-group="mechanism"] table').first().locator('tbody tr').first().locator('td').nth(2).innerText(), '—');
  raw.leadscrew.age_s = 0.1; raw.gps.age_s = 0.1;
  await page.waitForFunction(() => document.getElementById('dock-state').textContent === '仿真 · 机构保持');
  console.log('PASS 机构与 GPS 独立过期清空并恢复，不把软件收拢标记当物理落位');

  await openGroup('navigation');
  assert.equal(await value('navigation', '导航目标').innerText(), 'X 0.00 m · Y 0.00 m');
  navigationOffline = true;
  await page.waitForFunction(() => [...document.querySelectorAll('[data-group="navigation"] .business-list > div')].find(element => element.firstElementChild.textContent === '导航状态（查询快照）')?.lastElementChild.textContent === '接口不可用/过期');
  assert.equal(await page.locator('#rover-speed').innerText(), '0.00 m/s');
  navigationOffline = false;
  await page.waitForFunction(() => [...document.querySelectorAll('[data-group="navigation"] .business-list > div')].find(element => element.firstElementChild.textContent === '导航状态（查询快照）')?.lastElementChild.textContent === '未执行');
  manual = { ...manual, simulation_geometry: { 1: null }, pins: [null] };
  await page.waitForTimeout(3300);
  console.log('PASS 单项详情接口失败不影响基础遥测，恢复自动同步，缺失机构配置不崩溃');

  await openGroup('camera');
  await page.getByRole('button', { name: '查看俯视', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('ground-camera').naturalWidth === 8 && getComputedStyle(document.getElementById('ground-camera')).visibility === 'visible');
  assert.match(await page.locator('.ground-feed > .feed-top .feed-label').innerText(), /俯视/);
  await openDetails(); await openGroup('map');
  assert.equal(await page.getByRole('button', { name: '../unsafe', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'map_demo_new', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('car-map-status').textContent.startsWith('map_demo_new · 同步'));
  assert.equal(await page.locator('#car-map-resolution').innerText(), '0.1 m/格');
  await page.getByRole('button', { name: '实时雷达 ↗' }).click();
  await page.waitForFunction(() => document.getElementById('ugv-escape-status')?.textContent.includes('2 个车体坐标点'));
  await page.locator('#close-dialog').click();
  await page.locator('.business-nav [data-business="gas"]').click();
  assert.equal(await page.locator('[data-group="digital"]').evaluate(element => element.open), true);
  assert.equal(await page.locator('#gas-confirm').count(), 0);
  await page.locator('#close-dialog').click();
  console.log('PASS 俯视画面、安全地图选择/分辨率、雷达脱困路径和现有业务入口同步');

  offline = true;
  await page.waitForFunction(() => document.getElementById('rover-state').textContent === '车端离线');
  assert.equal(await page.locator('#dock-state').innerText(), '机构未连接');
  assert.equal(await page.locator('#rover-speed').innerText(), '—');
  offline = false;
  await page.waitForFunction(() => document.getElementById('rover-state').textContent === '驻停');
  assert.ok(calls.every(([method]) => method === 'GET'));
  assert.ok(calls.every(([, path]) => !path.startsWith('/api/ugv/teleop') && !path.includes('/manual/move')));
  assert.deepEqual(errors, []);
  console.log('PASS 断连/恢复，所有车端请求仅 GET，无设备指令、无页面脚本错误');
  console.log(JSON.stringify({ screenshots: [join(output, 'ugv-parameters-main.png'), join(output, 'ugv-parameters-details.png')], upstreamRequests: calls.length }));
} finally {
  await browser.close();
  for (const server of [app, upstream]) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  const temporaryRoot = resolve(tmpdir()) + sep;
  if (!resolve(directory).startsWith(temporaryRoot)) throw new Error('拒绝清理临时目录以外的路径');
  await rm(directory, { recursive: true, force: true });
}
