// 可选浏览器回归：使用已安装的 Playwright 和 Edge，独立临时数据，不碰正式记录。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { RecordStore } from '../src/store.js';
import { createUpstreamIntegrations } from '../src/upstream.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const webRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), 'atomori-browser-records-'));
const file = join(directory, 'records.json');
await writeFile(file, JSON.stringify({ findings: [], rechecks: [], events: [] }));
let store, server, url, port;
async function start() {
  store = new RecordStore(file); await store.init();
  server = createServer(createApp({ store, webRoot }));
  await new Promise(done => server.listen(port || 0, '127.0.0.1', done));
  port = server.address().port; url = `http://127.0.0.1:${port}`;
}
async function stop() {
  server.closeAllConnections(); await new Promise(done => server.close(done));
}
const browser = await chromium.launch({ channel: process.env.ATOMORI_BROWSER_CHANNEL || 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let prefix;
const api = async (path, options) => {
  const response = await fetch(url + prefix + path, options);
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};
const patch = status => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
const waitReady = () => page.waitForFunction(() => document.getElementById('finding-count').textContent !== '—');
const close = () => page.locator('#close-dialog').click();
const rowFor = note => page.locator('#dialog-body tbody tr').filter({ has: page.locator('.record-note', { hasText: note }) });
const check = message => console.log('PASS ' + message);
try {
  await start();
  const mission = (await fetch(url + '/api/v1/missions').then(response => response.json())).data[0];
  prefix = '/api/v1/missions/' + mission.id;
  // 加载状态与初始空列表。
  await page.route('**/findings', async route => {
    if (route.request().method() === 'GET') await new Promise(done => setTimeout(done, 250));
    await route.continue();
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  assert.match(await page.locator('#notice-title').textContent(), /加载中/);
  await waitReady();
  await page.locator('[data-nav="records"]').click();
  await page.getByText('暂无疑点记录，可从图传区域标记疑点。').waitFor();
  assert.equal(await page.locator('#acknowledge').isDisabled(), true);
  await close();
  await page.unroute('**/findings');
  check('加载中、空列表、空列表知悉禁用且无脚本错误');

  const note = '浏览器验证 <img src=x onerror=alert(1)> & 法兰下缘';
  let posts = 0;
  await page.route('**/findings', async route => {
    if (route.request().method() === 'POST') { posts++; await new Promise(done => setTimeout(done, 250)); }
    await route.continue();
  });
  await page.locator('#mark-anomaly').click();
  await page.locator('#anomaly-note').fill(note);
  await page.getByRole('button', { name: '保存记录', exact: true }).click();
  await page.getByRole('button', { name: '保存中…', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存中…' }).isDisabled(), true);
  assert.equal(await page.locator('#close-dialog').isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#action-dialog').isVisible(), true);
  await page.locator('#action-dialog').waitFor({ state: 'hidden' });
  assert.equal(posts, 1);
  await page.unroute('**/findings');
  await page.reload(); await waitReady();
  await page.locator('[data-nav="records"]').click();
  await rowFor(note).waitFor();
  assert.equal(await rowFor(note).locator('.record-note').textContent(), note);
  assert.equal(await rowFor(note).locator('.record-note img').count(), 0);
  let finding = (await api('/findings')).body.data.find(item => item.note === note);
  assert.equal(finding.assetId, 'AS-B08-001');
  check('实际点击保存、重复点击防护、刷新持久化、安全文本渲染与正确设施映射');

  await rowFor(note).getByRole('button', { name: '知悉', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.record-note')].some(node => node.parentElement.textContent.includes('已知悉')));
  assert.equal((await api('/findings')).body.data.find(item => item.id === finding.id).status, 'acknowledged');
  await rowFor(note).getByRole('button', { name: '复核完成', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.record-note')].some(node => node.parentElement.textContent.includes('已复核')));
  assert.equal(await rowFor(note).getByRole('button', { name: '复核完成' }).isDisabled(), true);
  assert.equal((await api('/findings/' + finding.id, patch('acknowledged'))).status, 409);
  await close(); await stop(); await start();
  await page.reload(); await waitReady();
  await page.locator('[data-nav="records"]').click(); await rowFor(note).waitFor();
  assert.match(await rowFor(note).textContent(), /已复核/);
  check('知悉、复核落盘，已复核不可退回，重启后端后浏览器仍显示保存状态');

  await rowFor(note).getByRole('button', { name: '加入复查', exact: true }).click();
  await page.getByText('已保存复查记录；不会下发机器人任务', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-recheck]')?.disabled);
  await rowFor(note).getByRole('button', { name: '加入复查', exact: true }).click();
  await page.getByText('该设施已在复查队列，不会重复加入', { exact: true }).waitFor();
  assert.equal((await api('/rechecks')).body.data.length, 1);
  await close(); await page.reload(); await waitReady();
  await page.locator('[data-nav="tasks"]').click();
  await page.locator('[data-cancel-recheck]:not([disabled])').waitFor();
  assert.match(await page.locator('#dialog-body').textContent(), /不会下发机器人任务/);
  await page.locator('[data-cancel-recheck]').click();
  await page.getByText('暂无复查记录。', { exact: true }).waitFor();
  await close(); await page.reload(); await waitReady();
  await page.locator('[data-nav="tasks"]').click(); await page.getByText('暂无复查记录。', { exact: true }).waitFor();
  await close();
  check('复查加入、重复提示、取消及两次页面刷新，动态重绘后按钮有效');

  // 实际断开后端，不能关闭窗口或显示成功；恢复后同一输入重试。
  await page.locator('#mark-anomaly').click(); await page.locator('#anomaly-note').fill('断线重试备注');
  await stop();
  await page.getByRole('button', { name: '保存记录', exact: true }).click();
  await page.locator('#finding-save-error:not([hidden])').waitFor();
  assert.match(await page.locator('#finding-save-error').textContent(), /后端不可用/);
  assert.equal(await page.locator('#anomaly-note').inputValue(), '断线重试备注');
  assert.equal(await page.locator('#action-dialog').isVisible(), true);
  await start(); await page.getByRole('button', { name: '保存记录', exact: true }).click();
  await page.locator('#action-dialog').waitFor({ state: 'hidden' });
  assert.equal((await api('/findings')).body.data.filter(item => item.note === '断线重试备注').length, 1);
  check('真实后端停机时无成功提示、备注保留、服务恢复后重试成功');

  await page.route('**/findings', async route => {
    if (route.request().method() === 'POST') {
      await new Promise(done => setTimeout(done, 8500));
      await route.abort('timedout').catch(() => {});
    } else await route.continue();
  });
  await page.locator('#mark-anomaly').click(); await page.locator('#anomaly-note').fill('超时保留备注');
  await page.getByRole('button', { name: '保存记录', exact: true }).click();
  await page.locator('#finding-save-error:not([hidden])').waitFor();
  assert.match(await page.locator('#finding-save-error').textContent(), /请求超时/);
  assert.equal(await page.locator('#anomaly-note').inputValue(), '超时保留备注');
  assert.equal(await page.getByRole('button', { name: '保存记录', exact: true }).isDisabled(), false);
  await close(); await page.unroute('**/findings');
  check('真实8秒超时后无成功提示，恢复提交按钮且保留备注');

  // 服务端落盘后丢失响应，重试必须使用相同 requestId。
  let dropped = false;
  await page.route('**/findings', async route => {
    if (route.request().method() === 'POST' && !dropped) {
      dropped = true; await route.fetch(); await route.abort('failed');
    } else await route.continue();
  });
  await page.locator('#mark-anomaly').click(); await page.locator('#anomaly-note').fill('丢失响应幂等重试');
  await page.getByRole('button', { name: '保存记录', exact: true }).click();
  await page.locator('#finding-save-error:not([hidden])').waitFor();
  assert.equal(await page.locator('#anomaly-note').inputValue(), '丢失响应幂等重试');
  await page.getByRole('button', { name: '保存记录', exact: true }).click();
  await page.locator('#action-dialog').waitFor({ state: 'hidden' });
  await page.unroute('**/findings');
  assert.equal((await api('/findings')).body.data.filter(item => item.note === '丢失响应幂等重试').length, 1);
  check('丢失保存响应后点击重试不产生重复记录');

  // 过时页面状态收到409后刷新，不做本地降级。
  await page.locator('[data-nav="records"]').click();
  const conflictRow = rowFor('断线重试备注'); await conflictRow.waitFor();
  await conflictRow.getByRole('button', { name: '知悉', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-ack]')].some(button => !button.disabled));
  const stale = (await api('/findings')).body.data.find(item => item.note === '断线重试备注');
  await api('/findings/' + stale.id, patch('reviewed'));
  await conflictRow.getByRole('button', { name: '知悉', exact: true }).click();
  await page.getByText('记录状态已改变，请刷新后重试', { exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.record-note')].find(node => node.textContent === '断线重试备注')?.parentElement.textContent.includes('已复核'));
  await close();
  check('过时状态冲突提示并重新同步服务端状态');

  await page.locator('#pause-task').click();
  await page.locator('[data-nav="records"]').click();
  await page.getByRole('heading', { name: '本地设备操作演示 · 不持久保存' }).waitFor();
  assert.match(await page.locator('#dialog-body').textContent(), /不是设备回执/);
  await close();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-records').click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  for (const key of ['findings', 'rechecks', 'events']) assert.deepEqual(exported[key], persisted[key]);
  assert.equal(exported.events.some(item => item.title === '任务暂停已确认'), false);
  check('实际下载导出逐数组与服务端文件一致，本地设备演示事件未混入');

  await page.locator('[data-business="gas"]').first().click();
  assert.equal(await page.locator('#gas-confirm').isDisabled(), true); await close();
  await page.locator('[data-business="instrument"]').click();
  await page.getByText(/人工核读与测量存储尚未接入/).waitFor(); await close();
  await page.locator('[data-business="acoustic"]').click(); await page.locator('#acoustic-save').click();
  assert.equal(await page.locator('#anomaly-note').inputValue(), ''); await close();
  check('气体样本不可保存，仪表和声学不自动写入样本测量');

  await page.route('**/api/v1/assets', async route => {
    const response = await route.fetch(); const value = await response.json();
    value.data = value.data.filter(item => item.pointId !== 'B-08');
    await route.fulfill({ json: value });
  });
  await page.reload(); await waitReady();
  await page.locator('#mark-anomaly').click(); await page.locator('#anomaly-note').fill('无匹配点位');
  const before = (await api('/findings')).body.data.length;
  await page.getByRole('button', { name: '保存记录', exact: true }).click();
  await page.getByText('该点位未匹配后端设施目录，禁止绑定其他设施', { exact: true }).waitFor();
  assert.equal((await api('/findings')).body.data.length, before);
  await close(); await page.unroute('**/api/v1/assets');
  check('缺失设施点位拒绝提交，未随意绑定其他设施');

  await page.route('**/api/v1/missions', route => route.fulfill({ status: 503, json: { error: { message: '目录暂不可用' } } }));
  await page.reload();
  await page.getByText(/加载失败：目录暂不可用/).first().waitFor();
  assert.equal(await page.locator('#finding-count').textContent(), '—');
  await page.locator('[data-nav="records"]').click();
  assert.equal(await page.locator('.record-note').count(), 0);
  await close(); await page.locator('#mark-anomaly').click();
  await page.locator('#anomaly-note').fill('目录加载失败保留');
  await page.getByRole('button', { name: '保存记录', exact: true }).click();
  await page.locator('#finding-save-error:not([hidden])').waitFor();
  assert.equal(await page.locator('#anomaly-note').inputValue(), '目录加载失败保留');
  await close(); await page.unroute('**/api/v1/missions');
  check('初始化失败不展示本地种子为后端记录，失败备注保留');

  // 分资源加载失败：疑点仍可查看，但事件必须明确失败，不能混入本地演示。
  await page.route('**/events', route => route.fulfill({ status: 503, json: { error: { message: '事件服务暂不可用' } } }));
  await page.reload(); await waitReady();
  await page.locator('[data-nav="records"]').click();
  await page.getByText(/加载失败：事件服务暂不可用/).first().waitFor();
  await rowFor(note).waitFor();
  await close(); await page.unroute('**/events');
  check('独立事件加载失败明确显示，已加载疑点不被样本覆盖');

  // 只读上游使用契约夹具，不连接实机；503验证视频离线提示。
  const liveStore = new RecordStore(join(directory, 'live.json')); await liveStore.init();
  let fixtureLandedState = 'ON_GROUND', fixtureLandedAge = 0.1, fixtureRange = 1.18, fixtureRangeAge = 0.1;
  let fixtureFrameAge = 80, fixtureCaptureFps = 8.3, fixtureVisionOnline = true;
  let fixtureRoll = 12, fixturePitch = 8, fixtureAttitudeAge = 0.1;
  const integrations = createUpstreamIntegrations({ carUrl: 'http://127.0.0.1:1', uavVisionUrl: 'http://127.0.0.1:2', fetchImpl: async (input) => {
    const isCar = input.startsWith('http://127.0.0.1:1/');
    if (!isCar && !fixtureVisionOnline) throw new Error('vision offline');
    if (input.endsWith('/api/status')) return new Response(JSON.stringify(isCar ? { odom: { speed_mps: 0.18 }, topic_ages_s: { odom: 0.1 } } : { sensor: 'ov9281', frame_age_ms: fixtureFrameAge, capture_fps: fixtureCaptureFps, flight: { flight_controller_connected: true, mode: 'GUIDED', armed: false, vehicle_state_age_s: 0.1, landed_state: fixtureLandedState, extended_state_age_s: fixtureLandedAge, telemetry: { roll_deg: fixtureRoll, pitch_deg: fixturePitch, estimated_altitude_m: 9, relative_altitude_m: 4.25, rangefinder_m: fixtureRange, battery_voltage_v: 23.8, battery_remaining_pct: 62 }, telemetry_meta: Object.fromEntries(['roll_deg','pitch_deg','rangefinder_m','relative_altitude_m','battery_voltage_v','battery_remaining_pct'].map(key => [key,{valid:true,age_s:key.endsWith('_deg')?fixtureAttitudeAge:key==='rangefinder_m'?fixtureRangeAge:0.1,unit:key.endsWith('_deg')?'deg':key==='battery_voltage_v'?'V':key==='battery_remaining_pct'?'%':'m'}])) } }), { headers: { 'content-type': 'application/json' } });
    // 相机503用于验证现有离线图传提示；媒体代理正确性由upstream.test验证。
    return new Response('', { status: 503 });
  } });
  const liveServer = createServer(createApp({ store: liveStore, webRoot, integrations }));
  await new Promise(done => liveServer.listen(0, '127.0.0.1', done));
  try {
    const liveUrl = `http://127.0.0.1:${liveServer.address().port}`;
    await page.goto(liveUrl); await waitReady();
    await page.getByText('上游只读 · 本机业务', { exact: true }).waitFor();
    await page.waitForFunction(() => document.getElementById('rover-speed').textContent.includes('0.18') && document.getElementById('uav-height').textContent.includes('1.18'));
    assert.match(await page.locator('#uav-voltage').textContent(), /23.80/);
    await page.waitForFunction(() => document.querySelector('.attitude-block span').textContent === '横滚 12.0°　俯仰 8.0°');
    assert.equal(await page.locator('.attitude-horizon').getAttribute('transform'), 'rotate(-12 70 47) translate(0 5.6)');
    fixtureRoll = -20; fixturePitch = -10;
    await page.waitForFunction(() => document.querySelector('.attitude-block span').textContent === '横滚 -20.0°　俯仰 -10.0°');
    assert.equal(await page.locator('.attitude-horizon').getAttribute('transform'), 'rotate(20 70 47) translate(0 -7)');
    fixtureRoll = 0; fixturePitch = 0;
    await page.waitForFunction(() => document.querySelector('.attitude-block span').textContent === '横滚 0.0°　俯仰 0.0°');
    fixtureAttitudeAge = 0.6;
    await page.waitForFunction(() => document.querySelector('.attitude-block span').textContent === '横滚 —　俯仰 —');
    assert.equal(await page.locator('.attitude-horizon').evaluate(node => getComputedStyle(node).visibility), 'hidden');
    assert.equal(await page.locator('#uav-height').textContent(), '1.18 m');
    fixtureAttitudeAge = 0.1;
    await page.waitForFunction(() => document.querySelector('.attitude-block span').textContent === '横滚 0.0°　俯仰 0.0°');
    assert.equal(await page.locator('.attitude-horizon').evaluate(node => getComputedStyle(node).visibility), 'visible');
    check('原姿态仪跟随正负横滚/俯仰、零角度和恢复；过期值清空并隐藏地平线，不影响测距');
    assert.equal(await page.locator('#uav-height').textContent(), '1.18 m');
    assert.doesNotMatch(await page.locator('#uav-height').locator('..').textContent(), /待校准|已着陆|地面/);
    assert.equal(await page.locator('#drone-state').textContent(), 'GUIDED · 未解锁');
    await page.locator('[data-nav="devices"]').click();
    await page.getByText('飞控 home 高度估计：4.25 m（基准未核验，不作为离地高度）。', {exact:true}).waitFor();
    await close();
    assert.match(await page.locator('#range-value').textContent(), /1.18/);
    fixtureLandedAge = 3; fixtureRange = 0.08;
    await page.waitForFunction(() => document.getElementById('uav-height').textContent.includes('0.08'));
    fixtureLandedAge = 0.1; fixtureLandedState = 'IN_AIR'; fixtureRange = 0.24;
    await page.waitForFunction(() => document.getElementById('uav-height').textContent.includes('0.24'));
    fixtureRangeAge = 1.1;
    await page.waitForFunction(() => document.getElementById('uav-height').textContent === '—');
    assert.equal(await page.locator('#range-value').textContent(), '—');
    fixtureLandedState = 'ON_GROUND'; fixtureRange = 1.18; fixtureRangeAge = 0.1;
    await page.waitForFunction(() => document.getElementById('uav-height').textContent.includes('1.18'));
    assert.equal(await page.locator('#drone-state').textContent(), 'GUIDED · 未解锁');
    check('原仪表布局显示实时下视高度；新样本更新、过期清空，不显示着陆/校准文字，不回退home或强制归零');
    assert.match(await page.locator('.uav-panel .metric-grid .metric:first-child strong').textContent(), /62/);
    for (const device of ['ugv', 'dock', 'uav']) {
      await page.locator(`[data-device="${device}"]`).click();
      assert.equal(await page.locator('.command-panel button:not([data-device]):enabled').count(), 0);
    }
    await page.locator('[data-camera-tab="dock"]').click();
    await page.waitForFunction(() => document.querySelector('.signal-block strong').textContent === '80 ms');
    assert.equal(await page.locator('.signal-block div > span').textContent(), '视觉帧龄');
    assert.match(await page.locator('.signal-block strong').getAttribute('title'), /不包含网络传输和浏览器显示耗时/);
    assert.equal(await page.locator('.signal-block .mini-trend').isVisible(), false);
    fixtureFrameAge = 0;
    await page.waitForFunction(() => document.querySelector('.signal-block strong').textContent === '0 ms');
    for (const age of [-1, 2001, null, '80']) {
      fixtureFrameAge = age;
      await page.waitForFunction(() => document.querySelector('.signal-block strong').textContent === '—');
      fixtureFrameAge = 80;
      await page.waitForFunction(() => document.querySelector('.signal-block strong').textContent === '80 ms');
    }
    fixtureCaptureFps = 0;
    await page.waitForFunction(() => document.querySelector('.signal-block strong').textContent === '—');
    fixtureCaptureFps = 8.3;
    await page.waitForFunction(() => document.querySelector('.signal-block strong').textContent === '80 ms');
    for (const camera of ['uav', 'thermal']) {
      await page.locator(`[data-camera-tab="${camera}"]`).click();
      assert.equal(await page.locator('.signal-block strong').textContent(), '—');
      assert.equal(await page.locator('.signal-block div > span').textContent(), '图传延迟');
    }
    await page.locator('[data-camera-tab="dock"]').click();
    await page.waitForFunction(() => document.querySelector('.signal-block strong').textContent === '80 ms');
    fixtureVisionOnline = false;
    await page.waitForFunction(() => document.querySelector('.signal-block strong').textContent === '—');
    fixtureVisionOnline = true;
    await page.waitForFunction(() => document.querySelector('.signal-block strong').textContent === '80 ms');
    check('下视帧龄实时更新且零值有效；负值/过期/缺失/类型错误/采集无效/视觉离线清空，切换相机不串数据');
    await page.waitForFunction(() => document.getElementById('main-camera').getAttribute('src').includes('ov9281.mjpg?clientId='));
    await page.getByText('图传不可用 · 自动重连', { exact: true }).waitFor();
    const beforeRetry = await page.locator('#main-camera').getAttribute('src');
    await page.waitForFunction(previous => document.getElementById('main-camera').getAttribute('src') !== previous, beforeRetry);
    await page.locator('#mark-anomaly').click(); await page.locator('#anomaly-note').fill('只读模式业务记录');
    await page.getByRole('button', { name: '保存记录', exact: true }).click();
    await page.locator('#action-dialog').waitFor({ state: 'hidden' });
    assert.equal(liveStore.snapshot().findings.some(item => item.note === '只读模式业务记录'), true);
    for (const key of ['instrument', 'acoustic']) {
      await page.locator(`[data-business="${key}"]`).click();
      await page.locator(key === 'instrument' ? '#instrument-note' : '#acoustic-save').click();
      await page.locator('#anomaly-note').fill(key + ' 样本观察备注');
      await page.getByRole('button', { name: '保存记录', exact: true }).click();
      await page.locator('#action-dialog').waitFor({ state: 'hidden' });
      assert.equal(liveStore.snapshot().findings.find(item => item.note === key + ' 样本观察备注').source, key + '_demo_operator');
    }
    check('配置上游后仪表/声学观察备注仍正确标注样本来源');
    assert.equal(await page.locator('.command-panel button:not([data-device]):enabled').count(), 0);
    assert.match(await page.locator('#rover-speed').textContent(), /0.18/);
    assert.equal((await fetch(liveUrl + '/api/v1/commands', { method: 'POST', body: '{}' })).status, 503);
    check('只读遥测、图传切换及离线提示正常，业务写入不覆盖遥测，切换设备后控制全部禁用，真实控制503');
    if (process.env.ATOMORI_SCREENSHOT) await page.screenshot({ path: process.env.ATOMORI_SCREENSHOT, fullPage: true });
  } finally { liveServer.closeAllConnections(); await new Promise(done => liveServer.close(done)); }
  assert.deepEqual(errors, []);
  check('浏览器全过程无脚本错误；实机未验证');
} finally {
  await browser.close();
  if (server?.listening) await stop();
  await rm(directory, { recursive: true, force: true });
}
