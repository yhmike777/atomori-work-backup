import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { missionId } from '../src/catalog.js';
import { RecordStore } from '../src/store.js';

test('演示记录持久化，设备接口明确拒绝伪造实时数据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atomori-api-'));
  const file = join(directory, 'records.json');
  const store = new RecordStore(file);
  await store.init();
  const webRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const server = createServer(createApp({ store, webRoot }));
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const base = `http://127.0.0.1:${server.address().port}`;
  const prefix = `/api/v1/missions/${missionId}`;
  try {
    const health = await fetch(`${base}/api/v1/health`).then(r => r.json());
    assert.equal(health.mode, 'demo');
    const html = await fetch(base);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /空地协同巡检平台/);
    assert.equal((await fetch(`${base}/backend/src/server.js`)).status, 404);
    const telemetry = await fetch(`${base}/api/v1/devices/UAV-01/telemetry`);
    assert.equal(telemetry.status, 503);
    assert.equal((await telemetry.json()).error.code, 'ADAPTER_NOT_CONFIGURED');
    const command = await fetch(`${base}/api/v1/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(command.status, 503);
    const findingResponse = await fetch(`${base}${prefix}/findings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetId: 'AS-B08-001', source: 'operator', note: '测试记录' }) });
    assert.equal(findingResponse.status, 201);
    const finding = (await findingResponse.json()).data;
    const update = await fetch(`${base}${prefix}/findings/${finding.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'reviewed' }) });
    assert.equal(update.status, 200);
    const recheckResponse = await fetch(`${base}${prefix}/rechecks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetId: 'AS-B08-001' }) });
    assert.equal(recheckResponse.status, 201);
    const recheck = (await recheckResponse.json()).data;
    assert.equal((await fetch(`${base}${prefix}/rechecks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetId: 'AS-B08-001' }) })).status, 409);
    assert.equal((await fetch(`${base}${prefix}/rechecks/${recheck.id}`, { method: 'DELETE' })).status, 204);
    const reopened = new RecordStore(file);
    await reopened.init();
    assert.equal(reopened.snapshot().findings.find(item => item.id === finding.id).status, 'reviewed');
    assert.equal(reopened.snapshot().rechecks.length, 0);
  } finally {
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  }
});
