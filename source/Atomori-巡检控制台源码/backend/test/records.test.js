import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { missionId } from '../src/catalog.js';
import { RecordStore } from '../src/store.js';

const webRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const prefix = `/api/v1/missions/${missionId}`;
const input = { assetId: 'AS-B08-001', source: 'operator', note: '人工备注 <img src=x onerror=alert(1)>' };

async function fixture(t, empty = false) {
  const directory = await mkdtemp(join(tmpdir(), 'atomori-records-'));
  const file = join(directory, 'records.json');
  if (empty) await writeFile(file, JSON.stringify({ findings: [], rechecks: [], events: [] }));
  const store = new RecordStore(file);
  await store.init();
  const server = createServer(createApp({ store, webRoot }));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(done => server.close(done));
    await rm(directory, { recursive: true, force: true });
  });
  return { store, file, base, request: (path, method = 'GET', value) => request(base, path, method, value) };
}

async function request(base, path, method = 'GET', value) {
  const response = await fetch(`${base}${prefix}${path}`, {
    method,
    ...(value === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  });
  return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
}

test('空业务列表、新增刷新、知悉、复核、冲突与关联事件', async t => {
  const app = await fixture(t, true);
  for (const name of ['findings', 'rechecks', 'events']) {
    const response = await app.request(`/${name}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  }
  const created = await app.request('/findings', 'POST', input);
  assert.equal(created.status, 201);
  const finding = created.body.data;
  assert.equal(finding.status, 'pending');
  assert.equal(finding.note, input.note);
  const refreshed = (await app.request('/findings')).body.data;
  assert.equal(refreshed[0].id, finding.id);
  const acknowledged = await app.request(`/findings/${finding.id}`, 'PATCH', { status: 'acknowledged', expectedStatus: 'pending' });
  assert.equal(acknowledged.status, 200);
  assert.equal(acknowledged.body.data.status, 'acknowledged');
  const stale = await app.request(`/findings/${finding.id}`, 'PATCH', { status: 'reviewed', expectedStatus: 'pending' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'STATUS_CONFLICT');
  const reviewed = await app.request(`/findings/${finding.id}`, 'PATCH', { status: 'reviewed', expectedStatus: 'acknowledged' });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.data.status, 'reviewed');
  const unchanged = await app.request(`/findings/${finding.id}`, 'PATCH', { status: 'reviewed' });
  assert.equal(unchanged.status, 200);
  const rejected = await app.request(`/findings/${finding.id}`, 'PATCH', { status: 'acknowledged' });
  assert.equal(rejected.status, 409);
  assert.match(rejected.body.error.message, /不可退回/);
  assert.equal((await app.request('/findings')).body.data[0].status, 'reviewed');
  const events = (await app.request('/events')).body.data;
  assert.equal(events.length, 3);
  assert.ok(events.every(item => item.findingId === finding.id && item.assetId === input.assetId && item.type === 'operator'));
  const saved = JSON.parse(await readFile(app.file, 'utf8'));
  assert.equal(saved.findings[0].status, 'reviewed');
});

test('并发重复提交只新增一条，同 requestId 不同内容冲突，旧请求兼容', async t => {
  const app = await fixture(t, true);
  const payload = { ...input, requestId: 'click-1' };
  const responses = await Promise.all(Array.from({ length: 6 }, () => app.request('/findings', 'POST', payload)));
  assert.equal(responses.filter(item => item.status === 201).length, 1);
  assert.equal(responses.filter(item => item.status === 200).length, 5);
  assert.equal(new Set(responses.map(item => item.body.data.id)).size, 1);
  const conflict = await app.request('/findings', 'POST', { ...payload, note: '不同备注' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await app.request('/findings')).body.data.length, 1);
  assert.equal((await app.request('/events')).body.data.length, 1);
  assert.equal((await app.request('/findings', 'POST', input)).status, 201);
});

test('并发状态更新使用 expectedStatus 防止过时页面覆盖', async t => {
  const app = await fixture(t, true);
  const finding = (await app.request('/findings', 'POST', input)).body.data;
  const updates = await Promise.all(['acknowledged', 'reviewed'].map(status => app.request(`/findings/${finding.id}`, 'PATCH', { status, expectedStatus: 'pending' })));
  assert.equal(updates.filter(item => item.status === 200).length, 1);
  assert.equal(updates.filter(item => item.status === 409 && item.body.error.code === 'STATUS_CONFLICT').length, 1);
  assert.equal((await app.request('/events')).body.data.length, 2);
});

test('并发加入复查按设施去重，取消刷新正确，导出与落盘记录一致', async t => {
  const app = await fixture(t, true);
  const additions = await Promise.all(Array.from({ length: 4 }, () => app.request('/rechecks', 'POST', { assetId: input.assetId })));
  assert.equal(additions.filter(item => item.status === 201).length, 1);
  assert.ok(additions.filter(item => item.status === 409).every(item => item.body.error.code === 'RECHECK_EXISTS'));
  const recheck = (await app.request('/rechecks')).body.data[0];
  assert.equal((await app.request(`/rechecks/${recheck.id}`, 'DELETE')).status, 204);
  assert.equal((await app.request(`/rechecks/${recheck.id}`, 'DELETE')).status, 404);
  assert.deepEqual((await app.request('/rechecks')).body.data, []);
  const exportResponse = await app.request('/export');
  assert.match(exportResponse.headers.get('content-disposition'), /attachment/);
  assert.equal(exportResponse.body.mode, 'demo');
  const saved = JSON.parse(await readFile(app.file, 'utf8'));
  for (const name of ['findings', 'rechecks', 'events']) assert.deepEqual(exportResponse.body[name], saved[name]);
  assert.ok(saved.events.every(item => item.assetId === input.assetId && item.recheckId === recheck.id));
  assert.match(saved.events.find(item => item.title === '复查队列已加入').detail, /不下发机器人任务/);
});

test('无效设施和输入被拒绝，不保存测量或未知设施', async t => {
  const app = await fixture(t, true);
  for (const invalid of [
    { ...input, assetId: 'B-10' }, { ...input, note: '' }, { ...input, note: 'x'.repeat(301) },
    { ...input, source: '' }, { ...input, requestId: '' }, { ...input, requestId: 123 }
  ]) assert.equal((await app.request('/findings', 'POST', invalid)).status, 400);
  assert.equal((await app.request('/rechecks', 'POST', { assetId: 'unknown' })).status, 400);
  assert.equal((await app.request('/findings/missing', 'PATCH', { status: 'reviewed' })).status, 404);
  assert.equal((await app.request('/findings/missing', 'PATCH', { status: 'pending' })).status, 400);
  assert.equal((await app.request('/findings/missing', 'PATCH', { status: 'reviewed', expectedStatus: 'unknown' })).status, 400);
  assert.deepEqual(app.store.snapshot(), { findings: [], rechecks: [], events: [] });
});

test('保存进行中不发布快照；保存失败回滚，后续写入仍可恢复', async t => {
  const app = await fixture(t, true);
  const originalSave = app.store.save.bind(app.store);
  let release;
  let entered;
  const started = new Promise(done => { entered = done; });
  app.store.save = async data => {
    entered();
    await new Promise(done => { release = done; });
    await originalSave(data);
  };
  const pending = app.request('/findings', 'POST', { ...input, requestId: 'waiting' });
  await started;
  assert.deepEqual((await app.request('/findings')).body.data, []);
  assert.deepEqual(JSON.parse(await readFile(app.file, 'utf8')).findings, []);
  release();
  assert.equal((await pending).status, 201);
  const previous = app.store.snapshot();
  app.store.save = async () => { throw Object.assign(new Error('测试存储失败'), { status: 503, code: 'STORAGE_UNAVAILABLE' }); };
  const failed = await app.request('/findings', 'POST', { ...input, requestId: 'failed' });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error.code, 'STORAGE_UNAVAILABLE');
  assert.deepEqual(app.store.snapshot(), previous);
  assert.deepEqual(JSON.parse(await readFile(app.file, 'utf8')), previous);
  app.store.save = originalSave;
  assert.equal((await app.request('/findings', 'POST', { ...input, requestId: 'failed' })).status, 201);
});

async function startBackend(file) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: join(webRoot, 'backend'),
    env: { ...process.env, PORT: '0', ATOMORI_DATA_FILE: file, ATOMORI_CAR_URL: '', ATOMORI_UAV_VISION_URL: '', ATOMORI_UAV_FLIGHT_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let output = '';
  const base = await new Promise((done, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('后端启动超时')); }, 10_000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); reject(new Error(`后端提前退出：${code} ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); done(match[0]); }
    });
  });
  return { base, stop: async () => { if (child.exitCode !== null) return; const exited = once(child, 'exit'); child.kill(); await exited; } };
}

test('实际后端进程重启后疑点、状态、复查与幂等键均保留', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atomori-restart-'));
  const file = join(directory, 'records.json');
  await writeFile(file, JSON.stringify({ findings: [], rechecks: [], events: [] }));
  let backend;
  t.after(async () => { await backend?.stop(); await rm(directory, { recursive: true, force: true }); });
  backend = await startBackend(file);
  const payload = { ...input, requestId: 'restart-1' };
  const finding = (await request(backend.base, '/findings', 'POST', payload)).body.data;
  assert.equal((await request(backend.base, `/findings/${finding.id}`, 'PATCH', { status: 'acknowledged' })).status, 200);
  const recheck = (await request(backend.base, '/rechecks', 'POST', { assetId: input.assetId })).body.data;
  await backend.stop();
  backend = await startBackend(file);
  const persisted = (await request(backend.base, '/findings')).body.data[0];
  assert.equal(persisted.id, finding.id);
  assert.equal(persisted.status, 'acknowledged');
  assert.equal((await request(backend.base, '/findings', 'POST', payload)).status, 200);
  assert.equal((await request(backend.base, '/rechecks')).body.data[0].id, recheck.id);
  assert.equal((await request(backend.base, `/findings/${finding.id}`, 'PATCH', { status: 'reviewed' })).status, 200);
  assert.equal((await request(backend.base, `/rechecks/${recheck.id}`, 'DELETE')).status, 204);
  await backend.stop();
  backend = await startBackend(file);
  assert.equal((await request(backend.base, '/findings')).body.data[0].status, 'reviewed');
  assert.deepEqual((await request(backend.base, '/rechecks')).body.data, []);
  const exported = (await request(backend.base, '/export')).body;
  const saved = JSON.parse(await readFile(file, 'utf8'));
  for (const name of ['findings', 'rechecks', 'events']) assert.deepEqual(exported[name], saved[name]);
});
