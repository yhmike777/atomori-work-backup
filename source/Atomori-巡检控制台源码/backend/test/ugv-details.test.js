import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUgvStatus, normalizeUgvDetail } from '../src/ugv.js';
import { createUpstreamIntegrations } from '../src/upstream.js';

test('车端完整快照保留网关、巡航、GPIO、定位、机构和诊断参数', () => {
  const raw = {
    server_time_ms: 1791943200000, gateway: { ok: true, service: 'car-web-gateway', schema_version: '1.0', uptime_s: 42, camera_backend: true },
    avoidance: { available: true, cruise_enabled: false }, odom: { pose: [0, 0, 0], speed_mps: 0 },
    topic_ages_s: { odom: 0.1, ugv_control_mux: 0.2, ugv_command_gateway: 0.3, scan: 0.1 },
    environment: { available: true, stale: false, temperature_c: 0, humidity_percent: 0, age_s: 0.1, consecutive_errors: 0, updated_at: 1, last_attempt_at: 2, sampled_at: 3,
      digital: { mq2: { available: true, stale: false, triggered: false, age_s: 0.1, gpio: 18, level: 1, raw_level: 0, active_level: 0, changes: 0 } } },
    gps: { fix: { status: 0, latitude: 0, longitude: 0, altitude: 0 }, age_s: 0.1 },
    ultrasonic: { range: 0, age_s: 0.1 }, battery_voltage: null,
    localization: { active: true, state: 'localized', map_pose: [0, 0, 0], xy_sigma_m: 0, yaw_sigma_rad: 0, age_s: 0.1 },
    map: { info: { width: 600, height: 400, resolution: 0.05, origin: [0, 0, 0] }, age_s: 500 },
    mapping: { active: false, since_s: null }, leadscrew: { status: { state: [4, 4], pos_mm: [0, 0], enabled: [false, true] }, closed: true, age_s: 0.1 },
    camera: { ready: true, age_s: 0.2 }, camera_rear: { ready: false, age_s: null },
    ugv_control_mux: { authority: 'operator_steering', emergency_stop: false, output_linear_mps: 0 },
    ugv_command_gateway: { enabled: false, reason: 'disabled', output_linear_mps: 0 }
  };
  const data = normalizeUgvStatus(raw, 0.2);
  assert.deepEqual(data.gateway, raw.gateway);
  assert.equal(data.avoidance.cruise_enabled, false);
  assert.equal(data.environment.digital.mq2.changes, 0);
  assert.equal(data.environment.digital.mq2.rawLevel, 0);
  assert.equal(data.environment.digital.mq2.activeLevel, 0);
  assert.equal(data.environment.digital.mq2.triggered, false);
  assert.equal(data.environment.consecutiveErrors, 0);
  assert.equal(data.metrics.speed.value, 0);
  assert.equal(data.metrics.ultrasonic.value, 0);
  assert.deepEqual(data.gps.fix, raw.gps.fix);
  assert.deepEqual(data.map.info, raw.map.info, '历史栅格元数据保留，但有独立年龄');
  assert.equal(data.controlMux.authority, 'operator_steering');
  assert.equal(data.commandGateway.enabled, false);
  assert.equal(data.cameraTop.age_s, null, '不编造该版本未提供的俯视帧龄');
  assert.strictEqual(data.rawSnapshot, raw);
  assert.ok(Math.abs(data.gps.ageS - 0.3) < 1e-10);
});

test('上游查询耗时计入传感器年龄，负年龄、负速度和缺失值不会成为有效读数', () => {
  const raw = { odom: { speed_mps: 0.2 }, topic_ages_s: { odom: 0.1 },
    environment: { available: true, stale: false, temperature_c: 24, humidity_percent: 50, age_s: 0.1 },
    ultrasonic: { range: 1, age_s: 0.1 }, gps: { age_s: -1 }, camera: { age_s: '0.1' } };
  const delayed = normalizeUgvStatus(raw, 2.1);
  assert.equal(delayed.metrics.speed.valid, false);
  assert.equal(delayed.metrics.ultrasonic.value, null);
  assert.equal(delayed.metrics.temperature.value, 24, '温湿度独立使用 10 秒有效期');
  assert.equal(delayed.gps.ageS, null);
  assert.equal(delayed.camera.age_s, null);
  raw.odom.speed_mps = -0.1;
  assert.equal(normalizeUgvStatus(raw).metrics.speed.value, null, '原网关上报速度模长');
  assert.equal(normalizeUgvStatus({}).observedAt, null);
});

test('导航与地图列表只接受有效坐标和安全文件名，保留合法的零值', () => {
  const nav = normalizeUgvDetail('navigation', { active: false, has_map: true, goal: [0, 0], path: [[0, 0], [1, 2], ['3', 4], null] });
  assert.equal(nav.active, false);
  assert.deepEqual(nav.goal, [0, 0]);
  assert.deepEqual(nav.path, [[0, 0], [1, 2]]);
  assert.deepEqual(normalizeUgvDetail('maps', { maps: ['map_one', '../secrets', 'map_one', 'map_two', 1, '<script>'] }).names, ['map_one', 'map_two']);
  assert.equal(normalizeUgvDetail('maps', {}).names, null);
  assert.equal(normalizeUgvDetail('autoCruise', { active: 'true', initial: [0, 0] }).active, null);
});

test('单个旧网关详情接口缺失不影响其他详情或基础遥测，所有上游请求为 GET', async () => {
  const calls = [];
  const integrations = createUpstreamIntegrations({ carUrl: 'http://127.0.0.1:8765', fetchImpl: async (input, options) => {
    calls.push([new URL(input).pathname, options.method || 'GET']);
    if (input.endsWith('/api/nav/status')) return new Response('', { status: 404 });
    if (input.endsWith('/api/maps')) return Response.json({ maps: ['map_one'] });
    if (input.endsWith('/api/auto_cruise/status')) return Response.json({ active: false, initial: [0, 0] });
    if (input.endsWith('/api/leadscrew/manual/status')) return Response.json({ available: false, message: 'node offline' });
    return Response.json({ odom: { speed_mps: 0 }, topic_ages_s: { odom: 0.1 } });
  } });
  const details = await integrations.vehicleDetails();
  assert.equal(details.sections.navigation.available, false);
  assert.equal(details.sections.navigation.data, null);
  assert.deepEqual(details.sections.maps.data.names, ['map_one']);
  assert.equal(details.sections.autoCruise.data.active, false);
  assert.equal(details.sections.mechanism.data.available, false, 'HTTP 可达不等于机构在线');
  assert.equal((await integrations.telemetry('UGV-01')).odom.speedMps, 0);
  assert.deepEqual(calls.map(([path]) => path).sort(), ['/api/auto_cruise/status', '/api/leadscrew/manual/status', '/api/maps', '/api/nav/status', '/api/status'].sort());
  assert.ok(calls.every(([, method]) => method === 'GET'));
  await assert.rejects(integrations.command({}), error => error.code === 'COMMAND_ADAPTER_NOT_CONFIGURED');
});

test('详情并发查询不阻塞基础遥测，先返回的快照累计同批等待时间', async () => {
  let release, waiting;
  const started = new Promise(done => { waiting = done; });
  const hold = new Promise(done => { release = done; });
  const integrations = createUpstreamIntegrations({ carUrl: 'http://127.0.0.1:8765', fetchImpl: async input => {
    if (input.endsWith('/api/leadscrew/manual/status')) { waiting(); await hold; }
    return Response.json(input.endsWith('/api/status') ? { odom: { speed_mps: 0 }, topic_ages_s: { odom: 0.1 } } : { available: true, maps: [], active: false });
  } });
  const pending = integrations.vehicleDetails();
  await started;
  assert.equal((await integrations.telemetry('UGV-01')).odom.speedMps, 0);
  await new Promise(done => setTimeout(done, 45));
  release();
  const details = await pending;
  assert.ok(details.sections.maps.ageS >= 0.04);
  assert.ok(details.sections.navigation.ageS >= 0.04);
});
