import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../../marp/records.js', import.meta.url), 'utf8');
function setup() {
  const dialog = { open: false };
  const timers = [];
  const calls = [];
  let fail = false;
  const replies = {
    '/missions': [{ id: 'M-1', mode: 'demo' }], '/assets': [],
    '/missions/M-1/findings': [
      { id: 'seed', source: 'A8 Mini' }, { id: 'sample', source: 'ugv_demo_operator' },
      { id: 'manual', source: 'ugv_source_unconfirmed_operator' }
    ],
    '/missions/M-1/events': [{ id: 'seed', type: 'demo' }, { id: 'saved', type: 'finding.created' }],
    '/missions/M-1/rechecks': []
  };
  const context = vm.createContext({
    document: { body: { classList: { contains: () => true } }, hidden: false, dispatchEvent() {} },
    window: { addEventListener() {} }, CustomEvent: class {},
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {},
    $: () => dialog, AtomoriApi: { message: e => e.message, async request(path) {
      calls.push(path); if (fail) throw new Error('offline'); return { data: replies[path] };
    } }
  });
  vm.runInContext(code, context);
  return { context, calls, dialog, timers, offline: () => { fail = true; }, run: js => vm.runInContext(js, context) };
}
test('实时记录排除演示种子，自动刷新从后端读取新增人工事件', async () => {
  const app = setup();
  await app.run('loadRecords()');
  assert.equal(app.run('recordState.findings.map(x => x.id).join()'), 'manual');
  assert.equal(app.run('recordState.events.map(x => x.id).join()'), 'saved');
  const count = app.calls.length;
  await app.run('refreshRecordSummary()');
  assert.equal(app.calls.length, count + 3);
  assert.equal(app.run('recordState.status.events'), 'ready');
});
test('自动刷新跳过正在编辑/保存的界面，失败后标记快照不可用', async () => {
  const app = setup(); await app.run('loadRecords()'); const count = app.calls.length;
  app.dialog.open = true; await app.run('refreshRecordSummary()'); assert.equal(app.calls.length, count);
  app.dialog.open = false; app.run('recordState.submitting = true');
  await app.run('refreshRecordSummary()'); assert.equal(app.calls.length, count);
  app.run('recordState.submitting = false'); app.offline();
  await app.run('refreshRecordSummary()');
  assert.equal(app.run('recordState.status.findings'), 'error');
  assert.equal(app.run('recordState.status.events'), 'error');
});

test('通用 operator 来源不丢失，导出排除样本与静态任务指标', () => {
  const app = setup();
  assert.equal(app.run("isOperatorFinding({ source: 'operator' })"), true);
  const result = JSON.parse(app.run(`JSON.stringify(operatorExport({ mission: {id:'M-1',mode:'demo',completedPointCount:7}, findings:[{id:'seed',source:'A8 Mini'},{id:'manual',source:'operator'}],events:[{type:'demo'},{type:'finding.created'}] }))`));
  assert.equal(result.findings.length, 1);
  assert.equal(result.events.length, 1);
  assert.equal(result.mode, 'operator-records');
  assert.equal(result.mission, undefined);
});
