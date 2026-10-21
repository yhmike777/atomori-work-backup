import { IntegrationUnavailableError, unconfiguredIntegrations } from './integrations.js';
import { normalizeUgvStatus, normalizeUgvDetail } from './ugv.js';

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

export function createUpstreamIntegrations({ carUrl, uavVisionUrl, uavFlightUrl, missionPlannerUrl, liveOnly = false, fetchImpl = fetch }) {
  const car = origin(carUrl, 'ATOMORI_CAR_URL');
  const vision = origin(uavVisionUrl, 'ATOMORI_UAV_VISION_URL');
  const flightStatus = origin(uavFlightUrl, 'ATOMORI_UAV_FLIGHT_URL');
  const missionPlanner = origin(missionPlannerUrl, 'ATOMORI_MISSION_PLANNER_URL');

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

  async function requestJson(base, path) {
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
    return value;
  }

  return {
    status() { return { carConfigured: !!car, uavVisionConfigured: !!vision, uavFlightConfigured: !!flightStatus, missionPlannerConfigured: !!missionPlanner, liveOnly: liveOnly === true, mode: car || vision || flightStatus || missionPlanner ? 'upstream-readonly' : 'demo', commandsEnabled: false }; },
    async missionPlanner() {
      if (!missionPlanner) unavailable('Mission Planner MAVLink 接收服务');
      const snapshot = await requestJson(missionPlanner, '/api/status');
      if (snapshot.source !== 'mission-planner-mavlink' || snapshot.deviceId !== 'UAV-01' || typeof snapshot.flight?.connected !== 'boolean') {
        throw new IntegrationUnavailableError('UPSTREAM_INVALID', 'Mission Planner 遥测响应无效');
      }
      return snapshot;
    },
    async telemetry(deviceId) {
      const receivedAt = new Date().toISOString();
      if (deviceId === 'UGV-01') {
        if (!car) unavailable('车端网关');
        const startedAt = performance.now();
        const raw = await requestJson(car, '/api/status');
        return normalizeUgvStatus(raw, (performance.now() - startedAt) / 1000);
      }
      if (deviceId === 'UAV-01') {
        if (!vision && !flightStatus) unavailable('机载状态服务');
        let raw = {}, lastError, visionReceivedAt = performance.now();
        if (vision) {
          try { raw = await requestJson(vision, '/api/status'); visionReceivedAt = performance.now(); }
          catch (error) { lastError = error; }
        }
        let directFlight = null;
        if (flightStatus) {
          try { directFlight = await requestJson(flightStatus, '/api/status'); }
          catch (error) { lastError = error; /* 使用视觉服务的内嵌快照，绝不编造数值。 */ }
        }
        if (!directFlight && !Object.keys(raw).length) throw lastError || new IntegrationUnavailableError('UPSTREAM_INVALID', '机载状态响应未包含有效数据');
        const flight = object(directFlight || raw.flight);
        const telemetry = object(flight.telemetry);
        const metrics = {
          roll: flightMetric(flight, 'roll_deg', 'deg', '/mavros/local_position/pose.orientation', 0.5, { min: -180, max: 180 }),
          pitch: flightMetric(flight, 'pitch_deg', 'deg', '/mavros/local_position/pose.orientation', 0.5, { min: -90, max: 90 }),
          batteryVoltage: flightMetric(flight, 'battery_voltage_v', 'V', '/mavros/battery', 3, { min: Number.MIN_VALUE }),
          batteryPercent: flightMetric(flight, 'battery_remaining_pct', '%', '/mavros/battery', 3, { min: 0, max: 100 }),
          rangefinder: flightMetric(flight, 'rangefinder_m', 'm', '/landing/sensor_range', 1, { min: 0, legacy: true }),
          relativeAltitude: flightMetric(flight, 'relative_altitude_m', 'm', '/mavros/global_position/rel_alt', 3),
          localAltitude: flightMetric(flight, 'estimated_altitude_m', 'm', '/mavros/local_position/pose', 1, { legacy: true })
        };
        // 新鲜的飞控估计不等于经过校准的离地高度；保留原值供诊断，不人为归零。
        Object.assign(metrics.relativeAltitude, { kind: 'estimate', reference: 'home', referenceVerified: false });
        Object.assign(metrics.localAltitude, { kind: 'estimate', reference: 'local_enu', referenceVerified: false });
        const landedAgeS = finite(flight.extended_state_age_s);
        const stateAgeS = finite(flight.vehicle_state_age_s);
        const stateFresh = flight.flight_controller_connected === true && stateAgeS !== null && stateAgeS >= 0 && stateAgeS <= 2;
        // 这些旧桥字段已按各自样本年龄过滤；不把心跳年龄冒充传感器样本年龄。
        const bridgeMetric = (key, unit, source, bounds = {}) => {
          const item = flightMetric(flight, key, unit, source, 1, { legacy: true, ...bounds });
          const valid = item.valid && stateAgeS !== null && stateAgeS >= 0 && stateAgeS <= 1;
          return { ...item, valid, value: valid ? item.value : null, reason: item.valid && !valid ? 'STALE_OR_UNKNOWN_AGE' : item.reason };
        };
        const bodyVelocity = object(flight.body_velocity_mps);
        const bodyFrame = typeof flight.body_velocity_frame === 'string' ? flight.body_velocity_frame : '';
        const detailedMetrics = {
          verticalSpeed: bridgeMetric('vertical_speed_mps', 'm/s', '/mavros/local_position/velocity_local · ENU Z'),
          throttle: bridgeMetric('motor_throttle_pct', '%', '/mavros/vfr_hud.throttle', { min: 0, max: 100 }),
          rc3: bridgeMetric('rc3_pwm', 'µs', '/mavros/rc/in.channels[2]', { min: 500, max: 2500 }),
          altitudeMsl: bridgeMetric('vfr_altitude_msl_m', 'm', '/mavros/vfr_hud.altitude'),
          ...Object.fromEntries(['x', 'y', 'z'].map(axis => [`velocity${axis.toUpperCase()}`,
            ugvMetric(bodyVelocity[axis], flight.velocity_age_s, 'm/s', `/mavros/local_position/velocity_body · ${bodyFrame || 'unknown'} ${axis.toUpperCase()}`, 1,
              { available: stateFresh && ['base_link', 'BODY_FLU'].includes(bodyFrame) })]))
        };
        const landedFresh = flight.flight_controller_connected === true && stateAgeS !== null && stateAgeS >= 0 && stateAgeS <= 2
          && landedAgeS !== null && landedAgeS >= 0 && landedAgeS <= 2;
        return {
          deviceId, source: 'uav-rpi-deploy', receivedAt,
          flight: {
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
              metrics: detailedMetrics, bodyVelocityFrame: bodyFrame,
              systemStatus: stateFresh ? finite(flight.system_status) : null,
              actionDetail: stateFresh && finite(flight.guided_executor_age_s) !== null && flight.guided_executor_age_s >= 0 && flight.guided_executor_age_s <= 2 ? flight.action_detail ?? null : null,
              executorAgeS: finite(flight.guided_executor_age_s)
            },
            verticalSpeedMps: finite(telemetry.vertical_speed_mps)
          },
          vision: {
            sensor: raw.sensor || 'UNKNOWN', mode: raw.mode || 'UNKNOWN',
            frameAgeMs: finite(raw.frame_age_ms), found: raw.found === true,
            tagId: raw.tag_id ?? null, distanceM: finite(raw.distance_m),
            xM: finite(raw.x_m), yM: finite(raw.y_m), zM: finite(raw.z_m),
            captureFps: finite(raw.capture_fps), encodedFps: finite(raw.encoded_fps),
            relativePose: relativePose(raw, (performance.now() - visionReceivedAt) / 1000)
          }
        };
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
        { id: 'front', type: 'image/jpeg', url: '/api/v1/devices/UGV-01/cameras/front.jpg' },
        { id: 'rear', type: 'image/jpeg', url: '/api/v1/devices/UGV-01/cameras/rear.jpg' },
        { id: 'top', type: 'image/jpeg', url: '/api/v1/devices/UGV-01/cameras/top.jpg' }
      ] : deviceId === 'UAV-01' ? [
        ...(car ? [{ id: 'a8', type: 'multipart/x-mixed-replace', url: '/api/v1/devices/UAV-01/cameras/a8.mjpg' }] : []),
        ...(vision ? [{ id: 'ov9281', type: 'multipart/x-mixed-replace', url: '/api/v1/devices/UAV-01/cameras/ov9281.mjpg' }] : [])
      ] : [];
      if (!streams.length) unavailable('视频');
      return { deviceId, source: 'upstream', streams, readiness: 'unchecked' };
    },
    async media(deviceId, cameraId, options = {}) {
      const routes = {
        'UGV-01/front.jpg': [car, '/api/camera.jpg', 'image/jpeg'],
        'UGV-01/rear.jpg': [car, '/api/camera_rear.jpg', 'image/jpeg'],
        'UGV-01/top.jpg': [car, '/api/camera_top.jpg', 'image/jpeg'],
        'UAV-01/a8.mjpg': [car, '/api/uav/stream', 'multipart/x-mixed-replace'],
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
