import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../marp/live.js', import.meta.url), 'utf8');
const start = source.indexOf('  let liveConnection =');
const end = source.indexOf('  async function monitorCamera()', start);
assert.ok(start >= 0 && end > start, '实际机载视频连接与重连代码存在');

function setup() {
  const nodes = new Map(), retries = new Map();
  let selected = 'dock', timerId = 0, streamId = 0;
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { style: {}, textContent: '',
      getAttribute(name) { return this[name] ?? null; }, removeAttribute(name) { delete this[name]; } });
    return nodes.get(id);
  };
  const context = {
    AtomoriContinuity: { video: () => ({ hasFrame: false, start() {}, hold() {}, clear() {}, dispose() {} }) },
    optionalText() {}, get, latestVision: {}, config: { carConfigured: true, uavVisionConfigured: true, liveOnly: true },
    document: { querySelector(selector) { return selector.startsWith('[data-camera-tab]')
      ? { dataset: { cameraTab: selected } } : get('clock-label'); } },
    crypto: { randomUUID: () => `stream-${++streamId}` },
    setTimeout(callback) { const id = ++timerId; retries.set(id, callback); return id; },
    clearTimeout: id => retries.delete(id), setInterval: () => ++timerId, clearInterval() {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + `
    globalThis.video = { applyUavCamera, retryLiveCamera, state: () => ({ liveConnection, retryTimer }) };
  `, context);
  return { ...context.video, get,
    vision(value) { context.latestVision = value; }, tab(value) { selected = value; },
    runRetry() { const [id, callback] = retries.entries().next().value; retries.delete(id); callback(); }
  };
}

test('OV9281视觉离线时重复刷新不会创建占用连接槽的视频请求', () => {
  const view = setup();
  for (const vision of [{}, { sensor: 'UNKNOWN' }]) {
    view.vision(vision); view.applyUavCamera(); view.applyUavCamera();
    assert.equal(view.get('main-camera').src, undefined);
    assert.equal(view.get('main-camera').style.visibility, 'hidden');
    assert.equal(view.get('camera-quality').textContent, '机载视觉未连接');
    assert.equal(view.state().liveConnection, null);
  }
});

test('视觉状态恢复后建立OV9281视频，重连期间掉线会等待下次恢复', () => {
  const view = setup();
  view.applyUavCamera();
  view.vision({ sensor: 'ov9281' }); view.applyUavCamera();
  const first = view.get('main-camera').src;
  assert.match(first, /\/ov9281\.mjpg\?clientId=/);
  assert.equal(view.get('main-camera').style.visibility, 'visible');
  view.retryLiveCamera();
  view.vision({}); view.runRetry();
  assert.equal(view.get('main-camera').src, undefined);
  assert.equal(view.state().liveConnection, null);
  assert.equal(view.state().retryTimer, null);
  view.vision({ sensor: 'ov9281' }); view.applyUavCamera();
  assert.match(view.get('main-camera').src, /\/ov9281\.mjpg\?clientId=/);
  assert.notEqual(view.get('main-camera').src, first);
});

test('A8视频及其既有重连不依赖OV9281视觉状态', () => {
  const view = setup();
  view.tab('uav'); view.applyUavCamera();
  const first = view.get('main-camera').src;
  assert.match(first, /\/a8\.mjpg\?clientId=/);
  view.retryLiveCamera(); view.runRetry();
  assert.match(view.get('main-camera').src, /\/a8\.mjpg\?clientId=/);
  assert.notEqual(view.get('main-camera').src, first);
  assert.equal(view.state().liveConnection.cameraId, 'a8.mjpg');
});

test('A8持续收到字节但完整帧停更仍重连，首次连接保留启动窗口', async () => {
  let health = { active: true, idleAgeMs: 0, frameReceivedAtMs: 1000 }, retries = 0;
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); };
  const context = vm.createContext({ Date: { now: () => 5000 }, get, retryTimer: null,
    liveConnection: { cameraId: 'a8.mjpg', clientId: 'a8-test', startedAt: 4000 },
    updateCameraClock() {}, retryLiveCamera() { retries++; },
    AtomoriApi: { request: async () => ({ data: { timingCalibration: {}, streamHealth: [{ ...health, clientId: 'a8-test', cameraId: 'a8.mjpg' }] } }) }
  });
  const monitor = source.slice(source.indexOf('  async function monitorCamera()'), source.indexOf("  if (config.uavVisionConfigured) document.querySelector"));
  vm.runInContext(monitor, context);
  await vm.runInContext('monitorCamera()', context);
  assert.equal(retries, 1);
  health = { active: true, idleAgeMs: 0 };
  await vm.runInContext('monitorCamera()', context);
  assert.equal(retries, 1, '尚无首帧时不以3秒打断冷启动');
});
