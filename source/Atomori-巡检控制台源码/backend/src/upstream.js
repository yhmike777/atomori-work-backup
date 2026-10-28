import { IntegrationUnavailableError, unconfiguredIntegrations } from './integrations.js';
import { normalizeUgvStatus, normalizeUgvDetail, retainUgvSamples } from './ugv.js';
import { normalizeFlightDetails } from './flight-details.js';
import { LastValidCache, lastValidSample } from './last-valid.js';

function origin(value, name) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} 必须是无凭据的 HTTP 服务根地址`);
  }
  return url.origin;
}

function unavailable(name) {
  throw new IntegrationUnavailableError('ADAPTER_NOT_CONFIGURED', `${name}地址尚未配置`);
}

function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

function ugvMetric(value, age, unit, source, maxAgeS, { available = true, min = -Infinity, max = Infinity } = {}) {
  const ageS = finite(age);
  const number = finite(value);
  const valid = available && number !== null && number >= min && number <= max && ageS !== null && ageS >= 0 && ageS <= maxAgeS;
  return { value: valid ? number : null, ageS, maxAgeS, unit, source, valid,
    reason: valid ? 'VALID' : !available ? 'UNAVAILABLE_OR_STALE' : number === null || number < min || number > max ? 'NO_VALID_SAMPLE' : 'STALE_OR_UNKNOWN_AGE' };
}

function pose(value) { return Array.isArray(value) && value.length === 3 && value.every(item => finite(item) !== null) ? value : null; }

function relativePose(raw, elapsedS) {
  const orientation = object(raw.orientation);
  const position = pose(orientation.position_body_frd_m);
  const captureAge = raw.capture_age_ms === undefined ? finite(raw.frame_age_ms) : finite(raw.capture_age_ms);
  const ageS = captureAge !== null && captureAge >= 0 ? captureAge / 1000 + elapsedS : null;
  let reason = 'VALID';
  if (raw.sensor !== 'ov9281') reason = 'VISION_UNAVAILABLE';
  else if (raw.found !== true) reason = 'TAG_NOT_DETECTED';
  else if (raw.quality_passed !== true || orientation.valid !== true) reason = 'QUALITY_REJECTED';
  else if (orientation.frame !== 'BODY_FRD' || orientation.source !== 'PNP_TAG_TO_PAD_TO_BODY' || !position || position[2] <= 0) reason = 'INVALID_POSE';
  else if (ageS === null || ageS > 2) reason = 'STALE_OR_UNKNOWN_AGE';
  const valid = reason === 'VALID';
  return {
    frame: 'BODY_FRD', source: 'OV9281 /api/status.orientation',
    tagId: Number.isInteger(raw.tag_id) && raw.tag_id >= 0 ? raw.tag_id : null,
    xM: valid ? position[0] : null, yM: valid ? position[1] : null, zM: valid ? position[2] : null,
    yawDeg: valid ? finite(orientation.pad_heading_body_deg) : null,
    ageS, maxAgeS: 2, ageBasis: raw.capture_age_ms === undefined ? 'analysis_completion' : 'capture',
    valid, reason,
    rangeCorrectionStatus: typeof raw.range_correction_status === 'string' ? raw.range_correction_status : null
  };
}

function flightMetric(flight, key, unit, source, maxAgeS, { legacy = false, min = -Infinity, max = Infinity } = {}) {
  const meta = object(object(flight.telemetry_meta)[key]);
  const value = finite(object(flight.telemetry)[key]);
  const ageS = finite(meta.age_s);
  const stateAge = finite(flight.vehicle_state_age_s);
  let reason = 'VALID';
  if (flight.flight_controller_connected !== true || stateAge === null || stateAge > 2 || stateAge < 0) reason = 'FLIGHT_CONTROLLER_DISCONNECTED';
  else if (value === null || value < min || value > max) reason = 'NO_VALID_SAMPLE';
  else if (Object.keys(meta).length) {
    if (meta.valid !== true || meta.unit !== unit || ageS === null || ageS < 0 || ageS > maxAgeS) reason = 'STALE_OR_INVALID';
  } else if (!legacy) reason = 'METADATA_NOT_REPORTED';
  return { value: reason === 'VALID' ? value : null, unit, source: typeof meta.source === 'string' ? meta.source : source,
    ageS, maxAgeS, ageBasis: meta.age_basis || (legacy ? 'upstream_bridge_validity_gate' : 'unreported'), valid: reason === 'VALID', reason };
}

export function createUpstreamIntegrations({ carUrl, uavVisionUrl, uavFlightUrl, uavVideoUrl, missionPlannerUrl, liveOnly = false, fetchImpl = fetch, now = () => performance.now() }) {
  const car = origin(carUrl, 'ATOMORI_CAR_URL');
  const vision = origin(uavVisionUrl, 'ATOMORI_UAV_VISION_URL');
  const flightStatus = origin(uavFlightUrl, 'ATOMORI_UAV_FLIGHT_URL');
  const video = origin(uavVideoUrl, 'ATOMORI_UAV_VIDEO_URL');
  const missionPlanner = origin(missionPlannerUrl, 'ATOMORI_MISSION_PLANNER_URL');
  const inFlightJson = new Map(), previousJson = new Map(), responseTiming = new WeakMap();
  const lastValid = new LastValidCache({ now });
  const elapsed = (raw, at = now()) => Math.max(0, (at - responseTiming.get(raw).startedAt) / 1000);
  const available = raw => responseTiming.get(raw)?.available !== false;
  const gatewayEpochs = new Map();
  const identity = (device, base, raw) => {
    const uptime = finite(raw.gateway?.uptime_s), previous = gatewayEpochs.get(base);
    if (device === 'UGV-01' && available(raw) && uptime !== null && uptime >= 0) {
      gatewayEpochs.set(base, { uptime, epoch: (previous?.epoch || 0) + (previous && uptime < previous.uptime ? 1 : 0) });
    }
    return JSON.stringify([device, base, raw.source || null,
      raw.transport?.systemId ?? null, raw.transport?.componentId ?? null, raw.transport?.peerIp ?? null,
      device === 'UGV-01' ? gatewayEpochs.get(base)?.epoch || 0 : null]);
  };

  function finishFlight(flight, sourceIdentity, sourceAvailable, at) {
    lastValid.metrics(sourceIdentity, 'flight.metrics', flight.metrics, { capture: sourceAvailable, at });
    lastValid.metrics(sourceIdentity, 'flight.details.metrics', flight.details?.metrics, { capture: sourceAvailable, at });
    if (!sourceAvailable) {
      flight.connected = false; flight.armed = null; flight.mode = 'DISCONNECTED'; flight.landedState = 'UNKNOWN';
      for (const key of ['estimatedAltitudeM', 'relativeAltitudeM', 'batteryVoltage', 'batteryPercent', 'rangefinderM', 'rollDeg', 'pitchDeg', 'verticalSpeedMps']) flight[key] = null;
      flight.details.healthValid = false;
      for (const item of flight.details.alerts || []) item.valid = false;
    }
    return flight;
  }

  function invalidateMeasurements(value) {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'valid')) {
      value.valid = false;
      if (Object.hasOwn(value, 'value')) value.value = null;
      for (const key of ['triggered', 'raw', 'voltageV', 'ppm', 'percent']) if (Object.hasOwn(value, key)) value[key] = null;
      if (Object.hasOwn(value, 'reason')) value.reason = 'UPSTREAM_UNAVAILABLE';
    }
    for (const [key, item] of Object.entries(value)) {
      if (!['lastValid', 'rawLastValid', 'voltageLastValid', 'rawSnapshot', 'data'].includes(key)) invalidateMeasurements(item);
    }
  }

  async function request(base, path, timeoutMs = 2500, { streaming = false, signal } = {}) {
    // MJPEG 只限制建连时间，收到响应头后必须取消计时；有限请求仍限制整个响应。
    const controller = streaming ? new AbortController() : null;
    const timer = streaming ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const timeoutSignal = controller?.signal || AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(base + path, { signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal, cache: 'no-store' });
    } catch {
      throw new IntegrationUnavailableError('UPSTREAM_UNAVAILABLE', '上游设备服务不可达');
    } finally { if (timer) clearTimeout(timer); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new IntegrationUnavailableError('UPSTREAM_UNAVAILABLE', `上游设备服务返回 ${response.status}`);
    }
    return response;
  }

  async function readJson(base, path) {
    const startedAt = now();
    const response = await request(base, path);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 2_000_000) {
      await response.body?.cancel();
      throw new IntegrationUnavailableError('UPSTREAM_INVALID', '上游响应过大');
    }
    let value;
    try {
      const raw = await response.text();
      if (raw.length > 2_000_000) throw new Error('too large');
      value = JSON.parse(raw);
    } catch {
      throw new IntegrationUnavailableError('UPSTREAM_INVALID', '上游响应不是有效 JSON');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IntegrationUnavailableError('UPSTREAM_INVALID', '上游响应格式错误');
    responseTiming.set(value, { startedAt, available: true });
    return value;
  }

  async function requestJson(base, path, { retainOnFailure = false } = {}) {
    const key = base + path;
    let pending = inFlightJson.get(key);
    if (!pending) {
      pending = readJson(base, path).finally(() => inFlightJson.delete(key));
      inFlightJson.set(key, pending);
    }
    try {
      const raw = await pending;
      if (retainOnFailure) {
        previousJson.delete(key); previousJson.set(key, raw);
        while (previousJson.size > 8) previousJson.delete(previousJson.keys().next().value);
      }
      return raw;
    } catch (error) {
      const previous = retainOnFailure && previousJson.get(key);
      if (!previous || elapsed(previous) > 300) throw error;
      // Reuse only the raw response for re-normalization. Its original monotonic
      // request start remains the age origin; an error is never a fresh sample.
      const raw = structuredClone(previous);
      responseTiming.set(raw, { ...responseTiming.get(previous), available: false, error: error.code });
      return raw;
    }
  }

  return {
    status() { return { carConfigured: !!car, uavVideoConfigured: !!(video || car), uavVisionConfigured: !!vision, uavFlightConfigured: !!flightStatus, missionPlannerConfigured: !!missionPlanner, uavFlightSource: missionPlanner ? 'mission-planner' : flightStatus ? 'raspberry-pi' : null, liveOnly: liveOnly === true, mode: car || video || vision || flightStatus || missionPlanner ? 'upstream-readonly' : 'demo', commandsEnabled: false }; },
    async missionPlanner() {
      if (!missionPlanner) unavailable('Mission Planner MAVLink 接收服务');
      const snapshot = await requestJson(missionPlanner, '/api/status', { retainOnFailure: true });
      if (snapshot.source !== 'mission-planner-mavlink' || snapshot.deviceId !== 'UAV-01' || typeof snapshot.flight?.connected !== 'boolean') {
        throw new IntegrationUnavailableError('UPSTREAM_INVALID', 'Mission Planner 遥测响应无效');
      }
      const normalizationTime = now(), snapshotAgeS = elapsed(snapshot, normalizationTime), sourceAvailable = available(snapshot);
      const sourceIdentity = identity('UAV-01:mission-planner', missionPlanner, snapshot);
      const normalizedAt = new Date().toISOString();
      const addAge = value => finite(value) !== null && value >= 0 ? value + snapshotAgeS : null;
      const flight = snapshot.flight;
      const stateAgeS = addAge(flight.stateAgeS);
      const connected = sourceAvailable && flight.connected === true && stateAgeS !== null && stateAgeS <= 2;
      const sourceConnected = flight.connected === true && finite(flight.stateAgeS) !== null && flight.stateAgeS >= 0 && flight.stateAgeS <= 2;
      const normalizeMetrics = input => Object.fromEntries(Object.entries(object(input)).map(([key, raw]) => {
        const item = object(raw), ageS = addAge(item.ageS), maxAgeS = finite(item.maxAgeS);
        const value = finite(item.value);
        const hasValue = value !== null && (key !== 'batteryVoltage' || value > 0);
        const valid = connected && item.valid === true && hasValue && ageS !== null && maxAgeS !== null && ageS <= maxAgeS;
        return [key, { ...item, ageS, valid, value: valid ? value : null,
          lastValid: lastValidSample({ ...item, valid: sourceConnected && item.valid === true && hasValue }, snapshotAgeS),
          reason: valid ? 'VALID' : !connected ? 'FLIGHT_CONTROLLER_DISCONNECTED' : !hasValue ? 'NO_VALID_SAMPLE' : item.valid === true ? 'STALE_OR_INVALID' : item.reason }];
      }));
      const metrics = normalizeMetrics(flight.metrics);
      const details = object(flight.details);
      const result = { ...snapshot, snapshotAgeS, normalizedAt, sourceIdentity, upstreamAvailable: sourceAvailable, ageIncludes: 'device-http-and-response-wait',
        transport: { ...object(snapshot.transport), available: sourceAvailable, lastDatagramAgeS: addAge(snapshot.transport?.lastDatagramAgeS) },
        flight: { ...flight, connected, stateAgeS, metrics,
          mode: connected ? flight.mode : 'DISCONNECTED', armed: connected ? flight.armed : null,
          landedStateAgeS: addAge(flight.landedStateAgeS),
          rollDeg: metrics.roll?.value ?? null, pitchDeg: metrics.pitch?.value ?? null,
          batteryVoltage: metrics.batteryVoltage?.value ?? null, batteryPercent: metrics.batteryPercent?.value ?? null,
          // RANGEFINDER has no sensor orientation; home/local altitude is not ground clearance.
          rangefinderM: null, relativeAltitudeM: metrics.relativeAltitude?.value ?? null,
          details: { ...details, ...(details.metrics ? { metrics: normalizeMetrics(details.metrics) } : {}), healthAgeS: addAge(details.healthAgeS),
            alerts: Array.isArray(details.alerts) ? details.alerts.map(item => ({ ...item, ageS: addAge(item.ageS) })) : [] }
        }
      };
      finishFlight(result.flight, sourceIdentity, sourceAvailable, normalizationTime);
      if (!sourceAvailable) invalidateMeasurements(result.flight);
      return result;
    },
    async telemetry(deviceId, requestedSource) {
      const snapshotStartedAt = now();
      const receivedAt = new Date().toISOString();
      if (deviceId === 'UGV-01') {
        if (!car) unavailable('车端网关');
        const raw = await requestJson(car, '/api/status', { retainOnFailure: true });
        const normalizationTime = now(), sourceAvailable = available(raw), sourceIdentity = identity(deviceId, car, raw);
        const result = normalizeUgvStatus(raw, elapsed(raw, normalizationTime));
        retainUgvSamples(result, lastValid, sourceIdentity, { capture: sourceAvailable, at: normalizationTime });
        Object.assign(result, { sourceIdentity, upstreamAvailable: sourceAvailable,
          normalizedAt: new Date().toISOString(), transport: { available: sourceAvailable, error: responseTiming.get(raw).error || null } });
        if (!sourceAvailable) {
          invalidateMeasurements(result);
          // Existing clients use receivedAt as the online/session gate.
          result.receivedAt = null;
          result.odom.speedMps = null; result.environment.temperatureC = null; result.environment.humidityPercent = null;
          result.environment.available = false; result.environment.analog.available = false;
          for (const key of ['ultrasonic', 'ultrasonicLeft', 'ultrasonicRight']) result[key].rangeM = null;
          result.batteryVoltage = null;
        }
        return result;
      }
      if (deviceId === 'UAV-01') {
        if (!vision && !flightStatus) unavailable('机载状态服务');
        if (requestedSource !== undefined && !['flight', 'vision'].includes(requestedSource)) throw Object.assign(new Error('无效的遥测来源'), { status: 400, code: 'INVALID_TELEMETRY_SOURCE' });
        const readVision = !!vision && (requestedSource !== 'flight' || !flightStatus);
        const readFlight = !!flightStatus && requestedSource !== 'vision';
        if (!readVision && !readFlight) unavailable(requestedSource === 'vision' ? '机载视觉服务' : '飞控状态服务');
        let raw = {}, directFlight = null, lastError;
        // Combined callers retain the old response shape. The dashboard requests each
        // source independently so a slow vision service never holds up flight samples.
        await Promise.all([
          readVision ? (async () => {
            try { raw = await requestJson(vision, '/api/status'); }
            catch (error) { lastError = error; }
          })() : null,
          readFlight ? (async () => {
            try { directFlight = await requestJson(flightStatus, '/api/status', { retainOnFailure: true }); }
            catch (error) { lastError = error; }
          })() : null
        ]);
        if (!directFlight && !Object.keys(raw).length) throw lastError || new IntegrationUnavailableError('UPSTREAM_INVALID', '机载状态响应未包含有效数据');
        const normalizedAt = now();
        const normalizedAtIso = new Date().toISOString();
        const snapshotAgeS = (normalizedAt - snapshotStartedAt) / 1000;
        const visionElapsedS = responseTiming.has(raw) ? elapsed(raw, normalizedAt) : 0;
        const flightElapsedS = directFlight ? elapsed(directFlight, normalizedAt) : visionElapsedS;
        const sourceAvailable = available(directFlight || raw);
        const sourceIdentity = identity('UAV-01:raspberry-pi', directFlight ? flightStatus : vision, directFlight || raw);
        const addAge = (value, elapsed) => finite(value) !== null && value >= 0 ? value + elapsed : null;
        const sourceFlight = object(directFlight || raw.flight);
        const flight = { ...sourceFlight,
          ...Object.fromEntries(['vehicle_state_age_s', 'extended_state_age_s', 'guided_executor_age_s', 'velocity_age_s'].map(key => [key, addAge(sourceFlight[key], flightElapsedS)])),
          telemetry_meta: Object.fromEntries(Object.entries(object(sourceFlight.telemetry_meta)).map(([key, value]) => [key, { ...object(value), age_s: addAge(object(value).age_s, flightElapsedS) }]))
        };
        const telemetry = object(flight.telemetry);
        const readFlightMetric = (key, unit, source, maxAgeS, options) => ({
          ...flightMetric(flight, key, unit, source, maxAgeS, options),
          lastValid: lastValidSample(flightMetric(sourceFlight, key, unit, source, maxAgeS, options), flightElapsedS)
        });
        const metrics = {
          roll: readFlightMetric('roll_deg', 'deg', '/mavros/local_position/pose.orientation', 0.5, { min: -180, max: 180 }),
          pitch: readFlightMetric('pitch_deg', 'deg', '/mavros/local_position/pose.orientation', 0.5, { min: -90, max: 90 }),
          batteryVoltage: readFlightMetric('battery_voltage_v', 'V', '/mavros/battery', 3, { min: Number.MIN_VALUE }),
          batteryPercent: readFlightMetric('battery_remaining_pct', '%', '/mavros/battery', 3, { min: 0, max: 100 }),
          rangefinder: readFlightMetric('rangefinder_m', 'm', '/landing/sensor_range', 1, { min: 0, legacy: true }),
          relativeAltitude: readFlightMetric('relative_altitude_m', 'm', '/mavros/global_position/rel_alt', 3),
          localAltitude: readFlightMetric('estimated_altitude_m', 'm', '/mavros/local_position/pose', 1, { legacy: true })
        };
        // 新鲜的飞控估计不等于经过校准的离地高度；保留原值供诊断，不人为归零。
        Object.assign(metrics.relativeAltitude, { kind: 'estimate', reference: 'home', referenceVerified: false });
        Object.assign(metrics.localAltitude, { kind: 'estimate', reference: 'local_enu', referenceVerified: false });
        const landedAgeS = finite(flight.extended_state_age_s);
        const stateAgeS = finite(flight.vehicle_state_age_s);
        const stateFresh = flight.flight_controller_connected === true && stateAgeS !== null && stateAgeS >= 0 && stateAgeS <= 2;
        const sourceStateAgeS = finite(sourceFlight.vehicle_state_age_s);
        const sourceStateFresh = sourceFlight.flight_controller_connected === true && sourceStateAgeS !== null && sourceStateAgeS >= 0 && sourceStateAgeS <= 2;
        // 这些旧桥字段已按各自样本年龄过滤；不把心跳年龄冒充传感器样本年龄。
        const bridgeMetric = (key, unit, source, bounds = {}) => {
          const item = readFlightMetric(key, unit, source, 1, { legacy: true, ...bounds });
          const valid = item.valid && stateAgeS !== null && stateAgeS >= 0 && stateAgeS <= 1;
          return { ...item, valid, value: valid ? item.value : null,
            lastValid: sourceStateAgeS !== null && sourceStateAgeS <= 1 ? item.lastValid : null,
            reason: item.valid && !valid ? 'STALE_OR_UNKNOWN_AGE' : item.reason };
        };
        const bodyVelocity = object(flight.body_velocity_mps);
        const bodyFrame = typeof flight.body_velocity_frame === 'string' ? flight.body_velocity_frame : '';
        const detailedMetrics = {
          heading: readFlightMetric('heading_deg', 'deg', '/mavros/global_position/compass_hdg', 0.5, { min: 0, max: 359.999999 }),
          ...Object.fromEntries(['gyro', 'accel'].flatMap(group => ['x', 'y', 'z'].map(axis => [
            `${group}${axis.toUpperCase()}`, readFlightMetric(`${group}_${axis}`, group === 'gyro' ? 'rad/s' : 'm/s²', '/mavros/imu/data (FLU)', 0.5)
          ]))),
          verticalSpeed: bridgeMetric('vertical_speed_mps', 'm/s', '/mavros/local_position/velocity_local · ENU Z'),
          throttle: bridgeMetric('motor_throttle_pct', '%', '/mavros/vfr_hud.throttle', { min: 0, max: 100 }),
          rc3: bridgeMetric('rc3_pwm', 'µs', '/mavros/rc/in.channels[2]', { min: 500, max: 2500 }),
          altitudeMsl: bridgeMetric('vfr_altitude_msl_m', 'm', '/mavros/vfr_hud.altitude'),
          ...Object.fromEntries(['x', 'y', 'z'].map(axis => {
            const source = `/mavros/local_position/velocity_body · ${bodyFrame || 'unknown'} ${axis.toUpperCase()}`;
            return [`velocity${axis.toUpperCase()}`, {
              ...ugvMetric(bodyVelocity[axis], flight.velocity_age_s, 'm/s', source, 1,
                { available: stateFresh && ['base_link', 'BODY_FLU'].includes(bodyFrame) }),
              lastValid: lastValidSample(ugvMetric(bodyVelocity[axis], sourceFlight.velocity_age_s, 'm/s', source, 1,
                { available: sourceStateFresh && ['base_link', 'BODY_FLU'].includes(bodyFrame) }), flightElapsedS)
            }];
          }))
        };
        const landedFresh = flight.flight_controller_connected === true && stateAgeS !== null && stateAgeS >= 0 && stateAgeS <= 2
          && landedAgeS !== null && landedAgeS >= 0 && landedAgeS <= 2;
        const extendedDetails = normalizeFlightDetails(sourceFlight, flightElapsedS, stateFresh, { sourceConnected: sourceStateFresh });
        // Older scalar aliases lack their own age. The matching extension may
        // supply it only when the independently validated value agrees exactly.
        for (const [key, extraKey, legacyKey] of [['verticalSpeed', 'localVelocityZ', 'vertical_speed_mps'],
          ['throttle', 'vfrThrottle', 'motor_throttle_pct'], ['rc3', 'rcInput3', 'rc3_pwm'], ['altitudeMsl', 'vfrAltitude', 'vfr_altitude_msl_m']]) {
          const item = detailedMetrics[key], candidate = extendedDetails.metrics[extraKey]?.lastValid;
          if (!item.lastValid && sourceStateFresh && sourceStateAgeS <= 1 && candidate
              && candidate.value === finite(object(sourceFlight.telemetry)[legacyKey]) && candidate.unit === item.unit
              && (key !== 'rc3' || candidate.value >= 500 && candidate.value <= 2500)
              && candidate.ageS - flightElapsedS <= 1) item.lastValid = { ...candidate, source: item.source, maxAgeS: 1 };
        }
        const extraMetrics = Object.fromEntries(Object.entries(extendedDetails.metrics).filter(([key]) => !Object.hasOwn(metrics, key)));
        const result = {
          deviceId, source: 'uav-rpi-deploy', receivedAt: sourceAvailable ? receivedAt : null,
          snapshotAgeS: sourceAvailable ? snapshotAgeS : Math.max(snapshotAgeS, flightElapsedS), normalizedAt: normalizedAtIso,
          sourceIdentity, upstreamAvailable: sourceAvailable, transport: { available: sourceAvailable, error: responseTiming.get(directFlight || raw)?.error || null },
          ageIncludes: 'device-http-and-response-wait',
          ...(requestedSource !== 'vision' ? { flight: {
            source: directFlight ? 'flight-status-http' : 'vision-embedded',
            connected: flight.flight_controller_connected === true,
            armed: flight.armed === true, mode: flight.mode || 'UNKNOWN',
            landedState: landedFresh && ['ON_GROUND', 'IN_AIR', 'TAKEOFF', 'LANDING'].includes(flight.landed_state) ? flight.landed_state : 'UNKNOWN',
            landedStateAgeS: landedAgeS,
            stateAgeS: finite(flight.vehicle_state_age_s),
            executorAgeS: finite(flight.guided_executor_age_s),
            action: flight.action ?? null, actionState: flight.action_state ?? null,
            controlOwner: flight.control_owner ?? null,
            estimatedAltitudeM: metrics.localAltitude.value,
            relativeAltitudeM: metrics.relativeAltitude.value,
            // 缺少传感器安装基准/姿态与地面标定，不能用 home 估计或斜距冒充机体离地高度。
            heightAboveGroundM: null,
            heightAboveGroundStatus: 'NOT_CALIBRATED',
            batteryVoltage: metrics.batteryVoltage.value,
            batteryPercent: metrics.batteryPercent.value,
            rangefinderM: metrics.rangefinder.value,
            rollDeg: metrics.roll.value,
            pitchDeg: metrics.pitch.value,
            metrics,
            details: {
              ...extendedDetails,
              // Extension topics must not replace the established source/frame gates.
              metrics: { ...extraMetrics, ...detailedMetrics }, bodyVelocityFrame: bodyFrame,
              systemStatus: stateFresh ? finite(flight.system_status) : null,
              actionDetail: stateFresh && finite(flight.guided_executor_age_s) !== null && flight.guided_executor_age_s >= 0 && flight.guided_executor_age_s <= 2 ? flight.action_detail ?? null : null,
              executorAgeS: finite(flight.guided_executor_age_s)
            },
            verticalSpeedMps: finite(telemetry.vertical_speed_mps)
          } } : {}),
          ...(requestedSource !== 'flight' ? { vision: {
            sensor: raw.sensor || 'UNKNOWN', mode: raw.mode || 'UNKNOWN',
            frameAgeMs: finite(raw.frame_age_ms) !== null && raw.frame_age_ms >= 0 ? raw.frame_age_ms + visionElapsedS * 1000 : null, found: raw.found === true,
            tagId: raw.tag_id ?? null, distanceM: finite(raw.distance_m),
            xM: finite(raw.x_m), yM: finite(raw.y_m), zM: finite(raw.z_m),
            captureFps: finite(raw.capture_fps), encodedFps: finite(raw.encoded_fps),
            relativePose: relativePose(raw, visionElapsedS)
          } } : {})
        };
        if (result.flight) {
          finishFlight(result.flight, sourceIdentity, sourceAvailable, normalizedAt);
          if (!sourceAvailable) invalidateMeasurements(result.flight);
        }
        return result;
      }
      return unconfiguredIntegrations.telemetry(deviceId);
    },
    async vehicleDetails() {
      if (!car) unavailable('车端网关');
      const groupStartedAt = performance.now();
      const routes = { navigation: '/api/nav/status', autoCruise: '/api/auto_cruise/status', maps: '/api/maps', mechanism: '/api/leadscrew/manual/status' };
      // 独立详情查询不会拖慢 /api/status 的一秒遥测轮询；旧网关缺少某项只影响该项。
      const sections = await Promise.all(Object.entries(routes).map(async ([name, path]) => {
        const startedAt = performance.now();
        try {
          const raw = await requestJson(car, path);
          return [name, { available: true, receivedAt: new Date().toISOString(), ageS: (performance.now() - startedAt) / 1000,
            maxAgeS: 6, data: normalizeUgvDetail(name, raw), raw }];
        } catch (error) {
          return [name, { available: false, data: null, error: error.code || 'UPSTREAM_UNAVAILABLE' }];
        }
      }));
      // 同批其他资源等待期间也会使先返回的查询快照变老。
      const totalAgeS = (performance.now() - groupStartedAt) / 1000;
      return { deviceId: 'UGV-01', source: 'car-rpi-deploy', receivedAt: new Date().toISOString(),
        sections: Object.fromEntries(sections.map(([name, value]) => [name, value.available ? { ...value, ageS: totalAgeS } : value])) };
    },
    async stream(deviceId) {
      const streams = deviceId === 'UGV-01' && car ? [
        { id: 'front', type: 'multipart/x-mixed-replace', url: '/api/v1/devices/UGV-01/cameras/front.mjpg' }
      ] : deviceId === 'UAV-01' ? [
        ...((video || car) ? [{ id: 'a8', type: 'multipart/x-mixed-replace', url: '/api/v1/devices/UAV-01/cameras/a8.mjpg' }] : []),
        ...(vision ? [{ id: 'ov9281', type: 'multipart/x-mixed-replace', url: '/api/v1/devices/UAV-01/cameras/ov9281.mjpg' }] : [])
      ] : [];
      if (!streams.length) unavailable('视频');
      let timingCalibration = null;
      if (deviceId === 'UAV-01' && (video || car)) {
        const before = Date.now(), started = performance.now();
        try {
          const status = await requestJson(video || car, video ? '/api/status' : '/api/uav/status');
          const elapsed = performance.now() - started;
          if (status.frame_time_basis === 'pi_jpeg_decode_complete' && typeof status.session_id === 'string'
              && Number.isFinite(status.server_time_ms) && elapsed <= 2000) {
            timingCalibration = { sessionId: status.session_id, offsetMs: before + elapsed / 2 - status.server_time_ms,
              uncertaintyMs: elapsed / 2, measuredAtMs: Date.now() };
          }
        } catch { /* Missing clock calibration must not interrupt a live video stream. */ }
      }
      return { deviceId, source: 'upstream', streams, readiness: 'unchecked', timingCalibration };
    },
    async media(deviceId, cameraId, options = {}) {
      const routes = {
        'UGV-01/front.mjpg': [car, '/api/camera/stream', 'multipart/x-mixed-replace'],
        'UGV-01/front.jpg': [car, '/api/camera.jpg', 'image/jpeg'],
        'UGV-01/rear.jpg': [car, '/api/camera_rear.jpg', 'image/jpeg'],
        'UGV-01/top.jpg': [car, '/api/camera_top.jpg', 'image/jpeg'],
        'UAV-01/a8.mjpg': [video || car, video ? '/stream' : '/api/uav/stream', 'multipart/x-mixed-replace'],
        'UAV-01/ov9281.mjpg': [vision, '/stream.mjpg', 'multipart/x-mixed-replace']
      };
      const route = routes[`${deviceId}/${cameraId}`];
      if (!route) throw Object.assign(new Error('相机不存在'), { status: 404, code: 'CAMERA_NOT_FOUND' });
      const [base, path, expected] = route;
      if (!base) unavailable('视频');
      const response = await request(base, path, 8000, { ...options, streaming: expected === 'multipart/x-mixed-replace' });
      if (!response.headers.get('content-type')?.toLowerCase().startsWith(expected)) {
        await response.body?.cancel();
        throw new IntegrationUnavailableError('UPSTREAM_INVALID', '上游视频格式错误');
      }
      return response;
    },
    async scan() {
      if (!car) unavailable('车端网关');
      return { source: 'car-rpi-deploy', receivedAt: new Date().toISOString(), ...await requestJson(car, '/api/scan.json') };
    },
    async mapImage(name) {
      if (!car) unavailable('车端网关');
      if (name !== undefined && (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(name))) {
        throw Object.assign(new Error('地图名称无效'), { status: 400, code: 'INVALID_MAP_NAME' });
      }
      const response = await request(car, name === undefined ? '/api/map.png' : `/api/maps/${name}.png`);
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('image/png')) {
        await response.body?.cancel();
        throw new IntegrationUnavailableError('UPSTREAM_INVALID', '上游地图格式错误');
      }
      return response;
    },
    command: unconfiguredIntegrations.command,
    measurements: unconfiguredIntegrations.measurements
  };
}
