import { lastValidSample } from './last-valid.js';

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value, fallback = '', length = 512) => typeof value === 'string' ? value.slice(0, length) : fallback;
const addAge = (value, elapsedS) => finite(value) !== null && value >= 0 ? value + elapsedS : null;
const positive = value => finite(value) !== null && value > 0 ? value : null;
const vector = value => ['x', 'y', 'z'].every(axis => finite(object(value)[axis]) !== null);
// Raw scalar diagnostics are not measurements: retain false/strings without
// converting them into valid numbers or dropping the evidence of an invalid input.
const rawScalar = value => typeof value === 'boolean' ? value : typeof value === 'string' ? value.slice(0, 512) : finite(value);

// These already have rows in the details page. A legacy bridge that has no extension
// contract is different from a connected bridge that has not received a sample yet.
const commonMetrics = {
  batteryCurrent: ['电池电流', '电池', 'A', 2],
  airspeed: ['空速', '速度', 'm/s', 2], groundspeed: ['地速', '速度', 'm/s', 2],
  latitude: ['纬度', 'GPS', '°', 7], longitude: ['经度', 'GPS', '°', 7],
  satellites: ['GPS 卫星数', 'GPS', '', 0], hdop: ['GPS HDOP', 'GPS', '', 2], gpsFix: ['GPS 定位等级', 'GPS', '', 0],
  vibrationX: ['X 轴振动', '估计器', 'm/s²', 2], vibrationY: ['Y 轴振动', '估计器', 'm/s²', 2], vibrationZ: ['Z 轴振动', '估计器', 'm/s²', 2],
  ekfFlags: ['EKF 状态标志', '估计器', '', 0], cpuLoad: ['飞控负载', '系统', '%', 1]
};

function metric(raw, elapsedS, connected, defaults) {
  const item = object(raw), ageS = addAge(item.age_s, elapsedS), maxAgeS = positive(item.max_age_s);
  const value = finite(item.value);
  let reason = 'VALID';
  if (!connected) reason = 'FLIGHT_CONTROLLER_DISCONNECTED';
  else if (item.valid !== true) reason = text(item.reason, 'NO_VALID_SAMPLE', 80) || 'NO_VALID_SAMPLE';
  else if (value === null) reason = 'NO_VALID_SAMPLE';
  else if (typeof item.unit !== 'string' || typeof item.source !== 'string' || !item.source.trim() || maxAgeS === null) reason = 'INVALID_METADATA';
  else if (defaults && item.unit !== defaults[2]) reason = 'INVALID_METADATA';
  else if (ageS === null) reason = 'UNKNOWN_AGE';
  else if (ageS > maxAgeS) reason = 'STALE';
  if (item.valid !== true && reason === 'VALID') reason = 'NO_VALID_SAMPLE';
  return {
    value: reason === 'VALID' ? value : null,
    rawValue: rawScalar(Object.hasOwn(item, 'raw_value') ? item.raw_value : item.value),
    unit: text(item.unit, defaults?.[2] || '', 32), source: text(item.source, '未上报'),
    ageS, maxAgeS, ageBasis: text(item.age_basis, 'bridge_receive_monotonic', 80),
    valid: reason === 'VALID', reason,
    label: text(item.label, defaults?.[0], 120), group: text(item.group, defaults?.[1] || '其他遥测', 80),
    digits: Number.isInteger(item.digits) && item.digits >= 0 && item.digits <= 10 ? item.digits : defaults?.[3] ?? 2
  };
}

function diagnostic(data, age, maxAgeS, source, elapsedS, { available = true, usable = true, state = 'VALID' } = {}) {
  if (!available) return null;
  const ageS = addAge(age, elapsedS);
  const status = ageS === null ? 'NO_SAMPLE' : ageS > maxAgeS ? 'STALE' : !usable ? state : 'VALID';
  return { data, ageS, maxAgeS, source, valid: status === 'VALID', status };
}

export function normalizeFlightDetails(raw, elapsedS, connected, { sourceConnected = connected } = {}) {
  const flight = object(raw), extraAvailable = !!flight.extra_metrics && typeof flight.extra_metrics === 'object' && !Array.isArray(flight.extra_metrics);
  const extras = object(flight.extra_metrics), metrics = {};
  for (const [key, defaults] of Object.entries(commonMetrics)) {
    if (Object.hasOwn(extras, key)) continue;
    metrics[key] = { value: null, rawValue: null, unit: defaults[2], source: '未上报', ageS: null, maxAgeS: null,
      valid: false, reason: extraAvailable ? 'NO_SAMPLE' : 'NOT_CONNECTED', label: defaults[0], group: defaults[1], digits: defaults[3], lastValid: null };
  }
  for (const [key, item] of Object.entries(extras)) {
    if (!/^[a-z][A-Za-z0-9]{0,79}$/.test(key) || ['constructor', 'prototype'].includes(key)) continue;
    metrics[key] = { ...metric(item, elapsedS, connected, commonMetrics[key]),
      lastValid: lastValidSample(metric(item, 0, sourceConnected, commonMetrics[key]), elapsedS) };
  }
  const sourcesAvailable = Array.isArray(flight.telemetry_sources);
  const telemetrySources = (sourcesAvailable ? flight.telemetry_sources : []).filter(item => typeof item?.topic === 'string').map(rawItem => {
    const item = object(rawItem), ageS = addAge(item.age_s, elapsedS), maxAgeS = positive(item.max_age_s);
    const count = Number.isSafeInteger(item.count) && item.count >= 0 ? item.count : null;
    const sourceStatus = text(item.status, 'UNKNOWN', 80);
    const valid = count !== null && count > 0 && ageS !== null && maxAgeS !== null && ageS <= maxAgeS && sourceStatus === 'RECEIVING';
    const status = ['UNSUPPORTED_TYPE', 'NOT_AVAILABLE', 'NOT_CONNECTED'].includes(sourceStatus) ? sourceStatus
      : count === null ? 'INVALID_METADATA' : ageS !== null && maxAgeS !== null && ageS > maxAgeS ? 'STALE'
      : count === 0 ? 'NO_SAMPLE' : ageS === null || maxAgeS === null ? 'UNKNOWN_AGE' : sourceStatus;
    return { topic: text(item.topic), messageType: text(item.message_type), count, ageS, maxAgeS, status, valid,
      ageBasis: text(item.age_basis, 'bridge_receive_monotonic', 80), receivedAgeS: addAge(item.received_age_s, elapsedS),
      data: item.data ?? null, error: text(item.error, null) };
  });

  const command = object(flight.motion_command), commandAvailable = Object.keys(command).length > 0;
  const motionCommand = diagnostic(command, command.age_s, 0.5, text(command.source, '/mavros/setpoint_raw/local'), elapsedS,
    { available: commandAvailable, usable: connected && command.state === 'READY' && vector(command.body_velocity_mps),
      state: !connected ? 'FLIGHT_CONTROLLER_DISCONNECTED' : command.state === 'READY' ? 'NO_VALID_SAMPLE' : text(command.state, 'INVALID') });
  const executorData = Object.fromEntries(Object.entries(flight).filter(([key]) => [
    'action', 'action_state', 'action_detail', 'control_owner', 'executor_version', 'follow_active', 'landing_active',
    'landing_requested', 'mode_gate', 'latest_sent_velocity_mps'
  ].includes(key) || /^(target_echo_|tone_|orphaned_guided_)/.test(key)));
  const executor = diagnostic(executorData, flight.guided_executor_age_s, 2, '机载执行器状态', elapsedS,
    { available: Object.hasOwn(flight, 'guided_executor_age_s') || Object.keys(executorData).length > 0 });
  const velocityData = Object.fromEntries(Object.entries(flight).filter(([key]) => [
    'body_velocity_mps', 'body_velocity_frame', 'horizontal_direction', 'lateral_direction', 'vertical_direction', 'velocity_deadband_mps'
  ].includes(key)));
  const velocity = diagnostic(velocityData, flight.velocity_age_s, 1, '/mavros/local_position/velocity_body', elapsedS,
    { available: Object.keys(velocityData).length > 0, usable: connected && ['base_link', 'BODY_FLU'].includes(flight.body_velocity_frame) && vector(flight.body_velocity_mps),
      state: !connected ? 'FLIGHT_CONTROLLER_DISCONNECTED' : !['base_link', 'BODY_FLU'].includes(flight.body_velocity_frame) ? 'FRAME_UNAVAILABLE' : 'NO_VALID_SAMPLE' });

  const details = { metrics, extraTelemetryStatus: extraAvailable ? 'CONNECTED' : 'NOT_CONNECTED',
    telemetrySources, telemetrySourcesStatus: sourcesAvailable ? 'CONNECTED' : 'NOT_CONNECTED',
    motionCommand, motionCommandStatus: motionCommand?.status || 'NOT_CONNECTED',
    executor, executorStatus: executor?.status || 'NOT_CONNECTED',
    velocity, velocityStatus: velocity?.status || 'NOT_CONNECTED' };
  if (Array.isArray(flight.health)) {
    details.healthAgeS = addAge(flight.health_age_s, elapsedS);
    details.healthMaxAgeS = 3;
    details.health = flight.health.filter(item => typeof item?.label === 'string' && typeof item?.state === 'string')
      .map(item => ({ label: text(item.label, '', 120), state: text(item.state, '', 120), source: text(item.source) }));
    details.healthValid = connected && details.health.length > 0 && details.healthAgeS !== null && details.healthAgeS <= 3;
  }
  if (Array.isArray(flight.alerts)) {
    details.alerts = flight.alerts.filter(item => typeof item?.text === 'string' && Number.isInteger(item.severity) && item.severity >= 0 && item.severity <= 7)
      .map(item => { const ageS = addAge(item.age_s, elapsedS); return { severity: item.severity, text: text(item.text, '', 2000), ageS, maxAgeS: 30,
        valid: connected && ageS !== null && ageS <= 30 }; });
  }
  return details;
}
