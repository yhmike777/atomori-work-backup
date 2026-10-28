import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../marp/uav-details.js', import.meta.url), 'utf8');
function setup(kind = 'raspberry-pi') {
  let now = 1000;
  const context = vm.createContext({ performance: { now: () => now }, finite: value => typeof value === 'number' && Number.isFinite(value) });
  vm.runInContext(source.slice(source.indexOf('  const fields ='), source.indexOf('  function render()')) + `
    globalThis.view = { metric, metricDefinitions, diagnosticState, reasonText, statusReading,
      error(value) { errorMessage = value; },
      set(value, kind) { snapshot = value; config = { uavFlightSource: kind }; receivedAt = performance.now(); errorMessage = ''; rememberSnapshot(); } };
  `, context);
  const flight = metrics => ({ flight: { connected: true, stateAgeS: 0.1, metrics, details: {} }, transport: { acceptedMessages: 2 } });
  return { view: context.view, at: value => { now = value; }, set: metrics => context.view.set(flight(metrics), kind), flight };
}
const reading = (value, extra = {}) => ({ value, rawValue: value, valid: true, ageS: 0.05, maxAgeS: 1, unit: 'm/s', ...extra });

test('详情显示真实零值，null/字符串/缺失时效不能变成0', () => {
  const app = setup();
  app.set({ velocityX: reading(0), velocityY: reading(null), velocityZ: reading('0'), batteryCurrent: reading(2, { ageS: null }), airspeed: reading(1, { maxAgeS: undefined }) });
  assert.equal(app.view.metric('velocityX').value, 0);
  for (const key of ['velocityY', 'velocityZ', 'batteryCurrent', 'airspeed']) assert.equal(app.view.metric(key).value, null);
  assert.equal(app.view.metric('velocityY').reason, '读数不合法');
  assert.equal(app.view.metric('batteryCurrent').reason, '采样时间未知');
  assert.equal(app.view.metric('airspeed').reason, '缺少有效期信息');
});

test('各指标独立过期，保留最近有效值且原样本年龄持续增长', () => {
  const app = setup(); app.set({ gyroX: reading(0.01, { maxAgeS: 0.5 }), batteryVoltage: reading(12, { maxAgeS: 3 }) });
  app.at(1500);
  assert.equal(app.view.metric('gyroX').reason, '最近数据 · 已过期');
  assert.equal(app.view.metric('gyroX').value, 0.01);
  assert.equal(app.view.metric('gyroX').valid, false);
  assert.equal(app.view.metric('gyroX').ageS, 0.55);
  assert.equal(app.view.metric('batteryVoltage').value, 12);
  app.at(3100);
  assert.equal(app.view.metric('batteryVoltage').reason, '最近数据 · 飞控断连 / 过期');
  assert.equal(app.view.metric('batteryVoltage').value, 12);
  assert.equal(app.view.metric('batteryVoltage').ageS, 2.15);
  const legacy = setup(); legacy.set({ roll: reading(2, { unit: undefined }) }); legacy.at(3000);
  assert.equal(legacy.view.metric('roll').value, 2, 'legacy metrics without lastValid or unit still retain validated numeric readings');
  assert.equal(legacy.view.metric('roll').unit, '°');
});

test('动态指标与通道消失后保留定义和最近值，不伪装为实时', () => {
  const app = setup(); app.set({ velocityX: reading(1), rcInput8: reading(1500, { label: '遥控器通道 8', group: '遥控器输入', unit: 'µs', digits: 0 }), temperatureBoard: reading(34.2, { label: '板载温度', group: '气压、磁场与温度', unit: '°C', digits: 1 }) });
  let definitions = app.view.metricDefinitions();
  assert(definitions.some(item => item.key === 'velocityX' && item.label.includes('机体系速度')));
  assert(definitions.some(item => item.key === 'rcInput8' && item.digits === 0 && item.group === '遥控器输入'));
  assert(definitions.some(item => item.key === 'temperatureBoard' && item.unit === '°C'));
  app.set({ velocityX: reading(2) }); definitions = app.view.metricDefinitions();
  assert(definitions.some(item => item.key === 'rcInput8' && item.group === '遥控器输入'));
  assert.equal(app.view.metric('rcInput8').value, 1500);
  assert.equal(app.view.metric('rcInput8').valid, false);
  assert.equal(app.view.metric('rcInput8').retained, true);
});

test('请求失败和空断连包保留值，恢复后使用新值，不接受原始无效样本', () => {
  const app = setup(); app.set({ gyroX: reading(0), gyroY: reading(null, { valid: false }) });
  app.at(1300); app.view.error('timeout');
  assert.equal(app.view.metric('gyroX').value, 0); assert.equal(app.view.metric('gyroX').valid, false);
  assert.equal(app.view.metric('gyroX').ageS, 0.35);
  assert.equal(app.view.metric('gyroY').value, null);
  app.at(2000); app.view.set({ flight: { connected: false, metrics: {}, details: {} } }, 'raspberry-pi');
  assert.equal(app.view.metric('gyroX').value, 0); assert.equal(app.view.metric('gyroX').ageS, 1.05);
  app.set({ gyroX: reading(null, { rawValue: 999, valid: false, reason: 'OUT_OF_RANGE' }) });
  assert.equal(app.view.metric('gyroX').value, 0);
  app.at(3000); app.set({ gyroX: reading(0.25) });
  assert.equal(app.view.metric('gyroX').value, 0.25); assert.equal(app.view.metric('gyroX').valid, true);
  assert.equal(app.view.metric('gyroX').ageS, 0.05);
});

test('lastValid允许首次慢响应显示已校验值，重试不能重置原样本年龄', () => {
  const app = setup(), recent = { value: 12.6, unit: 'V', source: '/mavros/battery', ageS: 5, maxAgeS: 3, ageBasis: 'upstream' };
  const offline = item => ({ flight: { connected: false, stateAgeS: null, metrics: { batteryVoltage: item }, details: {} } });
  app.view.set(offline(reading(null, { valid: false, lastValid: recent })), 'raspberry-pi');
  assert.equal(app.view.metric('batteryVoltage').value, 12.6); assert.equal(app.view.metric('batteryVoltage').retained, true);
  assert.equal(app.view.metric('batteryVoltage').ageS, 5);
  app.at(2000); app.view.set(offline(reading(null, { valid: false, lastValid: { ...recent, ageS: 6 } })), 'raspberry-pi');
  assert.equal(app.view.metric('batteryVoltage').ageS, 6);
  app.at(10000); app.view.set(offline(reading(null, { valid: false })), 'raspberry-pi');
  assert.equal(app.view.metric('batteryVoltage').value, 12.6); assert.equal(app.view.metric('batteryVoltage').ageS, 14);
  for (const invalid of [{ ...recent, value: null }, { ...recent, value: '0' }, { ...recent, ageS: -1 }, { ...recent, ageS: null }, { ...recent, source: '' }, { ...recent, maxAgeS: null }]) {
    const empty = setup(); empty.view.set(offline(reading(null, { valid: false, lastValid: invalid })), 'raspberry-pi');
    assert.equal(empty.view.metric('batteryVoltage').value, null);
  }
});

test('状态值可保留但过期不能冒充当前状态，健康和执行器诊断不会变正常', () => {
  const app = setup(), sample = app.flight({});
  sample.flight.mode = 'STABILIZE'; sample.flight.armed = false; sample.flight.landedState = 'ON_GROUND'; sample.flight.landedStateAgeS = 0.1;
  app.view.set(sample, 'raspberry-pi'); assert.equal(app.view.statusReading('armed').value, false);
  app.at(3100); assert.equal(app.view.statusReading('mode').value, 'STABILIZE');
  assert.equal(app.view.statusReading('mode').valid, false); assert.equal(app.view.statusReading('mode').retained, true);
  assert.equal(app.view.statusReading('mode').ageS, 2.2);
  assert.equal(app.view.diagnosticState({ status: 'VALID', valid: true, ageS: 0.1, maxAgeS: 30 }).valid, false);
  app.set({}); assert.equal(app.view.statusReading('armed').valid, false, 'a missing boolean cannot reuse the previous locked state as current');
  const empty = setup(); empty.set({}); assert.equal(empty.view.statusReading('armed').value, null);
});

test('来源切换隔离指标、状态和动态定义，断连缺身份元数据不会误清缓存', () => {
  const app = setup(), sample = app.flight({ rcInput8: reading(1500) });
  sample.sourceIdentity = 'pi-a'; sample.flight.mode = 'STABILIZE'; app.view.set(sample, 'raspberry-pi');
  app.view.set({ sourceIdentity: 'pi-a', flight: { connected: false, metrics: {} } }, 'raspberry-pi');
  assert.equal(app.view.metric('rcInput8').value, 1500);
  app.view.set({ sourceIdentity: 'pi-b', flight: { connected: false, metrics: {} } }, 'raspberry-pi');
  assert.equal(app.view.metric('rcInput8').value, null); assert.equal(app.view.statusReading('mode').available, false);
  assert(!app.view.metricDefinitions().some(item => item.key === 'rcInput8'));
  const mp = setup('mission-planner'), packet = mp.flight({ roll: reading(1) }); packet.transport = { peerIp: '10.0.0.1', systemId: 1, componentId: 1, acceptedMessages: 1 };
  mp.view.set(packet, 'mission-planner'); mp.view.set({ flight: { connected: false, metrics: {} } }, 'mission-planner');
  assert.equal(mp.view.metric('roll').value, 1);
  mp.view.set({ flight: { connected: false, metrics: {} }, transport: { peerIp: '10.0.0.2', systemId: 1, componentId: 1 } }, 'mission-planner');
  assert.equal(mp.view.metric('roll').value, null);
  app.set({ roll: reading(2) }); app.view.set({ flight: { connected: false, metrics: {} } }, 'mission-planner');
  assert.equal(app.view.metric('roll').value, null);
});

test('旧桥、无样本、不合法与超范围原因区分，RPi不误写MAVLink来源', () => {
  const app = setup(); const snapshot = app.flight({ gyroX: reading(null, { valid: false, reason: 'NO_SAMPLE' }), gyroY: reading(null, { valid: false, reason: 'INVALID_VALUE' }), gyroZ: reading(null, { valid: false, reason: 'OUT_OF_RANGE' }) });
  snapshot.flight.details.extraTelemetryStatus = 'NOT_CONNECTED'; app.view.set(snapshot, 'raspberry-pi');
  assert.equal(app.view.metric('batteryCurrent').reason, '旧版遥测桥未接入');
  delete snapshot.flight.details.extraTelemetryStatus; app.view.set(snapshot, 'raspberry-pi');
  assert.equal(app.view.metric('batteryCurrent').reason, '旧版遥测桥未接入', 'an older adapter with no extension status is also explicit');
  assert.equal(app.view.metric('gyroX').reason, '未上报');
  assert.equal(app.view.metric('gyroY').reason, '读数不合法');
  assert.equal(app.view.metric('gyroZ').reason, '读数超出有效范围');
  assert(!app.view.metric('gyroX').source.includes('MAVLink'));
  const mp = setup('mission-planner'); mp.set({ roll: reading(1) });
  assert.equal(mp.view.metric('roll').value, 1);
  assert(mp.view.metric('gyroX').source.includes('MAVLink'));
});

test('诊断计数不替代有效读数，来源按独立年龄过期且保留旧桥状态', () => {
  const app = setup(); app.set({});
  assert.equal(app.view.diagnosticState({ count: 0, ageS: 0, maxAgeS: 1 }).text, '未上报');
  assert.equal(app.view.diagnosticState({ status: 'NOT_CONNECTED' }).text, '旧版遥测桥未接入');
  assert.equal(app.view.diagnosticState({ status: 'UNSUPPORTED_TYPE', count: 0 }).text, '桥接不支持此消息类型');
  assert.equal(app.view.diagnosticState({ status: 'NOT_AVAILABLE', count: 0 }).text, '当前来源不可用');
  assert.equal(app.view.diagnosticState({ status: 'STALE', count: 2, ageS: 0.1 }).valid, false);
  assert.equal(app.view.diagnosticState({ count: 2, ageS: 0.1, maxAgeS: 1 }).text, '已接收 · 仅供诊断');
  app.at(2100);
  assert.equal(app.view.diagnosticState({ count: 2, ageS: 0.1, maxAgeS: 1 }).text, '已过期');
  assert.equal(app.view.metric('rcInput1').value, null);
});

function polling() {
  let now = 1000;
  const pending = [], timers = [], button = { disabled: false };
  const context = vm.createContext({
    performance: { now: () => now }, document: { hidden: false },
    stopped: false, busy: false, pollTimer: null, receivedAt: 0, snapshot: null, lastResponse: null, rawResponse: null, errorMessage: '', failureCount: 0,
    config: { mode: 'upstream-readonly', uavFlightConfigured: true }, flightSource: () => 'raspberry-pi', fromRpi: () => true,
    get: () => button, clearTimeout() {}, setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    render() {}, updateRawResponse() {}, rememberSnapshot() {},
    AtomoriApi: { request: () => new Promise((resolve, reject) => pending.push({ resolve, reject, started: now })), sampleTime: (_, requestedAt) => requestedAt,
      message: error => error.message }
  });
  vm.runInContext(source.slice(source.indexOf('  async function poll()'), source.indexOf('  function start()')) + '\nglobalThis.pollNow = poll;', context);
  const response = () => ({ data: { deviceId: 'UAV-01', source: 'uav-rpi-deploy', flight: { connected: true, stateAgeS: 0.05, metrics: {}, details: {} } } });
  return { context, pending, timers, button, at: value => { now = value; }, response, poll: () => context.pollNow() };
}

test('140ms请求纳入750ms刷新周期，慢请求串行且不额外等待750ms', async () => {
  const app = polling();
  const first = app.poll();
  assert.equal(app.pending.length, 1);
  assert.equal(app.button.disabled, true);
  await app.poll();
  assert.equal(app.pending.length, 1, 'manual refresh while busy cannot overlap the request');
  app.at(1140); app.pending[0].resolve(app.response()); await first;
  assert.equal(app.timers[0].delay, 610);
  assert.equal(app.button.disabled, false);
  app.at(1750); const second = app.timers[0].callback();
  assert.equal(app.pending[1].started, 1750, 'request starts remain 750ms apart');
  app.at(2700); app.pending[1].resolve(app.response()); await second;
  assert.equal(app.timers[1].delay, 0, 'a response over 750ms schedules one immediate serial follow-up');
  assert.equal(app.pending.length, 2, 'scheduling does not start another request synchronously');
});

test('失败按750ms退避至4秒且不刷新原样本时钟，恢复后重置退避', async () => {
  const app = polling(), retained = { flight: { connected: true } };
  app.context.snapshot = retained; app.context.receivedAt = 800;
  for (const [index, delay] of [750, 1500, 3000, 4000, 4000].entries()) {
    const pending = app.poll(); app.at(1140 + index * 1000); app.pending[index].reject(new Error('temporary failure')); await pending;
    assert.equal(app.timers[index].delay, delay);
  }
  assert.equal(app.context.snapshot, retained);
  assert.equal(app.context.receivedAt, 800);
  assert.equal(app.context.busy, false);
  const recovered = app.poll(); app.pending[5].resolve(app.response()); await recovered;
  assert.equal(app.context.failureCount, 0);
  const failedAgain = app.poll(); app.pending[6].reject(new Error('failure after recovery')); await failedAgain;
  assert.equal(app.timers.at(-1).delay, 750);
});

test('隐藏页面和已停止页面不发请求，等待中的请求完成后也不再排程', async () => {
  for (const flag of ['hidden', 'stopped']) {
    const app = polling();
    const set = value => { if (flag === 'hidden') app.context.document.hidden = value; else app.context.stopped = value; };
    set(true); await app.poll(); assert.equal(app.pending.length, 0);
    set(false); const request = app.poll(); set(true);
    app.at(1140); app.pending[0].resolve(app.response()); await request;
    assert.equal(app.timers.length, 0);
    assert.equal(app.context.busy, false);
  }
});
