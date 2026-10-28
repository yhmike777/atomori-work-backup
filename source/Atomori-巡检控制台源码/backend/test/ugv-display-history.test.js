import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { normalizeUgvStatus } from '../src/ugv.js';

const load = () => {
  const context = { window: {} };
  vm.runInNewContext(readFileSync(new URL('../../marp/ugv-view.js', import.meta.url), 'utf8'), context);
  return context.window.AtomoriUgvView;
};
const container = () => ({ innerHTML: '', querySelectorAll: () => [], closest: () => null });
const row = (html, label) => html.split(`<span>${label}</span><b>`)[1]?.split('</b>')[0]?.replace(/<[^>]+>/g, '');
const fixture = () => ({ ...normalizeUgvStatus({
  server_time_ms: 1791943200000, gateway: { service: 'car-web', uptime_s: 120, ok: true },
  topic_ages_s: { odom: 0.1, ugv_control_mux: 0.2, ugv_command_gateway: 0.3 },
  odom: { pose: [1.2, 3.4, 0.5], speed_mps: 0.25 },
  environment: { available: true, stale: false, age_s: 0.2, temperature_c: 25, humidity_percent: 48,
    digital: { mq2: { available: true, stale: false, age_s: 0.1, triggered: true, gpio: 19, level: 0, raw_level: 0, active_level: 0, changes: 3 } },
    analog: { available: true, age_s: 0.2, reference_v: 5, channels: { mq2: { raw: 120, adc_voltage_v: 2.344,
      reference_estimate: { ppm: 38486.886, status: 'reference_only' } } } } },
  ultrasonic_left: { range: 0, age_s: 0.1 }, ultrasonic_right: { range: 2.456, age_s: 0.2 },
  gps: { age_s: 0.2, fix: { status: 0, latitude: 0, longitude: 120.1234567, altitude: 5.5 } },
  localization: { state: 'localized', backend: 'amcl', map_name: 'map_a', map_pose: [0, 0, 0], age_s: 0.2 },
  map: { age_s: 0.2, info: { width: 600, height: 400, resolution: 0.05, origin: [0, 0, 0] } },
  mapping: { active: true, since_s: 120, initial_pose: [1, 2, 0], current_pose: [2, 3, 0] },
  leadscrew: { age_s: 0.1, status: { state: [4, 4], pos_mm: [7, 8], enabled: [false, true] } },
  ugv_control_mux: { authority: 'operator_teleop', enabled: true, gate_open: false, output_linear_mps: 0.25, ages_s: { teleop: 0.1 } },
  ugv_command_gateway: { enabled: true, input_age_s: 0.1, command_timeout_s: 0.5, output_linear_mps: 0.25 },
  camera: { ready: true, age_s: 0.1 }
}), sourceIdentity: 'car-a' });
const detailsFixture = () => ({ sections: Object.fromEntries(Object.entries({
  navigation: { active: true, hasMap: true, goal: [4, 5], path: [[0, 0], [4, 5]] },
  autoCruise: { active: false, initial: [1, 2], mapName: 'map_a', mapInfo: { width: 600, height: 400, resolution: 0.05, origin: [0, 0, 0] } },
  maps: { names: ['map_a', 'map_b'] },
  mechanism: { available: true, simulated: false, busy: false, moving: false, resetting: false, pos_mm: [7, 8], state: [4, 4], enabled: [false, true], speed: 800,
    pins: [{ step: 17, direction: 18, enable: 21 }], simulation_geometry: { left: { open_gap_mm: 200, target_gap_mm: 100, travel_mm: 50, turns: 4, pulses: 800 } } }
}).map(([key, data]) => [key, { data, ageS: 0.2, maxAgeS: 3, available: true }])) });

test('完整详情在失联后保留每个显示来源，连接及机构实时判定仍失效，年龄继续增长', () => {
  const view = load(), element = container(), data = fixture(), details = detailsFixture();
  const original = JSON.stringify({ data, details });
  view.renderDetails(element, data, details, 0, 0, 1000);
  const labels = ['服务', '行驶速度（模长）', '左侧 / 右侧超声距离', '环境温度 / 相对湿度', '里程计位姿（odom）', 'GPS 纬度 / 经度', 'GPS 高度',
    '控制权', '混合器输出（指令值）', 'SLAM 建图状态', '建图当前位姿（TF 查询）', '导航目标', '巡航地图', '脉冲频率', '详情相对位置（估算）'];
  const before = Object.fromEntries(labels.map(label => [label, row(element.innerHTML, label)]));
  view.renderDetails(element, { receivedAt: null, upstreamAvailable: false }, {}, 0, 0, 121000);
  for (const label of labels) assert.equal(row(element.innerHTML, label), before[label], label);
  assert.match(element.innerHTML, /离线\/快照过期/);
  assert.match(element.innerHTML, /最近有效数据 · 120\.1 s/);
  assert.equal(row(element.innerHTML, '里程计年龄'), '120.1 s');
  assert.equal(row(element.innerHTML, '导航查询年龄'), '120.2 s');
  assert.match(element.innerHTML, /38487 ppm · 3\.849%/);
  assert.match(element.innerHTML, /2\.344 V/);
  assert.match(element.innerHTML, /data-ugv-map="map_a"/);
  assert.match(element.innerHTML, /查看导航路径点/);
  assert.match(element.innerHTML, /STEP GPIO/);
  assert.equal(view.snapshotFresh({}, 0), false);
  assert.equal(view.mechanismState({}, {}, 0, 0).state, '机构未连接');
  assert.equal(view.section({}, 'navigation', 0), null);
  assert.equal(view.cameraState({}, 'front', 0).valid, false);
  assert.equal(JSON.stringify({ data, details }), original, '展示缓存不能写回实时契约');
});

test('单字段失效保留该字段，新鲜字段独立更新；明确换源后不能展示其他车辆历史', () => {
  const view = load(), element = container(), data = fixture();
  view.renderDetails(element, data, detailsFixture(), 0, 0, 1000);
  const changed = fixture();
  changed.gps.fix = { status: 0, latitude: null, longitude: 121.5, altitude: null };
  changed.metrics.temperature = { valid: false, value: null };
  changed.metrics.humidity.value = 51;
  view.renderDetails(element, changed, {}, 0, 0, 2000);
  assert.equal(row(element.innerHTML, 'GPS 纬度 / 经度'), '0.0000000 ° / 121.5000000 °');
  assert.equal(row(element.innerHTML, '环境温度 / 相对湿度'), '25.0 °C / 51.0 %RH');
  view.renderDetails(element, { sourceIdentity: 'car-b' }, {}, 0, 0, 3000);
  assert.equal(row(element.innerHTML, 'GPS 纬度 / 经度'), '— / —');
  assert.equal(row(element.innerHTML, '行驶速度（模长）'), '—');
  assert.doesNotMatch(element.innerHTML, /data-ugv-map="map_a"/);
});

test('页面首次载入可显示后端 lastValid 的数字与ADC历史，随后缺包不清空且不伪造报警', () => {
  const view = load(), element = container();
  const data = { sourceIdentity: 'car-a', metrics: { speed: { value: null, valid: false, lastValid: { value: 0, ageS: 8 } } }, environment: { sensors: {
    flame: { digital: { valid: false, lastValid: { value: true, ageS: 6 } } },
    smoke: { digital: { valid: false, lastValid: { value: false, ageS: 6 } }, analog: {
      valid: false, voltageLastValid: { value: 2.344, ageS: 8 }, rawLastValid: { value: 120, ageS: 8 }, referenceEstimate: { lastValid: { value: 38486.886, ageS: 8 } }
    } }
  } } };
  const flame = view.flameState(data, 2, 10000);
  assert.equal(flame.text, '已触发'); assert.equal(flame.retained, true); assert.equal(flame.valid, false); assert.equal(flame.triggered, null);
  assert.equal(flame.color, 'var(--muted)'); assert.equal(flame.ageS, 8);
  view.renderDetails(element, data, {}, 2, 0, 10000);
  view.renderDetails(element, {}, {}, 0, 0, 20000);
  assert.equal(row(element.innerHTML, '行驶速度（模长）'), '0.00 m/s');
  assert.match(element.innerHTML, /2\.344 V/);
  assert.match(element.innerHTML, /38487 ppm · 3\.849%/);
  assert.match(element.innerHTML, /最近有效数据 · 20\.0 s/);
  assert.equal(view.flameState({}, 0, 20000).ageS, 18);
});

test('没有有效样本时仍为空白，不把无效数字、未知触发或 rawSnapshot 诊断当测量', () => {
  const view = load(), element = container();
  const data = { receivedAt: 'now', snapshotAgeS: 0, metrics: { speed: { valid: false, value: 500, rawValue: 500 } },
    rawSnapshot: { odom: { pose: [1, 2, 3] } }, environment: { sensors: { sound: { digital: { available: true, valid: false, ageS: 0 } } } } };
  view.renderDetails(element, data, {}, 0, 0, 1000);
  assert.equal(row(element.innerHTML, '行驶速度（模长）'), '—');
  assert.equal(row(element.innerHTML, '里程计位姿（odom）'), '—');
  assert.equal(view.flameState({}, 0).text, '—');
  assert.equal(view.soundState(data, 0).text, '待判定');
});
