import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const live = readFileSync(new URL('../../marp/live.js', import.meta.url), 'utf8');
const start = live.indexOf('  let groundCameraId =');
const end = live.indexOf('  function openScan()', start);
assert.ok(start >= 0 && end > start, '实际地面视频模块的测试入口存在');
const code = live.slice(start, end);
const sampleStart = live.indexOf('  function applyUgv(');
const sampleEnd = live.indexOf('  const ugvAge =', sampleStart);
assert.ok(sampleStart >= 0 && sampleEnd > sampleStart, '实际UGV样本计时入口存在');
const sampleCode = live.slice(sampleStart, sampleEnd);
const EPOCH = 1700000000000;
const timestamp = elapsedMs => new Date(EPOCH + elapsedMs).toISOString();
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

function setup() {
  let now = 0, uuid = 0, blobId = 0, bytes = 0;
  const elements = new Map(), selectors = new Map(), listeners = new Map();
  const imageRequests = [], healthRequests = [], healthQueue = [], decodes = [], revoked = new Set();
  let holdDecode = false;
  function element(id = '') {
    const events = new Map(), classes = new Set();
    let identity = id;
    const node = {
      style: {}, dataset: {}, textContent: '', hidden: false, open: false,
      get id() { return identity; },
      set id(value) { identity = value; elements.set(value, node); },
      removeAttribute(name) { delete node[name]; }, setAttribute(name, value) { node[name] = value; },
      append() {}, before() {},
      addEventListener(name, callback) { events.set(name, callback); },
      dispatch(name) { events.get(name)?.(); },
      classList: { contains: name => classes.has(name), toggle(name, on) { on ? classes.add(name) : classes.delete(name); } }
    };
    if (id) elements.set(id, node);
    return node;
  }
  const get = id => elements.get(id) || element(id);
  get('ground-camera').parentElement = element();
  const document = {
    hidden: false,
    querySelector(selector) { if (!selectors.has(selector)) selectors.set(selector, element()); return selectors.get(selector); },
    querySelectorAll: () => [], createElement: () => element(),
    addEventListener(name, callback) { listeners.set(name, callback); }
  };
  const signalResult = (pending, signal) => {
    if (signal) {
      const reject = () => pending.reject(new Error('AbortError'));
      if (signal.aborted) reject(); else signal.addEventListener('abort', reject, { once: true });
    }
    return pending.promise;
  };
  const health = options => {
    const pending = healthQueue.shift();
    const request = { options, signal: options?.signal, pending };
    healthRequests.push(request);
    if (pending) return signalResult(pending, options?.signal);
    const clientId = new URL(get('ground-camera').src, 'http://localhost').searchParams.get('clientId');
    return Promise.resolve({ data: { streamHealth: [{ clientId, cameraId: 'front.mjpg', active: true,
      lastDataAt: timestamp(now), idleAgeMs: 0, receivedBytes: bytes += 100 }] } });
  };
  const jpegResponse = (ok = true) => ({ ok, headers: { get: () => 'image/jpeg' }, blob: async () => ({}) });
  const context = {
    AtomoriContinuity: { video: () => ({ hasFrame: false, start() {}, hold() {}, clear() {}, dispose() {} }) },
    window: {}, document, get, config: { carConfigured: true }, stopped: false,
    performance: { now: () => now },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [EPOCH + now])); }
      static now() { return EPOCH + now; }
    },
    crypto: { randomUUID: () => `id-${++uuid}` },
    AbortController, AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: () => new AbortController().signal },
    AtomoriApi: { request(path, options) { assert.equal(path, '/devices/UGV-01/streams'); return health(options); } },
    fetch(url, options) {
      if (url.includes('/streams')) return health(options).then(data => ({ ok: true, json: async () => data }));
      const pending = deferred();
      const request = { url, options, signal: options?.signal, pending, respond: ok => pending.resolve(jpegResponse(ok)) };
      imageRequests.push(request);
      return signalResult(pending, options?.signal);
    },
    URL: { createObjectURL: () => `blob:frame-${++blobId}`, revokeObjectURL: value => revoked.add(value) },
    Image: class { decode() { if (!holdDecode) return Promise.resolve(); const pending = deferred(); decodes.push(pending); return pending.promise; } },
    latestUgv: {}, ugvReceivedAt: 0, carMapName: 'current', referenceMapUrl: null, carMapObjectUrl: null,
    refreshMap: async () => {}, openUgvDetails() {}, openDialog() {}, renderUgv() {},
    intercept: (node, callback) => { node.onclick = callback; }
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../../marp/ugv-view.js', import.meta.url), 'utf8'), context);
  context.AtomoriUgvView = context.window.AtomoriUgvView;
  vm.runInContext(sampleCode + code + '\n globalThis.video = { refreshGroundCamera, renderGroundFreshness, selectGroundCamera, setGroundMode };', context);
  function telemetry(changes = {}) {
    context.latestUgv = { receivedAt: 'fresh', snapshotAgeS: 0, snapshotMaxAgeS: 3,
      camera: { ready: true, age_s: 0 }, cameraRear: { ready: true, age_s: 0 }, cameraTop: { ready: true, age_s: 0 }, ...changes };
    context.ugvReceivedAt = now;
  }
  telemetry();
  return { ...context.video, get, document, imageRequests, healthRequests, decodes, revoked,
    telemetry, clock(value) { now = value; }, holdDecode(value = true) { holdDecode = value; },
    applyTelemetry: (payload, requestedAt) => context.applyUgv(payload, requestedAt),
    cameraState: () => context.AtomoriUgvView.cameraState(context.latestUgv, 'front', (now - context.ugvReceivedAt) / 1000),
    queueHealth() { const pending = deferred(); healthQueue.push(pending); return pending; },
    hide(value) { document.hidden = value; listeners.get('visibilitychange')?.(); }
  };
}

test('前视保持同一条front.mjpg连接，不进行JPEG逐帧轮询', async () => {
  const view = setup();
  await view.refreshGroundCamera();
  const src = view.get('ground-camera').src;
  assert.match(src, /\/front\.mjpg\?clientId=/);
  assert.equal(view.imageRequests.length, 0);
  for (const time of [100, 500, 1100, 2200]) {
    view.clock(time); view.telemetry();
    await view.refreshGroundCamera();
    assert.equal(view.get('ground-camera').src, src);
  }
  assert.equal(view.imageRequests.length, 0);
});

test('健康检查短暂失败保留仍在新鲜期内的前视流', async () => {
  const view = setup();
  await view.refreshGroundCamera();
  const src = view.get('ground-camera').src;
  view.clock(1000); view.telemetry();
  const failure = view.queueHealth();
  const request = view.refreshGroundCamera();
  failure.reject(new Error('temporary health failure'));
  await request;
  assert.equal(view.get('ground-camera').src, src);
  assert.equal(view.get('ground-camera').style.visibility, 'visible');
});

test('已建立前视流3秒未收到新数据会清空，退避后重新连接', async () => {
  const view = setup();
  await view.refreshGroundCamera();
  const first = view.get('ground-camera').src;
  view.clock(3001); view.telemetry(); view.renderGroundFreshness();
  assert.equal(view.get('ground-camera').src, undefined);
  assert.equal(view.get('ground-camera').style.visibility, 'hidden');
  view.clock(3500); await view.refreshGroundCamera();
  assert.equal(view.get('ground-camera').src, undefined);
  view.clock(4002); view.telemetry(); await view.refreshGroundCamera();
  assert.match(view.get('ground-camera').src, /front\.mjpg/);
  assert.notEqual(view.get('ground-camera').src, first);
});

test('健康接口重复旧字节计数不能使停滞视频重新变新鲜', async () => {
  const view = setup();
  await view.refreshGroundCamera();
  const clientId = new URL(view.get('ground-camera').src, 'http://localhost').searchParams.get('clientId');
  for (const time of [1000, 2000, 3001]) {
    view.clock(time); view.telemetry();
    const pending = view.queueHealth(), work = view.refreshGroundCamera();
    pending.resolve({ data: { streamHealth: [{ clientId, cameraId: 'front.mjpg', active: true,
      lastDataAt: timestamp(time), idleAgeMs: 0, receivedBytes: 100 }] } });
    await work;
  }
  assert.equal(view.get('ground-camera').src, undefined);
});

test('尚未建立前视流时，过期设备快照或相机采样不能触发连接', async () => {
  for (const staleSnapshot of [true, false]) {
    const view = setup();
    view.clock(3001);
    if (!staleSnapshot) view.telemetry({ camera: { ready: true, age_s: 3.1 } });
    view.renderGroundFreshness();
    await view.refreshGroundCamera();
    assert.equal(view.get('ground-camera').src, undefined);
    assert.equal(view.healthRequests.length, 0);
    view.telemetry(); await view.refreshGroundCamera();
    assert.match(view.get('ground-camera').src, /front\.mjpg/);
  }
});

test('尚未用接收字节验证的前视连接，遥测过期后仍须停止', async () => {
  const view = setup();
  view.queueHealth();
  const work = view.refreshGroundCamera();
  const request = view.healthRequests.at(-1);
  view.clock(3001); view.renderGroundFreshness();
  await work;
  assert.equal(request.signal.aborted, true);
  assert.equal(view.get('ground-camera').src, undefined);
});

test('已验证前视流独立接收新字节，遥测迟到不清流，真实停传3秒仍清空', async () => {
  for (const staleSnapshot of [true, false]) {
    const view = setup();
    await view.refreshGroundCamera();
    const src = view.get('ground-camera').src;
    for (const time of [1000, 2000, 3100, 4500]) {
      view.clock(time);
      if (!staleSnapshot) view.telemetry({ camera: { ready: true, age_s: 3.1 } });
      await view.refreshGroundCamera();
      view.renderGroundFreshness();
      assert.equal(view.get('ground-camera').src, src);
    }
    assert.equal(view.cameraState().valid, false);
    assert.equal(view.get('ugv-camera-status').textContent, '正在接收车端视频数据');
    assert.equal(view.healthRequests.length, 5, '遥测过期不能阻止已建流继续检查独立活性');
    view.clock(7501); view.renderGroundFreshness();
    assert.equal(view.get('ground-camera').src, undefined);
    view.clock(8502); await view.refreshGroundCamera();
    assert.equal(view.get('ground-camera').src, undefined, '断流后仍需要新鲜设备状态才能重建');
    view.telemetry(); await view.refreshGroundCamera();
    assert.match(view.get('ground-camera').src, /front\.mjpg/);
    assert.notEqual(view.get('ground-camera').src, src);
  }
});

test('后视JPEG保持独立采样年龄检查，上一帧尚新也不能覆盖设备过期状态', async () => {
  const view = setup();
  view.selectGroundCamera('rear'); view.imageRequests[0].respond(true); await flush();
  assert.match(view.get('ground-camera').src, /^blob:/);
  view.clock(1000); view.telemetry({ cameraRear: { ready: true, age_s: 3.1 } });
  view.renderGroundFreshness();
  assert.equal(view.get('ground-camera').src, undefined);
});

for (const mode of ['map', 'hidden']) {
  test(`切到${mode === 'map' ? '地图' : '后台'}关闭前视流并取消健康检查`, async () => {
    const view = setup();
    await view.refreshGroundCamera();
    view.clock(1000); view.telemetry();
    const pending = view.queueHealth();
    const work = view.refreshGroundCamera();
    const request = view.healthRequests.at(-1);
    if (mode === 'map') view.setGroundMode(true); else view.hide(true);
    try {
      assert.equal(view.get('ground-camera').src, undefined);
      assert.equal(request.signal?.aborted, true, '必须取消仍在进行的健康HTTP请求');
    } finally { pending.resolve({ data: {} }); await work; }
  });
}

test('隐藏页面会取消后视JPEG请求，恢复可重新请求', async () => {
  const view = setup();
  view.selectGroundCamera('rear');
  const first = view.imageRequests[0];
  view.hide(true);
  assert.equal(first.signal.aborted, true);
  await flush();
  assert.equal(view.get('ground-camera').src, undefined);
  view.hide(false);
  assert.equal(view.imageRequests.length, 2);
  view.imageRequests[1].respond(true); await flush();
  assert.match(view.get('ground-camera').alt, /后视/);
});

test('放大弹窗复用画面，不新增上游连接，关闭保持主流', async () => {
  const view = setup();
  view.get('action-dialog').open = true;
  await view.refreshGroundCamera();
  const main = view.get('ground-camera').src;
  assert.equal(view.get('ugv-expanded-camera').src, undefined, '镜像画布不单独拉视频流');
  view.get('action-dialog').dispatch('close');
  assert.equal(view.get('ugv-expanded-camera').src, undefined);
  assert.equal(view.get('ground-camera').src, main);
});

test('后视切俯视时，已在解码的旧后视响应不能覆盖新相机', async () => {
  const view = setup();
  view.holdDecode(); view.selectGroundCamera('rear');
  view.imageRequests[0].respond(true); await flush();
  assert.equal(view.decodes.length, 1);
  view.selectGroundCamera('top');
  view.decodes[0].resolve(); await flush();
  assert.equal(view.get('ground-camera').src, undefined);
  assert.equal(view.revoked.has('blob:frame-1'), true);
  assert.match(view.imageRequests.at(-1).url, /top\.jpg/);
  view.holdDecode(false); view.imageRequests.at(-1).respond(true); await flush();
  assert.match(view.get('ground-camera').alt, /俯视/);
});

test('后视→前视→后视，第一轮后视的迟到解码仍必须作废', async () => {
  const view = setup();
  view.holdDecode(); view.selectGroundCamera('rear');
  view.imageRequests[0].respond(true); await flush();
  view.selectGroundCamera('front'); view.selectGroundCamera('rear');
  view.decodes[0].resolve(); await flush();
  assert.equal(view.get('ground-camera').src, undefined, '同名相机的新会话不能接纳已取消会话的画面');
  assert.equal(view.revoked.has('blob:frame-1'), true);
});

test('后视切地图再切图传，暂停前的迟到解码不会重新出现', async () => {
  const view = setup();
  view.holdDecode(); view.selectGroundCamera('rear');
  view.imageRequests[0].respond(true); await flush();
  view.setGroundMode(true); view.setGroundMode(false);
  view.decodes[0].resolve(); await flush();
  assert.equal(view.get('ground-camera').src, undefined);
  assert.equal(view.revoked.has('blob:frame-1'), true);
});

test('后视JPEG暂时失败保留尚新鲜上一帧，超过3秒即清除旧帧', async () => {
  const view = setup();
  view.selectGroundCamera('rear'); view.imageRequests[0].respond(true); await flush();
  const src = view.get('ground-camera').src;
  assert.match(src, /^blob:/);
  view.clock(500); view.telemetry();
  const update = view.refreshGroundCamera();
  view.imageRequests.at(-1).respond(false); await update;
  assert.equal(view.get('ground-camera').src, src);
  assert.equal(view.revoked.has(src), false);
  view.clock(3001); view.telemetry(); view.renderGroundFreshness();
  assert.equal(view.get('ground-camera').src, undefined);
  assert.equal(view.revoked.has(src), true);
});

test('遥测请求在浏览器排队5秒，新采集样本只累加响应送达时间', async () => {
  const view = setup();
  view.clock(5060);
  view.applyTelemetry({ receivedAt: timestamp(5050), snapshotAgeS: 0.05, snapshotMaxAgeS: 3,
    camera: { ready: true, age_s: 0.08 } }, 0);
  assert.equal(view.cameraState().valid, true);
  assert.ok(Math.abs(view.cameraState().ageS - 0.09) < 0.00001);
  await view.refreshGroundCamera();
  assert.match(view.get('ground-camera').src, /front\.mjpg/);
});

test('后端已生成的遥测响应滞留超过3秒，到达后仍过期且不能建立新流', async () => {
  const view = setup();
  view.clock(8060);
  view.applyTelemetry({ receivedAt: timestamp(5050), snapshotAgeS: 0.05, snapshotMaxAgeS: 3,
    camera: { ready: true, age_s: 0.08 } }, 0);
  assert.equal(view.cameraState().valid, false);
  assert.ok(view.cameraState().ageS > 3);
  view.renderGroundFreshness();
  await view.refreshGroundCamera();
  assert.equal(view.get('ground-camera').src, undefined);
  assert.equal(view.healthRequests.length, 0);
});

test('缺失、无效或未来的遥测receivedAt采用保守计时，不恢复过期画面', () => {
  for (const receivedAt of [undefined, 'invalid-date', timestamp(5061)]) {
    const view = setup();
    view.clock(5060);
    view.applyTelemetry({ receivedAt, snapshotAgeS: 0.05, snapshotMaxAgeS: 3,
      camera: { ready: true, age_s: 0.08 } }, 0);
    assert.equal(view.cameraState().valid, false);
    assert.ok(view.cameraState().ageS > 5);
  }
});

test('健康请求排队5秒后收到新流数据，不把排队时间误作视频静默', async () => {
  const view = setup(), pending = view.queueHealth();
  const work = view.refreshGroundCamera();
  const src = view.get('ground-camera').src;
  const clientId = new URL(src, 'http://localhost').searchParams.get('clientId');
  view.clock(5000); view.telemetry();
  pending.resolve({ data: { streamHealth: [{ clientId, cameraId: 'front.mjpg', active: true,
    lastDataAt: timestamp(4990), idleAgeMs: 10, receivedBytes: 100 }] } });
  await work;
  assert.equal(view.get('ground-camera').src, src);
  assert.equal(view.get('ground-camera').style.visibility, 'visible');
});

test('健康响应滞留超过3秒，真实旧流数据不能被响应到达时间续期', async () => {
  const view = setup(), pending = view.queueHealth();
  const work = view.refreshGroundCamera();
  const clientId = new URL(view.get('ground-camera').src, 'http://localhost').searchParams.get('clientId');
  view.clock(4000); view.telemetry();
  pending.resolve({ data: { streamHealth: [{ clientId, cameraId: 'front.mjpg', active: true,
    lastDataAt: timestamp(0), idleAgeMs: 0, receivedBytes: 100 }] } });
  await work;
  assert.equal(view.get('ground-camera').src, undefined);
});

test('缺失、无效或未来的健康lastDataAt回退到请求起点与idleAge，不假装新鲜', async () => {
  for (const lastDataAt of [undefined, 'invalid-date', timestamp(4001)]) {
    const view = setup(), pending = view.queueHealth();
    const work = view.refreshGroundCamera();
    const clientId = new URL(view.get('ground-camera').src, 'http://localhost').searchParams.get('clientId');
    view.clock(4000); view.telemetry();
    pending.resolve({ data: { streamHealth: [{ clientId, cameraId: 'front.mjpg', active: true,
      lastDataAt, idleAgeMs: 0, receivedBytes: 100 }] } });
    await work;
    assert.equal(view.get('ground-camera').src, undefined);
  }
});
