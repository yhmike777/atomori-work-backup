import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// Isolated UI regression fixture. Does not modify the live service or robot data.
// node marp/tests/uav-details-browser.mjs <base-url> <Playwright node_modules> [screenshot] [--live]
// The default fixture never reads device telemetry. --live explicitly enables the final live check.
const [base, modules, screenshot] = process.argv.slice(2);
if (!base || !modules) throw new Error('Expected service base URL and Playwright node_modules');
const require = createRequire(import.meta.url), { chromium } = require(join(modules, 'playwright'));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
let shortened = false, disconnected = false, failed = false, sequence = 0, rollValue = 0;
const value = (number, label, group = '测试参数') => ({ value: number, valid: true, ageS: 0.03, maxAgeS: 0.5, source: '/test/readonly', label, group, digits: 2, unit: 'm/s' });
try {
  await page.route('**/api/v1/integrations', route => route.fulfill({ json: { data: { mode: 'upstream-readonly', uavFlightConfigured: true, uavFlightSource: 'raspberry-pi' } } }));
  await page.route('**/api/v1/devices/UAV-01/telemetry?source=flight', route => failed ? route.fulfill({ status: 503, json: { error: { message: 'test temporary network failure' } } }) : route.fulfill({ json: { data: {
    deviceId: 'UAV-01', source: 'uav-rpi-deploy', sourceIdentity: 'isolated-test-pi', normalizedAt: new Date().toISOString(), flight: {
      connected: !disconnected, stateAgeS: 0.05, mode: 'STABILIZE', armed: false,
      metrics: disconnected ? {} : { roll: value(rollValue, '横滚'), pitch: value(1, '俯仰'), gyroX: value(0.01, '陀螺仪 X'), gyroY: value(0, '陀螺仪 Y'), gyroZ: value(0.02, '陀螺仪 Z'), batteryCurrent: { ...value(null, '电流'), valid: false } }, details: disconnected ? {} : {
        metrics: disconnected ? {} : { velocityX: value(0, '机体系速度 X（FLU）', '机体系速度 FLU'), ...(shortened ? {} : { rcInput8: value(1500, '遥控通道 8', '遥控器输入') }), temperatureBoard: value(33.1, '<img src=x onerror=alert(1)>', '温度') },
        health: [{ label: '陀螺仪', state: '正常' }], healthValid: true, healthAgeS: 0.03,
        alerts: [{ text: 'fixture current message', valid: true, ageS: 0.03, maxAgeS: 30, severity: 6 }],
        extraTelemetryStatus: 'CONNECTED', telemetrySourcesStatus: 'CONNECTED', telemetrySources: [{ topic: '/test/readonly', messageType: 'std_msgs/Float64', count: ++sequence, ageS: 0.03, maxAgeS: 1, status: 'RECEIVING', valid: true, data: { payload: '<img src=x onerror=alert(1)>', value: sequence } }],
        motionCommandStatus: 'NOT_CONNECTED', executorStatus: 'CONNECTED', velocityStatus: 'NOT_CONNECTED',
        executor: { status: 'VALID', valid: true, ageS: 0.03, maxAgeS: 1, source: '/test/executor', data: { enabled: false } }
      }
    }
  } } }));
  await page.goto(base + '/marp/uav-details.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('[data-metric="rcInput8"]'));
  assert.match(await page.locator('[data-metric="velocityX"] td').nth(1).textContent(), /^0\.00/);
  assert.equal(await page.locator('[data-metric="batteryCurrent"] td').nth(1).textContent(), '—');
  assert.equal(await page.locator('[data-metric="temperatureBoard"] img').count(), 0);
  const tableRow = await page.locator('[data-metric="velocityX"]').elementHandle();
  const sourceRow = page.locator('#telemetry-sources details').first();
  assert.equal(await sourceRow.locator('pre').textContent(), '', 'closed JSON must not be formatted');
  await sourceRow.locator('summary').click();
  await page.waitForFunction(() => document.querySelector('#telemetry-sources pre').textContent.includes('payload'));
  assert.equal(await sourceRow.locator('pre img').count(), 0, 'diagnostic JSON is plain text');
  const sourceNode = await sourceRow.elementHandle();
  await page.waitForTimeout(850);
  assert(await tableRow.evaluate(node => node === document.querySelector('[data-metric="velocityX"]')), 'metric row must survive polling');
  assert(await sourceNode.evaluate(node => node === document.querySelector('#telemetry-sources details') && node.open), 'open diagnostics must survive polling');
  await sourceRow.locator('summary').click(); const closedJson = await sourceRow.locator('pre').textContent();
  await page.waitForTimeout(500);
  assert.equal(await sourceRow.locator('pre').textContent(), closedJson, 'closed JSON is not rewritten');
  shortened = true; await page.waitForFunction(() => document.querySelector('[data-metric="rcInput8"]').dataset.valid === 'false');
  assert.match(await page.locator('[data-metric="rcInput8"] td').nth(1).textContent(), /^1500/);
  await page.locator('#telemetry-search').fill('机体系速度');
  assert.equal(await page.locator('#telemetry-rows tr[data-metric]').count(), 3);
  await page.locator('#telemetry-search').fill('');
  failed = true;
  await page.waitForFunction(() => document.querySelector('#poll-status').textContent.includes('自动重试'));
  assert.match(await page.locator('#attitude-status').textContent(), /最近接收/);
  assert.equal(await page.locator('#flight-horizon').getAttribute('visibility'), 'visible');
  assert.match(await page.locator('#hud-armed').textContent(), /已锁定 · 最近接收/);
  assert.match(await page.locator('#flight-health').textContent(), /上次自检：正常.*当前未确认/, 'history remains visible but cannot claim current health is normal');
  assert.match(await page.locator('#flight-health').textContent(), /最近接收.*0\.0100 \/ 0\.0000 \/ 0\.0200/, 'retained IMU values remain visible separately from self-check history');
  assert.match(await page.locator('#flight-alerts').textContent(), /历史消息 · 非当前警报.*fixture current message/, 'failed requests retain the message only as explicitly labelled history');
  const ageBefore = parseFloat(await page.locator('[data-metric="velocityX"] td').nth(3).textContent());
  await page.waitForTimeout(1100);
  assert(parseFloat(await page.locator('[data-metric="velocityX"] td').nth(3).textContent()) > ageBefore + 0.8, 'retained sample age keeps increasing through failures');
  assert.match(await page.locator('[data-metric="velocityX"] td').nth(1).textContent(), /^0\.00/);
  failed = false; disconnected = true;
  await page.waitForFunction(() => document.querySelector('#connection-badge').textContent.includes('离线') && !document.querySelector('#poll-status').textContent.includes('重试'));
  assert.match(await page.locator('[data-metric="velocityX"] td').nth(1).textContent(), /^0\.00/);
  assert.equal(await page.locator('#flight-horizon').getAttribute('visibility'), 'visible');
  assert.match(await page.locator('[data-metric="rcInput8"] td').nth(2).textContent(), /最近接收/);
  assert.equal(await page.locator('#telemetry-sources details').count(), 1, 'empty disconnect packets retain known source rows');
  await sourceRow.locator('summary').click();
  assert.match(await sourceRow.locator('pre').textContent(), /payload/, 'raw diagnostic data survives an empty packet');
  const executor = page.locator('#flight-execution-diagnostics details').last();
  await executor.locator('summary').click();
  await page.waitForFunction(() => document.querySelector('#flight-execution-diagnostics details:last-child pre').textContent.includes('enabled'));
  assert.match(await executor.locator('pre').textContent(), /"enabled": false/, 'executor history survives without implying an active command');
  assert.equal(await page.locator('[data-metric="batteryCurrent"] td').nth(1).textContent(), '—');
  disconnected = false; rollValue = 3.5;
  await page.waitForFunction(() => document.querySelector('#roll-value').textContent === '3.5°' && document.querySelector('#connection-badge').textContent === '飞控在线');
  const stability = await page.evaluate(async () => {
    let blanks = 0; const states = new Set(), colors = new Set(), banners = new Set();
    for (let i = 0; i < 25; i++) {
      await new Promise(resolve => setTimeout(resolve, 80));
      if (document.querySelector('#roll-value').textContent === '—' || document.querySelector('#flight-horizon').getAttribute('visibility') !== 'visible') blanks++;
      const state = document.querySelector('[data-metric="roll"] td:nth-child(3)');
      states.add(state.textContent); colors.add(getComputedStyle(state).color); banners.add(document.querySelector('#flight-banner').className);
    }
    return { blanks, states: [...states], colors: [...colors], banners: [...banners] };
  });
  assert.equal(stability.blanks, 0, '1s polling must not clear a 500ms-valid attitude between requests');
  assert.deepEqual(stability.states, ['最近接收']); assert.equal(stability.colors.length, 1); assert.equal(stability.banners.length, 1, 'parameter expiry must not flip the connected banner');
  assert.deepEqual(errors, []);
  console.log('PASS fixture: zero/unknown, escaping, stable labels/colors/banner, retained channels/DOM/open state/diagnostics/self-check/alerts, strict current status and uninterrupted HUD.');
  if (process.argv.includes('--live')) {
    await page.unrouteAll({ behavior: 'wait' });
    await page.goto(base + '/marp/uav-details.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#flight-banner').textContent.includes('已接收'), null, { timeout: 15000 });
    await page.waitForTimeout(600);
  }
  const live = await page.evaluate(() => ({ banner: document.querySelector('#flight-banner').textContent, metrics: document.querySelectorAll('#telemetry-rows tr[data-metric]').length,
    groups: document.querySelector('#telemetry-group-filter').options.length - 1, sources: document.querySelectorAll('#telemetry-sources details').length,
    roll: document.querySelector('#roll-value').textContent, pageOverflow: document.documentElement.scrollWidth > innerWidth }));
  assert(!live.pageOverflow); assert.deepEqual(errors, []);
  if (screenshot) await page.screenshot({ path: screenshot, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert(!mobileOverflow, 'mobile page must fit the viewport; wide data stays in the scroll container');
  if (screenshot) await page.screenshot({ path: screenshot.replace(/(\.[^.]+)$/, '-mobile$1'), fullPage: true });
  console.log(JSON.stringify({ live, mobileOverflow, screenshot: screenshot || null, errors }, null, 2));
} finally { await browser.close(); }
