const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const display = fs.readFileSync(path.join(__dirname, '../atomori-status-display.js'), 'utf8').replace('  pollStatus();\n', '');
const localization = fs.readFileSync(path.join(__dirname, '../atomori-status-localization.js'), 'utf8');

function harness() {
  const nodes = new Map(), timers = [], requests = [], clock = { now: 1000 };
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { textContent: '', title: '', style: {}, className: '', classList: {
        add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name), contains: name => classes.has(name)
      } });
    }
    return nodes.get(id);
  }
  const context = {
    document: { getElementById: node, hidden: false }, Date: class extends Date { static now() { return clock.now; } }, AbortController,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
    fetch: (url, options) => { requests.push({ url, options }); return new Promise(() => {}); },
    cruiseAvail: false, cruiseOn: false, pusherAvail: false, pusherClosed: false, mappingOn: false,
    cameraWasOffline: false, navMapData: null, robotMapPose: null, robotLocalizationConfidence: 'none',
    PUSHER_STATE_NAMES: ['外侧', '向内', '内侧', '向外', '中途'],
    renderCruise() {}, renderPusher() {}, renderMapping() {}, updateMappingProgress() {}, refreshSavedMaps() {},
    resetLiveMappingView() {}, updateGpsMap() {}, refreshCamera() {}, drawNavMap() {},
    localizationStateEl: node('localizationState'), localizationPoseEl: node('localizationPose'), localizationHintEl: node('localizationHint'),
    renderLocalization(loc) { node('localizationState').textContent = loc.state; node('localizationPose').textContent = loc.map_pose.join(' / '); }
  };
  vm.createContext(context); vm.runInContext(display + '\n' + localization, context);
  return { context, node, timers, requests, clock };
}
function fixture() {
  return {
    gateway: { ok: true }, camera: { ready: true }, topic_ages_s: { odom: 0.1, ugv_control_mux: 0.1, ugv_command_gateway: 0.1 },
    odom: { pose: [0, 2, 0.1], speed_mps: 0 }, ugv_control_mux: { authority: 'navigation', reason: 'active' },
    ugv_command_gateway: { output_linear_mps: 0, output_angular_rps: 0 },
    environment: { available: true, stale: false, age_s: 0.2, temperature_c: 25, humidity_percent: 48,
      digital: { mq2: { available: true, age_s: 0.1, triggered: true }, alcohol: { available: true, age_s: 0.1, triggered: false } },
      analog: { available: true, age_s: 0.2, channels: { mq2: { raw: 120, adc_voltage_v: 2.344, reference_estimate: { status: 'reference_only', ppm: 38486.886 } } } } },
    ultrasonic_left: { range: 0, age_s: 0.1 }, ultrasonic_right: { range: 2.1, age_s: 0.1 },
    avoidance: { available: true, cruise_enabled: false }, leadscrew: { age_s: 0.1, closed: false, status: { pos_mm: [0, 0], state: [4, 4] } },
    gps: { age_s: 0.1, fix: { status: 0, latitude: 0, longitude: 120.1, altitude: 2 } },
    localization: { age_s: 0.1, map_pose: [0, 2, 0.1], confidence: 'high', state: 'localized' }
  };
}

test('失联保留数字/ADC/环境/位置/距离，报警中性，控制可用性不沿用缓存', () => {
  const { context, node, clock, requests } = harness();
  context.atomoriRenderStatus(fixture());
  const ids = ['mq2Value', 'alcoholValue', 'envTemperature', 'envHumidity', 'pose', 'speed', 'authority', 'reason', 'gw', 'ultrasonicLeft', 'ultrasonicRight', 'gpsPos', 'gpsAlt', 'localizationPose'];
  const before = Object.fromEntries(ids.map(id => [id, node(id).textContent]));
  assert.equal(context.cruiseAvail, true); assert.equal(context.pusherAvail, true);
  clock.now += 120000;
  context.atomoriStatusFailed();
  for (const id of ids) assert.equal(node(id).textContent, before[id], id);
  assert.equal(node('conn').textContent, '断开');
  assert.match(node('mq2Value').title, /120\.2 秒前/);
  assert.equal(node('mq2Value').classList.contains('sensor-alarm'), false);
  assert.equal(node('mq2Value').classList.contains('sensor-unknown'), true);
  assert.equal(context.cruiseAvail, false); assert.equal(context.pusherAvail, false);
  assert.equal(context.robotLocalizationConfidence, 'none');
  assert.deepEqual(requests, [], '渲染不得触发控制或额外HTTP');
});

test('首次缺样本为空白，部分字段无效不影响其他字段恢复，真实0保留', () => {
  const { context, node } = harness();
  context.atomoriStatusFailed();
  assert.equal(node('speed').textContent, '—');
  context.atomoriRenderStatus(fixture());
  const next = fixture(); next.environment.temperature_c = null; next.environment.humidity_percent = 52;
  next.odom.speed_mps = null; next.gps.fix.latitude = null; next.ugv_command_gateway.output_angular_rps = null;
  context.atomoriRenderStatus(next);
  assert.equal(node('envTemperature').textContent, '25.0 °C');
  assert.equal(node('envHumidity').textContent, '52 % RH');
  assert.equal(node('speed').textContent, '0.00 m/s');
  assert.equal(node('ultrasonicLeft').textContent, '0.00 m');
  assert.equal(node('gpsPos').textContent, '0.0000000 / 120.1000000');
  assert.equal(node('gw').textContent, '0.00 / 0.00');
  assert.equal(node('conn').textContent, '已连接');
});

test('状态GET串行、HTTP失败后1000ms重试、定位复用快照不加请求', async () => {
  const { context, requests, timers, node } = harness();
  let release;
  context.fetch = (url, options) => { requests.push({ url, options }); return new Promise(resolve => { release = resolve; }); };
  const first = context.pollStatus();
  await context.pollStatus();
  assert.equal(requests.length, 1); assert.equal(requests[0].url, '/api/status');
  assert.equal(requests[0].options.method, undefined); assert.ok(requests[0].options.signal);
  release({ ok: false, status: 503 }); await first;
  assert.equal(node('conn').textContent, '断开');
  assert.equal(timers.at(-1).ms, 1000);
  context.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => fixture() }; };
  await context.pollStatus();
  assert.equal(requests.length, 2); assert.equal(timers.at(-1).ms, 500);
  assert.equal(node('conn').textContent, '已连接');
  assert.ok(timers.some(timer => timer.ms === 1500), '每轮请求有超时');
});
