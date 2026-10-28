'use strict';

// 沿用控制台弹窗。快照状态、传感器年龄、推杆估算与物理反馈分别显示。
window.AtomoriUgvView = (() => {
  const safe = value => String(value ?? '—').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const numeric = (value, unit = '', digits = 2) => Number.isFinite(value) ? `${value.toFixed(digits)}${unit ? ' ' + unit : ''}` : '—';
  const gasConcentration = (ppm, key) => Number.isFinite(ppm) && ppm >= 0
    ? `${numeric(ppm, 'ppm', key === 'smoke' ? 0 : 1)} · ${(ppm / 10000).toFixed(key === 'smoke' ? 3 : 5)}%` : '—';
  const flag = (value, yes = '是', no = '否') => value === true ? yes : value === false ? no : '—';
  const fresh = (age, elapsed, limit = 2) => Number.isFinite(age) && age >= 0 && age + elapsed <= limit;
  const snapshotFresh = (data, elapsed) => Boolean(data.receivedAt) && fresh(data.snapshotAgeS ?? 0, elapsed, data.snapshotMaxAgeS ?? 3);
  const vector = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
  const pose = value => vector(value, 3) ? `X ${numeric(value[0], 'm')} · Y ${numeric(value[1], 'm')} · 航向 ${numeric(value[2] * 180 / Math.PI, '°', 1)}` : '—';
  const point = value => vector(value, 2) ? `X ${numeric(value[0], 'm')} · Y ${numeric(value[1], 'm')}` : '—';
  const metric = (data, key, elapsed) => {
    const item = data.metrics?.[key];
    return item?.valid === true && fresh(item.ageS, elapsed, item.maxAgeS) ? item.value : null;
  };
  // Only display readers use this history. Freshness and control readers below
  // continue to inspect the live payload, including after a gateway restart.
  const usable = value => value !== null && value !== undefined && (typeof value !== 'number' || Number.isFinite(value));
  const sampleAge = (age, elapsed) => Number.isFinite(age) && age >= 0 ? age + Math.max(0, elapsed || 0) : null;
  function createDisplayHistory() {
    const samples = new Map();
    let sourceIdentity = null;
    const read = (key, value, valid, ageS, nowMs = Date.now(), lastValid = null) => {
      const remember = (next, age) => {
        if (!usable(next) || !Number.isFinite(age) || age < 0) return;
        const sampledAt = nowMs - age * 1000, previous = samples.get(key);
        if (!previous || sampledAt >= previous.sampledAt - 1) samples.set(key, { value: next, sampledAt });
      };
      if (valid && usable(value)) {
        remember(value, ageS);
        return { value, ageS, retained: false };
      }
      if (lastValid) remember(lastValid.value, lastValid.ageS);
      const previous = samples.get(key);
      return previous ? { value: previous.value, ageS: Math.max(0, (nowMs - previous.sampledAt) / 1000), retained: true }
        : { value: null, ageS: null, retained: false };
    };
    read.setSource = identity => {
      if (typeof identity !== 'string' || !identity) return;
      if (sourceIdentity && sourceIdentity !== identity) samples.clear();
      sourceIdentity = identity;
    };
    return read;
  }
  const historyHint = item => item.retained ? `最近有效数据 · ${numeric(item.ageS, 's', 1)} 前；当前未获得有效新样本` : '';
  function createMetricDisplay() {
    const read = createDisplayHistory();
    return (data, key, elapsed, nowMs = Date.now()) => {
      read.setSource(data.sourceIdentity);
      const item = data.metrics?.[key], value = metric(data, key, elapsed);
      const previous = item?.lastValid;
      return read(key, value, snapshotFresh(data, elapsed) && Number.isFinite(value), sampleAge(item?.ageS, elapsed), nowMs,
        Number.isFinite(previous?.value) ? { ...previous, ageS: sampleAge(previous.ageS, elapsed) } : null);
    };
  }
  const currentSoundState = (data, elapsed) => {
    const sensor = data.environment?.sensors?.sound?.digital;
    const available = snapshotFresh(data, elapsed) && sensor?.available === true && fresh(sensor.ageS, elapsed);
    const abnormal = available && sensor.valid === true && sensor.triggered === true;
    const defaulted = available && sensor.valid !== true;
    return { text: available ? abnormal ? '检测到声音' : defaulted ? '待判定' : '正常' : '—',
      color: available ? abnormal ? 'var(--red)' : defaulted ? 'var(--amber)' : 'var(--green)' : 'var(--muted)',
      title: !available ? '声音传感器未连接或数据过期'
        : defaulted ? '声音传感器在线，但尚未配置触发判定；没有有效报警结论，未上报分贝值'
        : `声音传感器${abnormal ? '已触发' : '未触发'}；数字触发状态，不代表分贝测量`,
      valid: available && sensor.valid === true && typeof sensor.triggered === 'boolean', triggered: abnormal ? true : available && sensor.valid === true ? false : null };
  };
  const gasSwitchState = (data, key, label, elapsed) => {
    const sensor = data.environment?.sensors?.[key]?.digital;
    const available = snapshotFresh(data, elapsed) && sensor?.available === true && fresh(sensor.ageS, elapsed, sensor.maxAgeS);
    const valid = available && sensor.valid === true && typeof sensor.triggered === 'boolean';
    return { text: !available ? '—' : !valid ? '待判定' : sensor.triggered ? '已触发' : '未触发',
      color: !available ? 'var(--muted)' : !valid ? 'var(--amber)' : sensor.triggered ? 'var(--red)' : 'var(--green)',
      title: !available ? `${label}传感器未连接或数据过期` : !valid ? `${label}触发判定未配置`
        : `${label}数字开关${sensor.triggered ? '已触发' : '未触发'}；开关状态不代表气体浓度`,
      valid, triggered: valid ? sensor.triggered : null };
  };
  const analogReading = (data, key, elapsed) => {
    const analog = data.environment?.sensors?.[key]?.analog;
    return snapshotFresh(data, elapsed) && analog?.valid === true && fresh(analog.ageS, elapsed, analog.maxAgeS) ? analog : null;
  };
  const currentSmokeState = (data, elapsed) => {
    const state = gasSwitchState(data, 'smoke', '烟雾 MQ-2', elapsed);
    const analog = analogReading(data, 'smoke', elapsed);
    if (analog) state.title += `；ADC ${numeric(analog.voltageV, 'V', 3)}`;
    if (analog?.referenceEstimate?.valid) {
      state.text = gasConcentration(analog.referenceEstimate.ppm, 'smoke');
      state.title += `；模型参考约 ${state.text}（未标定，默认基准；不作为实测浓度）`;
    }
    return state;
  };
  const currentCoState = (data, elapsed) => {
    const state = gasSwitchState(data, 'carbonMonoxide', '一氧化碳 MQ-7', elapsed);
    const analog = analogReading(data, 'carbonMonoxide', elapsed), reference = analog?.referenceEstimate;
    if (!analog) return state;
    const limitation = '车端模型参考值；R0 暂设 10 kΩ，未标定，加热条件未验证，不作为实测浓度';
    if (reference?.valid) return { ...state, text: gasConcentration(reference.ppm, 'carbonMonoxide'),
      title: `${limitation}；ADC ${numeric(analog.voltageV, 'V', 3)}；${state.title}` };
    const status = { below_model_range: '低于参考量程', above_model_range: '高于参考量程', adc_saturated: 'ADC 满量程', below_adc_resolution: '低于 ADC 分辨率' }[reference?.status];
    return { ...state, text: status || state.text, title: `${limitation}；ADC ${numeric(analog.voltageV, 'V', 3)}；${state.title}` };
  };
  function createSensorDisplay() {
    const read = createDisplayHistory();
    const state = (data, key, elapsed = 0, nowMs = Date.now()) => {
      read.setSource(data.sourceIdentity);
      const sensor = data.environment?.sensors?.[key], digital = sensor?.digital, analog = analogReading(data, key, elapsed);
      const current = key === 'sound' ? currentSoundState(data, elapsed) : key === 'smoke' ? currentSmokeState(data, elapsed)
        : key === 'carbonMonoxide' ? currentCoState(data, elapsed) : gasSwitchState(data, key, '火焰', elapsed);
      const digitalLive = current.valid === true;
      const digitalSample = read(`${key}.digital`, digital?.triggered, digitalLive, sampleAge(digital?.ageS, elapsed), nowMs,
        typeof digital?.lastValid?.value === 'boolean' ? { ...digital.lastValid, ageS: sampleAge(digital.lastValid.ageS, elapsed) } : null);
      const reference = sensor?.analog?.referenceEstimate;
      const referenceSample = read(`${key}.reference`, analog?.referenceEstimate?.ppm,
        analog?.referenceEstimate?.valid === true && Number.isFinite(analog.referenceEstimate.ppm) && analog.referenceEstimate.ppm >= 0,
        sampleAge(analog?.ageS, elapsed), nowMs, Number.isFinite(reference?.lastValid?.value) && reference.lastValid.value >= 0
          ? { ...reference.lastValid, ageS: sampleAge(reference.lastValid.ageS, elapsed) } : null);
      const historical = key === 'smoke' || key === 'carbonMonoxide' ? referenceSample.value !== null ? referenceSample : digitalSample : digitalSample;
      if (historical.retained) {
        const text = historical === referenceSample ? gasConcentration(historical.value, key)
          : key === 'sound' ? historical.value ? '检测到声音' : '正常' : historical.value ? '已触发' : '未触发';
        const limitation = historical === referenceSample ? '；未标定模型参考值，不作为实测浓度' : '；数字开关状态，不代表浓度或分贝测量';
        return { ...current, text, retained: true, ageS: historical.ageS, color: 'var(--muted)', valid: false, triggered: null,
          title: `最近状态 · ${numeric(historical.ageS, 's', 1)} 前；${current.title}${limitation}` };
      }
      return { ...current, retained: false, ageS: historical.ageS };
    };
    return { soundState: (data, elapsed, nowMs) => state(data, 'sound', elapsed, nowMs),
      smokeState: (data, elapsed, nowMs) => state(data, 'smoke', elapsed, nowMs),
      coState: (data, elapsed, nowMs) => state(data, 'carbonMonoxide', elapsed, nowMs),
      flameState: (data, elapsed, nowMs) => state(data, 'flame', elapsed, nowMs) };
  }
  const { soundState, smokeState, coState, flameState } = createSensorDisplay();
  const cameraState = (data, cameraId, elapsed) => {
    const key = { front: 'camera', rear: 'cameraRear', top: 'cameraTop' }[cameraId];
    const camera = key ? data[key] : null;
    const ageS = Number.isFinite(camera?.age_s) && camera.age_s >= 0 ? camera.age_s + elapsed : null;
    const valid = snapshotFresh(data, elapsed) && camera?.ready === true && fresh(camera.age_s, elapsed, 3);
    const reason = !snapshotFresh(data, elapsed) ? '车辆状态未连接或过期'
      : camera?.ready !== true ? '相机未上报有效帧'
      : ageS === null ? '相机采样年龄未知' : ageS > 3 ? '相机帧已过期' : '实时相机';
    return { valid, ageS, maxAgeS: 3, reason };
  };
  const mapState = (data, elapsed) => {
    const ageS = Number.isFinite(data.map?.age_s) && data.map.age_s >= 0 ? data.map.age_s + elapsed : null;
    const valid = snapshotFresh(data, elapsed) && fresh(data.map?.age_s, elapsed, 6);
    return { valid, ageS, maxAgeS: 6, reason: !snapshotFresh(data, elapsed) ? '车辆状态未连接或过期'
      : ageS === null ? '当前地图采样年龄未知' : ageS > 6 ? '当前地图已过期' : '当前栅格地图' };
  };
  const section = (details, name, elapsed) => {
    const item = details?.sections?.[name];
    return item?.available === true && fresh(item.ageS, elapsed, item.maxAgeS) ? item.data : null;
  };
  const label = (value, labels) => labels[value] || value || '—';
  const authorityLabels = { navigation: '自主导航', operator: '操作端', operator_teleop: '操作端遥控', operator_nav2: '操作端导航', operator_steering: '巡航转向辅助', none: '无控制权' };
  const stateLabels = ['外侧保持', '向内运动', '内侧保持', '向外运动', '中途保持'];
  const locationLabels = { inactive: '未启动', starting: '启动中', waiting_for_amcl: '等待定位节点', globalizing: '全局定位中', localized: '已定位', error: '定位错误' };
  const displayValue = value => value && typeof value === 'object' && 'displayText' in value
    ? value.retained ? `<span style="color:var(--muted)" title="${safe(historyHint(value))}">${safe(value.displayText)}</span>` : safe(value.displayText) : safe(value);
  const rows = values => `<div class="business-list">${values.map(([key, value]) => `<div><span>${safe(key)}</span><b>${displayValue(value)}</b></div>`).join('')}</div>`;
  const table = (headers, values) => `<table><thead><tr>${headers.map(item => `<th>${safe(item)}</th>`).join('')}</tr></thead><tbody>${values.map(row => `<tr>${row.map(item => `<td>${displayValue(item)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const group = (id, title, content, open = false) => `<details class="ugv-detail-group" data-group="${id}"${open ? ' open' : ''}><summary>${title}</summary>${content}</details>`;

  function createDetailsDisplay() {
    const read = createDisplayHistory();
    const metrics = createMetricDisplay();
    const get = (object, path) => path ? path.split('.').reduce((value, key) => value?.[key], object) : object;
    return { setSource: read.setSource,
      metric: (data, key, elapsed, unit, digits = 2, nowMs) => {
        const item = metrics(data, key, elapsed, nowMs);
        return { ...item, displayText: numeric(item.value, unit, digits) };
      },
      source: (name, object, valid, age, elapsed, nowMs) => {
        const ageS = sampleAge(age, elapsed);
        const sample = (path, format = value => value, lastValid = null) => {
          const value = get(object, path), formatted = format(value);
          const previous = lastValid && usable(lastValid.value) && format(lastValid.value) !== '—'
            ? { ...lastValid, ageS: sampleAge(lastValid.ageS, elapsed) } : null;
          return read(`${name}.${path}`, value, valid && usable(value) && formatted !== '—', ageS, nowMs, previous);
        };
        return {
          cell: (path, format = value => value, lastValid = null) => {
            const item = sample(path, format, lastValid);
            return { ...item, displayText: item.value === null ? '—' : format(item.value) };
          },
          raw: path => sample(path).value,
          age: (lastValid = null) => {
            const item = read(`${name}.__age`, true, valid, ageS, nowMs, lastValid ? { value: true, ageS: sampleAge(lastValid.ageS, elapsed) } : null);
            return { ...item, displayText: numeric(item.ageS, 's', 1) };
          }
        };
      },
      age: (name, age, elapsed, nowMs) => {
        const ageS = sampleAge(age, elapsed), item = read(`age.${name}`, true, ageS !== null, ageS, nowMs);
        return { ...item, displayText: numeric(item.ageS, 's', 1) };
      }
    };
  }
  const joined = (...items) => ({ displayText: items.map(item => item?.displayText ?? item ?? '—').join(' / '),
    retained: items.some(item => item?.retained), ageS: Math.max(0, ...items.map(item => item?.ageS || 0)) });

  function mechanismState(data, details, elapsed, detailsElapsed) {
    const base = data.leadscrew;
    const valid = snapshotFresh(data, elapsed) && fresh(base?.age_s, elapsed) && base?.status;
    const manual = section(details, 'mechanism', detailsElapsed);
    const mode = manual?.available === true && manual.simulated === true ? '仿真 · ' : '';
    if (!valid) return { state: '机构未连接', subline: '推杆反馈过期/缺失 · 充电电气未接入' };
    const moving = Array.isArray(base.status.state) && base.status.state.some(value => value === 1 || value === 3);
    return { state: `${mode}${moving ? '机构运行中' : '机构保持'}`, subline: '推杆位置为脉冲估算 · 落位/充电电气未接入' };
  }

  function detailsHtml(data, details, elapsed, detailsElapsed, display, nowMs) {
    const live = snapshotFresh(data, elapsed);
    display.setSource(data.sourceIdentity);
    const snapshotAge = data.snapshotAgeS ?? 0;
    const source = (name, object, valid = live, age = snapshotAge, wait = elapsed) => display.source(name, object, valid, age, wait, nowMs);
    const snapshot = source('snapshot', data);
    const gateway = source('gateway', data.gateway);
    const environment = data.environment || {};
    const environmentState = source('environment', environment);
    const localization = source('localization-state', data.localization);
    const location = source('localization-pose', data.localization, live && fresh(data.localization?.age_s, elapsed), data.localization?.age_s);
    const odom = source('odom', data.odom, live && fresh(data.odom?.ageS, elapsed), data.odom?.ageS);
    const gpsLive = live && fresh(data.gps?.ageS, elapsed, 3);
    const gps = source('gps-state', data.gps?.fix, gpsLive, data.gps?.ageS);
    const gpsPosition = source('gps-position', data.gps?.fix, gpsLive && Number.isInteger(data.gps?.fix?.status) && data.gps.fix.status >= 0, data.gps?.ageS);
    const mux = source('mux', data.controlMux, live && fresh(data.topicAgesS?.ugv_control_mux, elapsed), data.topicAgesS?.ugv_control_mux);
    const command = source('command', data.commandGateway, live && fresh(data.topicAgesS?.ugv_command_gateway, elapsed), data.topicAgesS?.ugv_command_gateway);
    const mapping = source('mapping', data.mapping), avoidance = source('avoidance', data.avoidance);
    const map = source('map', data.map, live && fresh(data.map?.age_s, elapsed, 6), data.map?.age_s);
    const detailSource = name => {
      const item = details?.sections?.[name];
      return source(`detail.${name}`, item?.data, Boolean(section(details, name, detailsElapsed)), item?.ageS, detailsElapsed);
    };
    const navigation = detailSource('navigation'), cruise = detailSource('autoCruise'), maps = detailSource('maps'), manual = detailSource('mechanism');
    const manualData = section(details, 'mechanism', detailsElapsed);
    const mechanism = source('mechanism', manualData, manualData?.available === true, details?.sections?.mechanism?.ageS, detailsElapsed);
    const lead = source('leadscrew', data.leadscrew?.status, live && fresh(data.leadscrew?.age_s, elapsed), data.leadscrew?.age_s);
    const number = (unit = '', digits = 2) => value => numeric(value, unit, digits);
    const metricCell = (key, unit, digits) => display.metric(data, key, elapsed, unit, digits, nowMs);
    const age = (key, value, wait = elapsed) => display.age(key, value, wait, nowMs);
    const mapRows = (reader, prefix = '') => rows([
      ['地图尺寸', joined(reader.cell(`${prefix}width`, number('格', 0)), reader.cell(`${prefix}height`, number('格', 0)))],
      ['栅格分辨率', reader.cell(`${prefix}resolution`, number('m/格', 4))], ['地图原点', reader.cell(`${prefix}origin`, pose)]
    ]);
    const status = rows([
      ['车端连接', live ? 'HTTP 状态已接收' : '离线/快照过期'],
      ['快照时间', snapshot.cell('observedAt', value => value ? new Date(value).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—')],
      ['服务', gateway.cell('service')], ['协议版本', gateway.cell('schema_version')], ['网关健康', gateway.cell('ok', value => flag(value, '正常', '异常'))],
      ['网关运行时长', gateway.cell('uptime_s', number('s', 1))], ['相机解码后端', gateway.cell('camera_backend', value => flag(value, '可用', '不可用'))],
      ['行驶速度（模长）', metricCell('speed', 'm/s')], ['后向超声距离', metricCell('ultrasonic', 'm')],
      ['左侧 / 右侧超声距离', joined(metricCell('ultrasonicLeft', 'm'), metricCell('ultrasonicRight', 'm'))],
      ['环境温度 / 相对湿度', joined(metricCell('temperature', '°C', 1), metricCell('humidity', '%RH', 1))],
      ['电池电量 / 电压', '当前 HTTP 网关未提供有效测量值'], ['温湿度连续错误次数', environmentState.cell('consecutiveErrors')],
      ['温湿度采样错误', environmentState.cell('error')]
    ]);
    const sound = soundState(data, elapsed, nowMs), smoke = smokeState(data, elapsed, nowMs), co = coState(data, elapsed, nowMs);
    const summaryCell = state => ({ ...state, displayText: state.text });
    const sensors = rows([['烟雾 MQ-2', summaryCell(smoke)], ['一氧化碳 MQ-7', summaryCell(co)], ['声音状态', summaryCell(sound)]]) +
      `<p class="dialog-muted">${safe(smoke.title)}<br>${safe(co.title)}<br>${safe(sound.title)}</p>` +
      table(['传感器', '数字触发', 'GPIO', '去抖电平 / 原始电平', '触发电平', '变化次数', '样本年龄'], ['smoke', 'carbonMonoxide', 'flame', 'sound'].map(key => {
        const sensor = environment.sensors?.[key]?.digital;
        const current = live && sensor?.valid === true && fresh(sensor.ageS, elapsed, sensor.maxAgeS);
        const reader = source(`digital.${key}`, sensor, current, sensor?.ageS);
        const config = source(`digital-config.${key}`, sensor);
        const switchValue = reader.cell('triggered', value => flag(value, '触发', '未触发'), typeof sensor?.lastValid?.value === 'boolean' ? sensor.lastValid : null);
        return [environment.sensors?.[key]?.label || { smoke: '烟雾 MQ-2', carbonMonoxide: '一氧化碳 MQ-7', flame: '火焰', sound: '声音' }[key], switchValue,
          config.cell('gpio'), joined(reader.cell('level'), reader.cell('rawLevel')), config.cell('activeLevel'), reader.cell('changes'), reader.age(sensor?.lastValid)];
      })) + table(['模拟通道', 'ADC 电压', 'ADC 计数', '模型参考值'], ['smoke', 'carbonMonoxide', 'flame'].map(key => {
        const analog = environment.sensors?.[key]?.analog;
        const valid = live && analog?.valid === true && fresh(analog.ageS, elapsed, analog.maxAgeS);
        const reader = source(`analog.${key}`, analog, valid, analog?.ageS);
        const reference = source(`reference.${key}`, analog?.referenceEstimate, valid && analog?.referenceEstimate?.valid === true, analog?.ageS);
        const relative = source(`relative.${key}`, analog?.relativeIntensity, valid && analog?.relativeIntensity?.valid === true, analog?.ageS);
        const voltage = reader.cell('voltageV', number('V', 3), analog?.voltageLastValid);
        const count = reader.cell('raw', value => Number.isFinite(value) ? value : '—', analog?.rawLastValid);
        const referenceCell = reference.cell('ppm', value => gasConcentration(value, key), analog?.referenceEstimate?.lastValid);
        const relativeCell = relative.cell('percent', value => Number.isFinite(value) ? `相对 ${numeric(value, '%', 1)}` : '—', analog?.relativeIntensity?.lastValid);
        return [environment.sensors?.[key]?.label || { smoke: '烟雾 MQ-2', carbonMonoxide: '一氧化碳 MQ-7', flame: '火焰' }[key], voltage, count,
          referenceCell.displayText !== '—' ? referenceCell : relativeCell];
      })) + '<p class="dialog-muted">气体 ppm 为车端未标定模型参考值，火焰百分比为电压归一化相对值，均不代表标定后的浓度或功率。报警只取各自数字触发信号，声音未接入分贝测量。</p>';
    const locationContent = rows([
      ['里程计位姿（odom）', odom.cell('pose', pose)], ['里程计年龄', odom.age()],
      ['地图定位状态（快照）', localization.cell('state', value => label(value, locationLabels))],
      ['定位后端 / 地图', joined(localization.cell('backend'), localization.cell('map_name'))],
      ['定位启动时长', localization.cell('since_s', number('s', 1))], ['地图位姿（map）', location.cell('map_pose', pose)],
      ['定位置信度', location.cell('confidence', value => label(value, { high: '高', medium: '中', low: '低', none: '无' }))],
      ['XY 不确定度 / 航向不确定度', joined(location.cell('xy_sigma_m', number('m', 3)), location.cell('yaw_sigma_rad', value => numeric(Number.isFinite(value) ? value * 180 / Math.PI : null, '°')))],
      ['地图位姿年龄', location.age()], ['定位错误', localization.cell('error')],
      ['GPS 定位状态', gps.cell('status', value => label(String(value), { '-1': '无定位', '0': '普通定位', '1': 'SBAS 定位', '2': 'GBAS 定位' }))],
      ['GPS 纬度 / 经度', joined(gpsPosition.cell('latitude', number('°', 7)), gpsPosition.cell('longitude', number('°', 7)))],
      ['GPS 高度', gpsPosition.cell('altitude', number('m', 1))], ['GPS 样本年龄', gpsPosition.age()]
    ]);
    const muxAges = mux.raw('ages_s') || {};
    const control = rows([
      ['控制权', mux.cell('authority', value => label(value, authorityLabels))], ['控制原因', mux.cell('reason')], ['控制混合器使能 / 通行门', joined(mux.cell('enabled', flag), mux.cell('gate_open', flag))],
      ['急停（混合器 / 指令网关）', joined(mux.cell('emergency_stop', flag), command.cell('emergency_stop', flag))],
      ['要求任务状态', mux.cell('require_mission_status', flag)], ['任务活动 / 暂停', joined(mux.cell('mission_active', flag), mux.cell('mission_paused', flag))],
      ['设备侧任务状态 / 速度比例', joined(mux.cell('mission_state'), mux.cell('mission_gate', number('', 3)))], ['操作端请求控制', mux.cell('operator_requested', flag)],
      ['混合器输出（指令值）', joined(mux.cell('output_linear_mps', number('m/s')), mux.cell('output_angular_rps', number('rad/s')))],
      ['指令网关使能 / 原因', joined(command.cell('enabled', flag), command.cell('reason'))],
      ['指令网关输出（指令值）', joined(command.cell('output_linear_mps', number('m/s')), command.cell('output_angular_rps', number('rad/s')))],
      ['输入指令年龄 / 超时阈值', joined(age('command.input', live ? data.commandGateway?.input_age_s : null), command.cell('command_timeout_s', number('s')))],
      ['避障巡航状态（查询快照）', avoidance.cell('cruise_enabled', value => flag(value, '启用', '停止'))]
    ]) + table(['混合器输入', '年龄'], Object.keys(muxAges).map(key => [label(key, { navigation: '导航', teleop: '遥控', mission_status: '任务状态', mission_gate: '任务门控', operator: '操作端心跳' }),
      age(`mux.${key}`, live ? data.controlMux?.ages_s?.[key] : null)]));
    const mapNames = maps.raw('names');
    const mapButtons = Array.isArray(mapNames) ? mapNames.map(name => `<button type="button" data-ugv-map="${safe(name)}">${safe(name)}</button>`).join('') : '<span class="dialog-muted">地图列表未提供或为空</span>';
    const mapContent = rows([
      ['SLAM 建图状态', mapping.cell('active', value => flag(value, '建图中', '未建图'))], ['建图运行时长', mapping.cell('since_s', number('s', 1))],
      ['建图初始位姿（TF 查询）', mapping.cell('initial_pose', pose)], ['建图当前位姿（TF 查询）', mapping.cell('current_pose', pose)],
      ['栅格地图样本年龄', map.age()], ['地图列表查询年龄', maps.age()]
    ]) + mapRows(map, 'info.') + '<p class="dialog-muted">TF 查询未提供变换年龄；地图可以是已保存数据。原管廊态势图保留。</p>' +
      `<div class="ugv-detail-toolbar"><button type="button" data-ugv-map="current">查看当前栅格地图</button>${mapButtons}</div>`;
    const navPath = navigation.raw('path');
    const navigationContent = rows([
      ['导航状态（查询快照）', navigation.cell('active', value => flag(value, '执行中', '未执行'))], ['已加载地图', navigation.cell('hasMap', flag)],
      ['导航目标', navigation.cell('goal', point)], ['路径点数量', navigation.cell('path', value => Array.isArray(value) ? value.length : '—')],
      ['自动巡航（查询快照）', cruise.cell('active', value => flag(value, '执行中', '未执行'))], ['巡航初始点', cruise.cell('initial', point)], ['巡航地图', cruise.cell('mapName')],
      ['导航查询年龄', navigation.age()], ['巡航查询年龄', cruise.age()]
    ]) + mapRows(cruise, 'mapInfo.') + (Array.isArray(navPath) && navPath.length ? `<details class="ugv-path" data-group="path"><summary>查看导航路径点</summary>${table(['序号', 'X（m）', 'Y（m）'], navPath.map((value, index) => [index + 1,
      navigation.cell(`path.${index}.0`, number()), navigation.cell(`path.${index}.1`, number())]))}</details>` : '') +
      '<p class="dialog-muted">导航坐标取决于设备后端：Nav2 为 map，自研避障为 odom。这里显示状态，未下发导航目标。</p>';
    const mechanisms = [0, 1].map(index => [`组 ${index + 1}`, lead.cell(`state.${index}`, value => Number.isInteger(value) ? stateLabels[value] || '未知状态' : '—'),
      lead.cell(`pos_mm.${index}`, number('mm', 3)), lead.cell(`enabled.${index}`, value => flag(value, '使能', '禁用'))]);
    const geometry = mechanism.raw('simulation_geometry'), pins = mechanism.raw('pins'), output = mechanism.cell('output');
    const leadContent = table(['机构', '软件状态', '相对位置（估算）', '使能'], mechanisms) + rows([
      ['机构样本年龄', lead.age()], ['详细接口状态（查询时）', manual.cell('available', value => flag(value, '在线', '离线'))],
      ['运行模式', mechanism.cell('simulated', value => flag(value, '仿真', 'GPIO 输出'))],
      ['忙碌 / 运动 / 复位（查询快照）', joined(mechanism.cell('busy', flag), mechanism.cell('moving', flag), mechanism.cell('resetting', flag))],
      ['脉冲频率', mechanism.cell('speed', number('steps/s', 0))], ['位置基准', mechanism.cell('position_reference', value => value === 'relative_to_node_start' ? '节点启动后的相对脉冲估算' : value)],
      ['驱动报警硬件反馈', mechanism.cell('alarm_feedback', value => value === false ? '无硬件反馈' : '未核验')], ['机构消息', manual.cell('message')],
      ['顺序归中软件标记', mechanism.cell('simulation_clamped', value => flag(value, '归中', '释放'))], ['下次顺序动作', mechanism.cell('simulation_next_action', value => label(value, { clamp: '归中', release: '释放' }))],
      ['详情相对位置（估算）', mechanism.cell('pos_mm', value => Array.isArray(value) ? value.map(item => numeric(item, 'mm', 3)).join(' / ') : '—')],
      ['详情软件状态', mechanism.cell('state', value => Array.isArray(value) ? value.map(item => stateLabels[item] || '未知').join(' / ') : '—')],
      ['详情使能', mechanism.cell('enabled', value => Array.isArray(value) ? value.map(item => flag(item)).join(' / ') : '—')],
      ['物理落位 / 充电电流 / 接触确认', '未提供传感器反馈']
    ]) + (geometry && typeof geometry === 'object' ? table(['组', '原开口（mm）', '目标开口（mm）', '单侧行程（mm）', '圈数', '脉冲数'], Object.keys(geometry).map(key => [key,
      ...['open_gap_mm', 'target_gap_mm', 'travel_mm', 'turns', 'pulses'].map(field => mechanism.cell(`simulation_geometry.${key}.${field}`))])) : '') +
      (Array.isArray(pins) ? table(['组', 'STEP GPIO', 'DIR GPIO', 'EN GPIO'], pins.map((_, index) => [index + 1,
        ...['step', 'direction', 'enable'].map(field => mechanism.cell(`pins.${index}.${field}`))])) : '') +
      (output.value !== null ? `<pre class="ugv-raw">${displayValue(output)}</pre>` : '') + '<p class="dialog-muted">位置与归中标记来自脉冲计数/软件状态，不证明机械限位、无人机落位、报警消除或充电完成。</p>';
    const camera = source('camera', data.camera, live && fresh(data.camera?.age_s, elapsed, 3), data.camera?.age_s);
    const cameras = table(['相机', '查询时状态', '样本年龄'], [['前视', camera.cell('ready', value => flag(value, '有有效帧', '暂无有效帧')), camera.age()]]) +
      '<div class="ugv-detail-toolbar"><button type="button" data-ugv-camera="front">查看前视</button></div>';
    const topicNames = snapshot.raw('topicAgesS') || {};
    const topics = table(['ROS 数据源', '样本年龄'], Object.keys(topicNames).map(key => [key, age(`topic.${key}`, data.topicAgesS?.[key])]));
    const rawStatus = snapshot.raw('rawSnapshot');
    const rawDetails = source('details-raw', details?.sections, Boolean(details?.sections), 0, detailsElapsed).raw('');
    const raw = safe(JSON.stringify({ status: rawStatus, details: rawDetails }, null, 2));
    return `<p class="dialog-muted">只读同步 · ${live ? '已接收车端快照' : '车端离线或快照已过期'} · 控制指令关闭。中性色数值为最近有效数据，悬停可查看年龄；连接与控制判定仍取实时状态。</p>` +
      group('status', '车辆与环境', status, true) + group('digital', '数字报警与采样状态', sensors) + group('location', '定位与 GPS', locationContent) +
      group('control', '控制权与指令链路', control) + group('map', '建图与已保存地图', mapContent) + group('navigation', '导航与自动巡航', navigationContent) +
      group('mechanism', '居中推杆机构', leadContent) + group('camera', '相机与画面', cameras) + group('topics', 'ROS 数据新鲜度', topics) +
      group('raw', '原始只读参数', `<p class="dialog-muted">未经实时有效性过滤的最后一次原始快照，仅供诊断。</p><pre class="ugv-raw">${raw}</pre>`);
  }
  function renderDetails(container, data, details, elapsed, detailsElapsed, nowMs = Date.now()) {
    const display = container._ugvDisplay || (container._ugvDisplay = createDetailsDisplay());
    const html = detailsHtml(data, details, elapsed, detailsElapsed, display, nowMs);
    if (container._ugvHtml === html) return;
    const opened = new Map([...container.querySelectorAll('details[data-group]')].map(element => [element.dataset.group, element.open]));
    const scroller = container.closest('#dialog-body');
    const scrollTop = scroller?.scrollTop;
    container.innerHTML = html;
    container._ugvHtml = html;
    container.querySelectorAll('details[data-group]').forEach(element => { if (opened.has(element.dataset.group)) element.open = opened.get(element.dataset.group); });
    if (scroller) scroller.scrollTop = scrollTop;
  }

  return { renderDetails, mechanismState, section, snapshotFresh, soundState, smokeState, coState, flameState, cameraState, mapState, createMetricDisplay, createSensorDisplay };
})();
