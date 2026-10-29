import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createUpstreamIntegrations } from '../src/upstream.js';

const read = name => readFileSync(new URL(`../../marp/${name}`, import.meta.url), 'utf8');
const live = read('live.js'), dashboard = read('dashboard.js');
const EPOCH = 1700000000000;
const timestamp = ms => new Date(EPOCH + ms).toISOString();

test('两种飞控适配器都返回本机归一化时间，不沿用上游时间戳', async () => {
  for (const fromPi of [true, false]) {
    let responseAt;
    const adapter = createUpstreamIntegrations({
      ...(fromPi ? { uavFlightUrl: 'http://pi' } : { missionPlannerUrl: 'http://mp' }),
      fetchImpl: async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        responseAt = Date.now();
        return Response.json(fromPi ? { flight_controller_connected: true, vehicle_state_age_s: .1 }
          : { deviceId: 'UAV-01', source: 'mission-planner-mavlink', normalizedAt: timestamp(0), flight: { connected: true, stateAgeS: .1 } });
      }
    });
    const data = await (fromPi ? adapter.telemetry('UAV-01', 'flight') : adapter.missionPlanner());
    assert.ok(Date.parse(data.normalizedAt) >= responseAt);
    assert.ok(Date.parse(data.normalizedAt) <= Date.now());
    assert.ok(data.snapshotAgeS >= .015);
  }
});
function setup() {
  let now = 4700;
  const context = vm.createContext({
    Date: { now: () => EPOCH + now, parse: Date.parse }, performance: { now: () => now },
    latestFlight: {}, latestVision: {}, uavReceivedAt: 0, visionReceivedAt: 0,
    renderUav() {}, renderRelativePosition() {}, flightReading() {}, document: { hidden: false }, stopped: false
  });
  vm.runInContext(read('api.js') + '\nglobalThis.api = AtomoriApi;', context);
  vm.runInContext(live.slice(live.indexOf('  function applyUav('), live.indexOf('  function renderUav()')), context);
  const run = code => vm.runInContext(code, context);
  return { context, api: context.api, run, at: ms => { now = ms; } };
}

test('排队发生在机载采样之前：只计入归一化后传输，不误判新鲜心跳过期', () => {
  const app = setup();
  const data = { normalizedAt: timestamp(4500), snapshotAgeS: 0.2, ageIncludes: 'device-http-and-response-wait' };
  assert.equal(app.api.sampleTime(data, 0), 4500);
  app.context.data = { ...data, flight: { connected: true, stateAgeS: 0.6 } };
  app.run('applyUav(data, 0)');
  assert.equal(app.run('latestFlight.stateAgeS + (performance.now() - uavReceivedAt) / 1000'), 0.8);
  app.at(6200);
  assert.ok(app.run('latestFlight.stateAgeS + (performance.now() - uavReceivedAt) / 1000') > 2,
    '同一快照继续老化，不能因排队修复而延长有效期');
});

test('稀疏响应省略来源身份时保持显示缓存边界，显式换源才清除最近模式', () => {
  const app = setup(); app.context.retainedMode = 'STABILIZE';
  app.context.data = { source: 'uav-rpi-deploy', sourceIdentity: 'pi-one', flight: { metrics: {} } };
  app.run('applyUav(data)');
  app.context.data = { source: 'uav-rpi-deploy', flight: {} };
  app.run('applyUav(data)');
  assert.equal(app.run('latestFlight.displayIdentity'), 'pi-one');
  assert.equal(app.context.retainedMode, 'STABILIZE');
  app.context.data = { source: 'uav-rpi-deploy', sourceIdentity: 'pi-two', flight: {} };
  app.run('applyUav(data)');
  assert.equal(app.run('latestFlight.displayIdentity'), 'pi-two');
  assert.equal(app.context.retainedMode, null);
});

test('响应时间缺失、无效或在未来时保守使用旧计时，不把旧值更新为刚采样', () => {
  const app = setup();
  for (const normalizedAt of [undefined, 'invalid', timestamp(4800)]) {
    assert.equal(app.api.sampleTime({ normalizedAt, snapshotAgeS: .2, ageIncludes: 'device-http-and-response-wait' }, 0), 200);
  }
  assert.equal(app.api.sampleTime({ snapshotAgeS: -1, ageIncludes: 'device-http-and-response-wait' }, 0), 0);
  assert.equal(app.api.sampleTime({ normalizedAt: timestamp(1000) }, 4000), 1000, '缓存响应保留原时间');
});

test('树莓派及MP短暂请求失败保留有效样本，明确断连与超时仍失效', async () => {
  for (const source of ['raspberry-pi', 'mission-planner']) {
    const app = setup(), tasks = [];
    Object.assign(app.context, {
      config: { carConfigured: false, uavVisionConfigured: false },
      flightSource: () => source, independentFlight: () => true,
      repeat: action => { tasks.push(action); }, applyUgv() {}
    });
    vm.runInContext(live.slice(live.indexOf('  async function pollDevice('), live.indexOf('  async function repeat(')), app.context);
    vm.runInContext(live.slice(live.indexOf("  if (config.carConfigured) void repeat(() => pollDevice"), live.indexOf('  void repeat(async () => { await monitorCamera();')), app.context);
    app.context.data = { normalizedAt: timestamp(4500), flight: { connected: true, stateAgeS: .1 } };
    app.run('applyUav(data, 0)');
    app.api.request = async () => { throw new Error('temporary transport failure'); };
    await tasks[0]();
    assert.equal(app.context.latestFlight.connected, true);
    assert.equal(app.context.uavReceivedAt, 4500, '失败不续期、不清空');
    app.at(6600);
    assert.ok(app.run('latestFlight.stateAgeS + (performance.now() - uavReceivedAt) / 1000') > 2);
    app.context.data = { normalizedAt: timestamp(6600), flight: { connected: false, stateAgeS: 0 } };
    app.run('applyUav(data, 6600)');
    assert.equal(app.context.latestFlight.connected, false, '设备明确断连立即生效');
  }
});

test('数值相同的重复刷新不替换DOM，变化和失效仍更新', () => {
  let html = '', writes = 0;
  const element = { get innerHTML() { return html; }, set innerHTML(value) { html = value; writes++; } };
  const context = vm.createContext({ element });
  vm.runInContext(live.slice(live.indexOf('  const display ='), live.indexOf('  const fresh =')) + '\nglobalThis.showMetric = show;', context);
  for (let i = 0; i < 20; i++) context.showMetric(element, 25, 1, '°C');
  assert.equal(writes, 1);
  for (let i = 0; i < 20; i++) context.showMetric(element, 26, 1, '°C');
  assert.equal(writes, 2);
  context.showMetric(element, null, 1, '°C');
  assert.equal(html, '—');
  assert.equal(writes, 3);
});

test('无人机和无人车重复在线事件不重建状态灯，实际断连仍更新', () => {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', writes: 0, classList: { toggle() {} },
      replaceChildren(...children) { this.textContent = children.join(''); this.writes++; } });
    return nodes.get(id);
  };
  const context = vm.createContext({ get, document: { createElement: () => '', createTextNode: text => text } });
  vm.runInContext(dashboard.slice(dashboard.indexOf('  const connection ='), dashboard.indexOf('  const battery =')) + '\nglobalThis.connection = connection;', context);
  for (const id of ['uav-connection', 'ugv-connection']) {
    for (let i = 0; i < 20; i++) context.connection(id, true);
    assert.equal(get(id).writes, 1);
    context.connection(id, false);
    assert.equal(get(id).textContent, '未连接');
    assert.equal(get(id).writes, 2);
  }
});
