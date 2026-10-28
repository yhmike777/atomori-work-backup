import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeUgvStatus } from '../src/ugv.js';

const context = { window: {} };
vm.runInNewContext(readFileSync(new URL('../../marp/ugv-view.js', import.meta.url), 'utf8'), context);
const { cameraState, mapState } = context.window.AtomoriUgvView;
test('短暂失效显示有明确标记的上次读数，不为旧值续期', () => {
  const display = context.window.AtomoriUgvView.createMetricDisplay();
  const data = normalizeUgvStatus({ topic_ages_s: { odom: 0 }, odom: { speed_mps: 0 },
    environment: { age_s: 0, available: true, stale: false, temperature_c: 32, humidity_percent: 30 } });
  assert.equal(display(data, 'speed', 0, 0).value, 0);
  assert.equal(display(data, 'temperature', 0, 0).value, 32);
  assert.equal(display(data, 'speed', 2.5, 2500).retained, true);
  const failed = { ...data, receivedAt: 'new', metrics: {} };
  assert.equal(display(failed, 'speed', 0, 4000).retained, true);
  assert.equal(display(failed, 'speed', 0, 5100).value, 0);
  const held = display(failed, 'temperature', 0, 37000);
  assert.equal(held.value, 32);
  assert.equal(held.retained, true);
  assert.equal(held.ageS, 37);
  assert.equal(display(failed, 'temperature', 0, 61000).value, 32);
  assert.equal(display(failed, 'temperature', 0, 61000).ageS, 61);
  assert.equal(data.metrics.speed.value, 0, '不改写实时遥测契约');
});

test('首次无样本保持空白，失联和网关重启保留只读历史，明确换源时清空', () => {
  const display = context.window.AtomoriUgvView.createMetricDisplay();
  const data = { ...normalizeUgvStatus({ gateway: { uptime_s: 100 }, topic_ages_s: { odom: 0 }, odom: { speed_mps: 0.3 } }), sourceIdentity: 'car-a' };
  assert.equal(display({ ...data, metrics: {} }, 'speed', 0, 0).value, null);
  display(data, 'speed', 0, 0);
  assert.equal(display(data, 'speed', 3.1, 3100).retained, true);
  assert.equal(display({ ...data, receivedAt: 'reconnected', metrics: {} }, 'speed', 0, 3500).value, 0.3);
  display(data, 'speed', 0, 4000);
  assert.equal(display({ ...data, receivedAt: 'rebooted', gateway: { uptime_s: 1 }, metrics: {} }, 'speed', 0, 4500).value, 0.3);
  assert.equal(display({ sourceIdentity: 'car-b' }, 'speed', 0, 4500).value, null);
});
const sample = (changes = {}, transportS = 0) => normalizeUgvStatus({
  camera: { ready: true, age_s: 0 }, camera_rear: { ready: true, age_s: 0.2 },
  camera_top: { ready: true }, map: { age_s: 0.1 }, ...changes
}, transportS);

test('实时图传同时要求车辆状态、相机 ready 与独立帧龄，零帧龄有效', () => {
  assert.equal(cameraState(sample(), 'front', 0).valid, true);
  assert.equal(cameraState(sample(), 'rear', 0).valid, true);
  assert.equal(cameraState(sample(), 'top', 0).valid, false);
  assert.match(cameraState(sample(), 'top', 0).reason, /采样年龄未知/);
  assert.equal(cameraState({}, 'front', 0).valid, false);
  for (const camera of [
    { ready: false, age_s: 0 }, { ready: true, age_s: 3.1 },
    { ready: true, age_s: null }, { ready: true, age_s: -1 }, { ready: true, age_s: '0' }
  ]) assert.equal(cameraState(sample({ camera }), 'front', 0).valid, false);
});

test('HTTP 耗时与页面等待累计后使旧相机帧失效，快照更新不能使旧帧龄复活', () => {
  const data = sample({ camera: { ready: true, age_s: 2.5 } }, 0.2);
  assert.equal(cameraState(data, 'front', 0.2).valid, true);
  assert.equal(cameraState(data, 'front', 0.4).valid, false);
  assert.equal(cameraState(sample(), 'front', 3.1).valid, false);
  assert.equal(cameraState(sample({ camera: { ready: true, age_s: 10 } }), 'front', 0).valid, false);
});

test('当前地图仅采用新鲜采样，保存地图可用性不能证明当前栅格有效', () => {
  assert.equal(mapState(sample({ map: { age_s: 0 } }), 0).valid, true);
  assert.equal(mapState(sample({ map: { age_s: 5.9 } }), 0.2).valid, false);
  for (const map of [{}, { age_s: null }, { age_s: -1 }, { age_s: '0' }, { age_s: 7 }]) {
    assert.equal(mapState(sample({ map }), 0).valid, false);
  }
  assert.equal(mapState(sample(), 3.1).valid, false);
  assert.equal(mapState({ map: { age_s: 0 } }, 0).valid, false);
});
