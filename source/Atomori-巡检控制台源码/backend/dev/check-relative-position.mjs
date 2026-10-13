// 隔离业务记录，核验后端归一化到前端显示、失效清空与恢复的完整链路。
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
const directory = await mkdtemp(join(tmpdir(), 'atomori-relative-'));
const store = new RecordStore(join(directory, 'records.json')); await store.init();
const raw = { sensor: 'ov9281', found: true, quality_passed: true, tag_id: 1,
  capture_age_ms: 100, frame_age_ms: 30, capture_fps: 9,
  orientation: { valid: true, frame: 'BODY_FRD', source: 'PNP_TAG_TO_PAD_TO_BODY',
    position_body_frd_m: [0.5, -0.25, 1.2], pad_heading_body_deg: -30 } };
let blocked = false, release;
const integrations = createUpstreamIntegrations({ uavVisionUrl: 'http://vision.local', fetchImpl: async input => {
  if (!input.endsWith('/api/status')) return new Response('', { status: 503 });
  if (blocked) await new Promise(done => { release = done; });
  return new Response(JSON.stringify(raw));
} });
const server = createServer(createApp({ store, integrations, webRoot: resolve(fileURLToPath(new URL('../../', import.meta.url))) }));
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('relative-x').textContent.includes('+0.500'));
  assert.equal(await page.locator('#relative-y').textContent(), '-0.250 m');
  assert.equal(await page.locator('#relative-z').textContent(), '+1.200 m');
  assert.equal(await page.locator('#relative-yaw').textContent(), '-30.0 °');
  assert.equal(await page.locator('#drone-state').textContent(), '飞控离线/过期');
  assert.ok(Number(await page.locator('#relative-drone').getAttribute('cx')) < 43);
  assert.ok(Number(await page.locator('#relative-drone').getAttribute('cy')) < 40);
  console.log('PASS 机载相对位姿和航向同步，示意图方向正确，飞控无数据不阻塞视觉');
  raw.orientation.position_body_frd_m = [0, 0, 0.1]; raw.orientation.pad_heading_body_deg = 0;
  await page.waitForFunction(() => document.getElementById('relative-x').textContent === '0.000 m');
  assert.equal(await page.locator('#relative-yaw').textContent(), '0.0 °');
  raw.found = false;
  await page.waitForFunction(() => document.getElementById('vision-state').textContent === '未识别标签');
  for (const id of ['relative-x', 'relative-y', 'relative-z', 'relative-yaw']) assert.equal(await page.locator('#' + id).textContent(), '—');
  assert.equal(await page.locator('#relative-drone').evaluate(el => getComputedStyle(el).visibility), 'hidden');
  raw.found = true; raw.quality_passed = false;
  await page.waitForFunction(() => document.getElementById('vision-state').textContent === '视觉质量未通过');
  raw.quality_passed = true; raw.capture_age_ms = 3000;
  await page.waitForFunction(() => document.getElementById('vision-state').textContent === '视觉数据过期');
  raw.capture_age_ms = 100;
  await page.waitForFunction(() => document.getElementById('relative-z').textContent === '+0.100 m');
  console.log('PASS 零值有效，丢标签、质量拒绝、过期清空并自动恢复');
  blocked = true;
  await page.waitForFunction(() => document.getElementById('vision-state').textContent === '视觉数据过期');
  assert.equal(await page.locator('#relative-x').textContent(), '—');
  blocked = false; release?.();
  await page.waitForFunction(() => document.getElementById('relative-x').textContent === '0.000 m');
  assert.deepEqual(errors, []);
  console.log('PASS 请求挂起时旧位姿清空，恢复后更新，浏览器无脚本错误');
} finally {
  blocked = false; release?.();
  await browser.close(); server.closeAllConnections();
  await new Promise(done => server.close(done));
  await rm(directory, { recursive: true, force: true });
}
