// CAR web_gateway.py 的只读契约。传感器年龄与 HTTP 查询时间分开处理。
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const bool = value => typeof value === 'boolean' ? value : null;
const text = value => typeof value === 'string' ? value : null;
const vector = (value, length) => Array.isArray(value) && value.length === length && value.every(item => number(item) !== null) ? value : null;
const age = (value, elapsed) => number(value) !== null && value >= 0 ? value + elapsed : null;

function metric(value, ageS, unit, source, maxAgeS, { available = true, min = -Infinity, max = Infinity } = {}) {
  const valid = available && number(value) !== null && value >= min && value <= max && ageS !== null && ageS <= maxAgeS;
  return { value: valid ? value : null, ageS, maxAgeS, unit, source, valid,
    reason: valid ? 'VALID' : !available ? 'UNAVAILABLE_OR_STALE' : number(value) === null || value < min || value > max ? 'NO_VALID_SAMPLE' : 'STALE_OR_UNKNOWN_AGE' };
}

export function normalizeUgvStatus(input, elapsedS = 0) {
  const raw = object(input), odom = object(raw.odom), gps = object(raw.gps), environment = object(raw.environment);
  const ages = Object.fromEntries(Object.entries(object(raw.topic_ages_s)).map(([key, value]) => [key, age(value, elapsedS)]));
  const environmentAge = age(environment.age_s, elapsedS);
  const environmentAvailable = environment.available === true && environment.stale === false;
  const metrics = {
    speed: metric(odom.speed_mps, ages.odom ?? null, 'm/s', '/odom.twist · 速度模长', 2, { min: 0 }),
    temperature: metric(environment.temperature_c, environmentAge, '°C', 'environment.temperature_c', 10, { available: environmentAvailable, min: -40, max: 80 }),
    humidity: metric(environment.humidity_percent, environmentAge, '%RH', 'environment.humidity_percent', 10, { available: environmentAvailable, min: 0, max: 100 }),
    ultrasonic: metric(object(raw.ultrasonic).range, age(object(raw.ultrasonic).age_s, elapsedS), 'm', '/ultrasonic/range', 2, { min: 0 })
  };
  const digital = Object.fromEntries(['sound', 'flame', 'mq2'].map(key => {
    const sensor = object(object(environment.digital)[key]);
    const ageS = age(sensor.age_s, elapsedS);
    const available = sensor.available === true && sensor.stale === false && ageS !== null && ageS <= 2;
    const valid = available && bool(sensor.triggered) !== null;
    return [key, { triggered: valid ? sensor.triggered : null, valid, available, ageS, maxAgeS: 2, source: `environment.digital.${key}`,
      gpio: number(sensor.gpio), level: number(sensor.level), rawLevel: number(sensor.raw_level), activeLevel: number(sensor.active_level), changes: number(sensor.changes) }];
  }));
  const observed = number(raw.server_time_ms) === null ? null : new Date(raw.server_time_ms);
  const timed = value => ({ ...object(value), age_s: age(object(value).age_s, elapsedS) });
  return {
    deviceId: 'UGV-01', source: 'car-rpi-deploy', receivedAt: new Date().toISOString(), snapshotAgeS: elapsedS, snapshotMaxAgeS: 3,
    observedAt: observed && Number.isFinite(observed.getTime()) ? observed.toISOString() : null,
    gateway: object(raw.gateway), avoidance: object(raw.avoidance),
    odom: { pose: vector(odom.pose, 3), speedMps: metrics.speed.value, ageS: ages.odom ?? null },
    metrics, topicAgesS: ages,
    environment: { temperatureC: metrics.temperature.value, humidityPercent: metrics.humidity.value,
      ageS: environmentAge, available: environmentAvailable, digital, error: text(environment.error),
      consecutiveErrors: number(environment.consecutive_errors), updatedAt: number(environment.updated_at),
      lastAttemptAt: number(environment.last_attempt_at), sampledAt: number(environment.sampled_at) },
    ultrasonic: { rangeM: metrics.ultrasonic.value, ageS: metrics.ultrasonic.ageS },
    gps: { fix: gps.fix ?? null, ageS: age(gps.age_s, elapsedS) },
    batteryVoltage: number(raw.battery_voltage),
    camera: timed(raw.camera), cameraRear: timed(raw.camera_rear), cameraTop: timed(raw.camera_top),
    localization: timed(raw.localization), map: timed(raw.map),
    mapping: object(raw.mapping), leadscrew: timed(raw.leadscrew),
    controlMux: object(raw.ugv_control_mux), commandGateway: object(raw.ugv_command_gateway),
    // 保留完整原始快照供折叠诊断查看；展示层不会把这些未过滤的缓存当作实时读数。
    rawSnapshot: raw
  };
}

export function normalizeUgvDetail(section, input) {
  const raw = object(input);
  if (section === 'navigation') return { active: bool(raw.active), hasMap: bool(raw.has_map), goal: vector(raw.goal, 2),
    path: Array.isArray(raw.path) ? raw.path.map(point => vector(point, 2)).filter(Boolean) : null };
  if (section === 'autoCruise') return { active: bool(raw.active), initial: vector(raw.initial, 2), mapName: text(raw.map_name), mapInfo: object(raw.map_info) };
  if (section === 'maps') return { names: Array.isArray(raw.maps) ? [...new Set(raw.maps.filter(name => typeof name === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(name)))] : null };
  if (section === 'mechanism') return raw;
  throw new Error('未知车端详情资源');
}
