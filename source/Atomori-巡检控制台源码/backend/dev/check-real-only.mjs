// 仅用内存夹具验证实时模式、树莓派来源和断流清空，不访问设备。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecordStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import { createUpstreamIntegrations } from '../src/upstream.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const directory = await mkdtemp(join(tmpdir(), 'atomori-real-only-'));
const store = new RecordStore(join(directory, 'records.json')); await store.init();
let blocked = false, offline = false, release;
const calls = [];
const integrations = createUpstreamIntegrations({ liveOnly: true, uavFlightUrl: 'http://rpi', missionPlannerUrl: 'http://mp', fetchImpl: async url => {
  calls.push(url);
  if (!url.startsWith('http://rpi/')) throw new Error('不应查询其他来源');
  if (blocked) await new Promise(done => { release = done; });
  if (offline) throw new Error('offline');
  return Response.json({ flight_controller_connected: true, vehicle_state_age_s: 0.05, armed: false, mode: 'STABILIZE',
    telemetry: { roll_deg: 5, pitch_deg: -2, rangefinder_m: 1.25, battery_voltage_v: 23.8, battery_remaining_pct: 0 },
    telemetry_meta: Object.fromEntries(['roll_deg', 'pitch_deg', 'rangefinder_m', 'battery_voltage_v', 'battery_remaining_pct'].map(key => [key,
      { valid: true, age_s: 0.05, unit: key.endsWith('_deg') ? 'deg' : key === 'rangefinder_m' ? 'm' : key === 'battery_voltage_v' ? 'V' : '%' }])) });
} });
const server = createServer(createApp({ store, integrations, webRoot: resolve(fileURLToPath(new URL('../../', import.meta.url))) }));
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByText('真实数据 · 只读', { exact: true }).waitFor();
  await page.waitForFunction(() => document.getElementById('uav-height').textContent.includes('1.25'));
  assert.equal(await page.locator('.uav-panel .metric-grid strong').first().innerText(), '0 %');
  assert.equal(await page.locator('#uav-voltage').innerText(), '23.80 V');
  assert.equal(await page.locator('#rover-state').innerText(), '车端未配置');
  assert.equal(await page.locator('#instrument-summary').innerText(), '测量未接入');
  assert.deepEqual(await page.locator('.spatial-kpis > div > b').allTextContents(), ['—', '—', '—']);
  assert.equal(await page.locator('#mission-id').innerText(), '实机任务未接入');
  assert.equal(await page.locator('#main-camera').getAttribute('src'), null);
  assert.ok((await page.locator('.asset-pin').allTextContents()).every(text => !/48\.6|20\.8|63\.2|0\.2/.test(text)));
  await page.locator('#thermal-view').click();
  assert.equal(await page.locator('#main-camera').getAttribute('src'), null);
  await page.locator('#expand-camera').click();
  assert.equal(await page.locator('#dialog-title').innerText(), '无实时图像');
  assert.equal(await page.locator('#dialog-body img').count(), 0);
  await page.locator('#close-dialog').click();
  await page.locator('#expand-ground').click();
  assert.equal(await page.locator('#dialog-title').innerText(), '车端未连接');
  await page.locator('#close-dialog').click();
  console.log('PASS 真实模式清空演示指标/地图标记/任务进度，无样本图像，车端保持断开，零值有效');

  blocked = true;
  await page.waitForFunction(() => document.getElementById('uav-voltage').textContent === '—' && document.getElementById('uav-height').textContent === '—', { timeout: 7000 });
  assert.equal(await page.locator('.attitude-horizon').getAttribute('transform'), '');
  assert.equal(await page.locator('#drone-state').innerText(), '飞控离线/过期');
  blocked = false; release?.();
  await page.waitForFunction(() => document.getElementById('uav-height').textContent.includes('1.25'));
  console.log('PASS 树莓派请求挂起时，姿态/测距/电池/飞控状态独立过期清空并恢复');

  await page.goto(url + '/marp/uav-details.html');
  await page.getByText('已接收树莓派只读遥测 · 仅显示有效上报。', { exact: true }).waitFor();
  assert.equal(await page.locator('#connection-badge').innerText(), '飞控在线');
  assert.equal(await page.locator('#mirror-source').innerText(), '机载 flight-status-http');
  assert.equal(await page.locator('#mirror-count').innerText(), '—');
  assert.equal(await page.locator('#attitude-empty').textContent(), '未收到有效姿态数据');
  assert.equal(await page.locator('.telemetry-table th').nth(4).innerText(), 'ROS 数据来源');
  await page.waitForFunction(() => document.getElementById('telemetry-rows').textContent.includes('23.80 V'));
  offline = true;
  await page.waitForFunction(() => document.getElementById('connection-badge').textContent === '飞控离线/过期');
  assert.ok(!await page.locator('#telemetry-rows').innerText().then(text => text.includes('23.80 V')));
  assert.ok(calls.every(value => value === 'http://rpi/api/status'));
  await page.route('**/api/v1/integrations', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'fixture unavailable' } }) }));
  await page.goto(url);
  await page.getByText('配置不可用 · 控制关闭', { exact: true }).waitFor();
  assert.ok((await page.locator('.device-panel .metric-grid strong').allTextContents()).every(value => value === '—'));
  assert.equal(await page.locator('#main-camera').getAttribute('src'), null);
  assert.equal(await page.locator('#ground-camera').getAttribute('src'), null);
  assert.equal(await page.locator('#thermal-view').isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS 飞控详情读取树莓派同一来源，不回退到 Mission Planner，断连及配置失败时清空，无页面错误');
} finally {
  blocked = false; release?.();
  await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('拒绝清理临时目录之外');
  await rm(directory, { recursive: true, force: true });
}
