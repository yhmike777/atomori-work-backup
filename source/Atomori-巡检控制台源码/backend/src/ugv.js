import { lastValidSample } from './last-valid.js';

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

function analogChannels(input, elapsedS) {
  const raw = object(input), ageS = age(raw.age_s, elapsedS), maxAgeS = 2;
  const available = raw.available === true && raw.stale !== true && ageS !== null && ageS <= maxAgeS;
  const referenceV = number(raw.reference_v);
  const channels = Object.fromEntries(['sound', 'mq2', 'flame'].map(key => {
    const channel = object(object(raw.channels)[key]);
    const voltage = number(channel.adc_voltage_v), count = number(channel.raw);
    const valid = available && Number.isInteger(count) && count >= 0 && voltage !== null && voltage >= 0
      && (referenceV === null || (referenceV > 0 && voltage <= referenceV));
    const reference = object(channel.reference_estimate), relative = object(channel.relative_intensity);
    const referenceValid = valid && reference.status === 'reference_only' && number(reference.ppm) !== null && reference.ppm >= 0;
    const relativeValid = valid && relative.status === 'relative_only' && number(relative.percent) !== null && relative.percent >= 0 && relative.percent <= 100;
    return [key, { valid, available, ageS, maxAgeS, channel: number(channel.channel), raw: valid ? count : null,
      voltageV: valid ? voltage : null, source: `environment.analog.channels.${key}`,
      // These values are device model estimates, never calibrated gas measurements.
      referenceEstimate: { valid: referenceValid, ppm: referenceValid ? reference.ppm : null,
        status: text(reference.status), method: text(reference.method), calibrated: bool(reference.calibrated),
        r0Assumed: bool(reference.r0_assumed), heatingVerified: bool(reference.heating_verified), parameters: object(reference.parameters) },
      relativeIntensity: { valid: relativeValid, percent: relativeValid ? relative.percent : null,
        status: text(relative.status), method: text(relative.method), calibrated: bool(relative.calibrated), parameters: object(relative.parameters) } }];
  }));
  return { available, ageS, maxAgeS, channels, referenceV, updatedAt: number(raw.updated_at), error: text(raw.error) };
}

export function normalizeUgvStatus(input, elapsedS = 0, { includeLastValid = true } = {}) {
  const raw = object(input), odom = object(raw.odom), gps = object(raw.gps), environment = object(raw.environment);
  const ages = Object.fromEntries(Object.entries(object(raw.topic_ages_s)).map(([key, value]) => [key, age(value, elapsedS)]));
  const environmentAge = age(environment.age_s, elapsedS);
  const environmentAvailable = environment.available === true && environment.stale === false;
  // Match the car gateway's 15 s DHT11 last-success window; failed reads do not renew age.
  const metrics = {
    speed: metric(odom.speed_mps, ages.odom ?? null, 'm/s', '/odom.twist · 速度模长', 2, { min: 0 }),
    temperature: metric(environment.temperature_c, environmentAge, '°C', 'environment.temperature_c', 15, { available: environmentAvailable, min: -40, max: 80 }),
    humidity: metric(environment.humidity_percent, environmentAge, '%RH', 'environment.humidity_percent', 15, { available: environmentAvailable, min: 0, max: 100 }),
    ultrasonic: metric(object(raw.ultrasonic).range, age(object(raw.ultrasonic).age_s, elapsedS), 'm', '/ultrasonic/range', 2, { min: 0 }),
    ultrasonicLeft: metric(object(raw.ultrasonic_left).range, age(object(raw.ultrasonic_left).age_s, elapsedS), 'm', 'ultrasonic_left.range', 2, { min: 0 }),
    ultrasonicRight: metric(object(raw.ultrasonic_right).range, age(object(raw.ultrasonic_right).age_s, elapsedS), 'm', 'ultrasonic_right.range', 2, { min: 0 })
  };
  const digital = Object.fromEntries(['sound', 'alcohol', 'flame', 'mq2'].map(key => {
    const sensor = object(object(environment.digital)[key]);
    const ageS = age(sensor.age_s, elapsedS);
    const available = sensor.available === true && sensor.stale === false && ageS !== null && ageS <= 2;
    const valid = available && bool(sensor.triggered) !== null;
    return [key, { triggered: valid ? sensor.triggered : null, valid, available, ageS, maxAgeS: 2, source: `environment.digital.${key}`,
      gpio: number(sensor.gpio), level: number(sensor.level), rawLevel: number(sensor.raw_level), activeLevel: number(sensor.active_level), changes: number(sensor.changes) }];
  }));
  const analog = analogChannels(environment.analog, elapsedS);
  // Verified against the H100 car gateway's served HTML: historical `sound` is
  // MQ-7, while historical `alcohol` is the sound switch. Preserve raw keys too.
  const sensors = {
    smoke: { label: '烟雾 MQ-2', digital: digital.mq2, analog: analog.channels.mq2 },
    carbonMonoxide: { label: '一氧化碳 MQ-7', digital: digital.sound, analog: analog.channels.sound },
    flame: { label: '火焰', digital: digital.flame, analog: analog.channels.flame },
    sound: { label: '声音', digital: digital.alcohol }
  };
  const observed = number(raw.server_time_ms) === null ? null : new Date(raw.server_time_ms);
  const timed = value => ({ ...object(value), age_s: age(object(value).age_s, elapsedS) });
  const result = {
    deviceId: 'UGV-01', source: 'car-rpi-deploy', receivedAt: new Date().toISOString(), snapshotAgeS: elapsedS, snapshotMaxAgeS: 3,
    observedAt: observed && Number.isFinite(observed.getTime()) ? observed.toISOString() : null,
    gateway: object(raw.gateway), avoidance: object(raw.avoidance),
    odom: { pose: vector(odom.pose, 3), speedMps: metrics.speed.value, ageS: ages.odom ?? null },
    metrics, topicAgesS: ages,
    environment: { temperatureC: metrics.temperature.value, humidityPercent: metrics.humidity.value,
      ageS: environmentAge, available: environmentAvailable, digital, analog, sensors, error: text(environment.error),
      consecutiveErrors: number(environment.consecutive_errors), updatedAt: number(environment.updated_at),
      lastAttemptAt: number(environment.last_attempt_at), sampledAt: number(environment.sampled_at) },
    ultrasonic: { rangeM: metrics.ultrasonic.value, ageS: metrics.ultrasonic.ageS },
    ultrasonicLeft: { rangeM: metrics.ultrasonicLeft.value, ageS: metrics.ultrasonicLeft.ageS },
    ultrasonicRight: { rangeM: metrics.ultrasonicRight.value, ageS: metrics.ultrasonicRight.ageS },
    gps: { fix: gps.fix ?? null, ageS: age(gps.age_s, elapsedS) },
    batteryVoltage: number(raw.battery_voltage),
    camera: timed(raw.camera), cameraRear: timed(raw.camera_rear), cameraTop: timed(raw.camera_top),
    localization: timed(raw.localization), map: timed(raw.map),
    mapping: object(raw.mapping), leadscrew: timed(raw.leadscrew),
    controlMux: object(raw.ugv_control_mux), commandGateway: object(raw.ugv_command_gateway),
    // 保留完整原始快照供折叠诊断查看；展示层不会把这些未过滤的缓存当作实时读数。
    rawSnapshot: raw
  };
  if (includeLastValid) {
    const before = elapsedS === 0 ? result : normalizeUgvStatus(input, 0, { includeLastValid: false });
    for (const [key, item] of Object.entries(result.metrics)) item.lastValid = lastValidSample(before.metrics[key], elapsedS);
    for (const [key, item] of Object.entries(result.environment.digital)) {
      const sample = before.environment.digital[key];
      item.lastValid = lastValidSample({ ...sample, value: sample.triggered, unit: '' }, elapsedS);
    }
    for (const [key, item] of Object.entries(result.environment.analog.channels)) {
      const sample = before.environment.analog.channels[key];
      item.voltageLastValid = lastValidSample({ ...sample, value: sample.voltageV, unit: 'V' }, elapsedS);
      item.rawLastValid = lastValidSample({ ...sample, value: sample.raw, unit: 'ADC' }, elapsedS);
      for (const [field, valueKey, unit] of [['referenceEstimate', 'ppm', 'ppm'], ['relativeIntensity', 'percent', '%']]) {
        item[field].lastValid = lastValidSample({ ...sample, ...sample[field], value: sample[field][valueKey], unit }, elapsedS);
      }
    }
  }
  return result;
}

export function retainUgvSamples(result, cache, identity, options) {
  cache.metrics(identity, 'metrics', result.metrics, options);
  for (const [key, item] of Object.entries(result.environment.digital)) cache.metric(identity, `digital.${key}`, item, options);
  for (const [key, item] of Object.entries(result.environment.analog.channels)) {
    for (const [property, unit] of [['voltageLastValid', 'V'], ['rawLastValid', 'ADC']]) cache.metric(identity, `analog.${key}.${property}`, item, { ...options, property, unit });
    for (const field of ['referenceEstimate', 'relativeIntensity']) {
      // Nested model estimates inherit the ADC sample's source/age, never a raw number.
      const holder = { ...item[field], source: item.source, unit: field === 'referenceEstimate' ? 'ppm' : '%' };
      cache.metric(identity, `analog.${key}.${field}`, holder, options);
      item[field].lastValid = holder.lastValid;
    }
  }
  return result;
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
