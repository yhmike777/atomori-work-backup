// 使用独立服务和模拟遥测验证页面，不写入真实设备或正式业务记录。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { RecordStore } from '../src/store.js';
import { createUpstreamIntegrations } from '../src/upstream.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const directory = await mkdtemp(join(tmpdir(), 'atomori-flight-check-'));
const file = join(directory, 'records.json');
await writeFile(file, JSON.stringify({ findings: [], rechecks: [], events: [] }));
const store = new RecordStore(file); await store.init();
let status = { deviceId: 'UAV-01', source: 'mission-planner-mavlink', transport: { acceptedMessages: 0 }, flight: { connected: false, stateAgeS: null, metrics: {} } }, fail = false;
const integrations = createUpstreamIntegrations({ missionPlannerUrl: 'http://flight', fetchImpl: async () => {
  if (fail) throw new Error('offline');
  return Response.json(status);
} });
const server = createServer(createApp({ store, webRoot: resolve(fileURLToPath(new URL('../../', import.meta.url))), integrations }));
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  const entry = page.locator('.flight-details-link');
  assert.equal(await entry.count(), 1);
  await entry.click();
  await page.waitForURL('**/uav-details.html');
  await page.waitForFunction(() => document.getElementById('flight-banner').textContent.includes('等待另一台电脑'));
  assert.equal(await page.locator('#telemetry-rows tr').count(), 25);
  assert.equal(await page.locator('#primary-metrics strong').first().textContent(), '—');
  console.log('PASS 入口跳转、等待真实转发、25 项详情、页面无地图');
  const values = { roll: 0, pitch: -8.2, heading: 70, batteryVoltage: 23.8, batteryPercent: 0, relativeAltitude: -0.25, groundspeed: 0, airspeed: 0, batteryCurrent: 0, gpsFix: 0, satellites: 0 };
  status = { deviceId: 'UAV-01', source: 'mission-planner-mavlink', transport: { peerIp: '192.168.1.8', systemId: 1, componentId: 1, acceptedMessages: 100 }, flight: { connected: true, stateAgeS: 0.01, mode: 'GUIDED', armed: false, landedState: 'ON_GROUND', landedStateAgeS: 0.01,
    metrics: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, valid: true, ageS: 0.01, maxAgeS: 0.5, ageBasis: 'local_mavlink_receive', source: '<img src=x onerror=alert(1)>' }])) } };
  await page.waitForFunction(() => document.getElementById('roll-value').textContent === '0.0°');
  assert.equal(await page.locator('#primary-metrics strong').first().textContent(), '0%');
  assert.equal(await page.locator('#primary-metrics strong').nth(3).textContent(), '-0.25m');
  assert.equal(await page.locator('#flight-horizon').getAttribute('visibility'), 'visible');
  assert.equal(await page.locator('#telemetry-rows img').count(), 0);
  assert.equal(await page.locator('#hud-armed').textContent(), '已锁定');
  assert.match(await page.locator('#flight-state').textContent(), /无 GPS · 0 颗卫星/);
  assert.equal(await page.locator('iframe, .map-area, .tunnel-map, .spatial-panel').count(), 0);
  console.log('PASS 在线姿态、零电量、负相对高度、来源文本转义');
  await page.route('**/api/v1/devices/UAV-01/mission-planner', async route => { await new Promise(done => setTimeout(done, 1200)); await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '链路断开' } }) }); });
  await page.waitForFunction(() => document.getElementById('roll-value').textContent === '—');
  assert.equal(await page.locator('#flight-horizon').getAttribute('visibility'), 'hidden');
  await page.waitForFunction(() => document.getElementById('flight-banner').textContent.includes('链路断开'));
  assert.equal(await page.locator('#primary-metrics strong').first().textContent(), '—');
  await page.unroute('**/api/v1/devices/UAV-01/mission-planner');
  await page.getByRole('button', { name: '刷新数据' }).click();
  await page.waitForFunction(() => document.getElementById('roll-value').textContent === '0.0°');
  console.log('PASS 请求阻塞时样本过期、服务异常清空、手动重连');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole('link', { name: '返回巡检平台' }).click();
  await page.waitForURL('**/%E5%B7%A1%E6%A3%80%E6%8E%A7%E5%88%B6%E5%8F%B0.html');
  assert.deepEqual(errors, []);
  console.log('PASS 手机无横向溢出、返回主页面、无 JS 异常');
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
  await rm(directory, { recursive: true, force: true });
}
