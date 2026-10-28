'use strict';

(() => {
  const get = id => document.getElementById(id);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const fields = [
    ['roll', '横滚', '°', 1], ['pitch', '俯仰', '°', 1], ['heading', '航向', '°', 1],
    ['gyroX', '陀螺仪 X（FLU）', 'rad/s', 4], ['gyroY', '陀螺仪 Y（FLU）', 'rad/s', 4], ['gyroZ', '陀螺仪 Z（FLU）', 'rad/s', 4],
    ['accelX', '加速度 X（FLU）', 'm/s²', 3], ['accelY', '加速度 Y（FLU）', 'm/s²', 3], ['accelZ', '加速度 Z（FLU）', 'm/s²', 3],
    ['batteryPercent', '电池电量', '%', 0], ['batteryVoltage', '电池电压', 'V', 2],
    ['rangefinder', '下视测距', 'm', 2], ['relativeAltitude', '相对 home 高度', 'm', 2],
    ['localAltitude', '局部 ENU 高度', 'm', 2], ['altitudeMsl', '海拔高度（MSL）', 'm', 2],
    ['verticalSpeed', '升降速度（向上为正）', 'm/s', 2],
    ['velocityX', '机体系速度 X（FLU）', 'm/s', 2], ['velocityY', '机体系速度 Y（FLU）', 'm/s', 2], ['velocityZ', '机体系速度 Z（FLU）', 'm/s', 2],
    ['throttle', '飞控油门输出', '%', 1], ['rc3', '遥控器通道 3', 'µs', 0],
    ['airspeed', '空速', 'm/s', 2], ['groundspeed', '地速', 'm/s', 2], ['batteryCurrent', '电池电流', 'A', 2],
    ['latitude', '纬度', '°', 7], ['longitude', '经度', '°', 7], ['satellites', 'GPS 卫星数', '', 0], ['hdop', 'GPS HDOP', '', 2], ['gpsFix', 'GPS 定位等级', '', 0],
    ['vibrationX', 'X 轴振动', 'm/s²', 2], ['vibrationY', 'Y 轴振动', 'm/s²', 2], ['vibrationZ', 'Z 轴振动', 'm/s²', 2], ['ekfFlags', 'EKF 状态标志', '', 0], ['cpuLoad', '飞控负载', '%', 1]
  ];
  const primary = ['batteryPercent', 'batteryVoltage', 'batteryCurrent', 'relativeAltitude', 'groundspeed', 'airspeed'];
  let snapshot = null, config = null, receivedAt = 0, lastResponse = null, errorMessage = '', busy = false, stopped = false, pollTimer, renderTimer;
  let failureCount = 0, cacheIdentity = null, cacheSourceIdentity = null, snapshotSequence = 0;
  const displayCache = new Map(), definitionCache = new Map(), stateCache = new Map();
  const flightSource = () => Object.hasOwn(config || {}, 'uavFlightSource')
    ? ['mission-planner', 'raspberry-pi'].includes(config.uavFlightSource) ? config.uavFlightSource : null
    : config?.liveOnly === true && config.uavFlightConfigured === true ? 'raspberry-pi' : config?.missionPlannerConfigured ? 'mission-planner' : null;
  const fromRpi = () => flightSource() === 'raspberry-pi';
  const snapshotIsSelected = () => !snapshot?.source || snapshot.source === (fromRpi() ? 'uav-rpi-deploy' : 'mission-planner-mavlink');
  const elapsed = () => snapshot ? Math.max(0, (performance.now() - receivedAt) / 1000) : 0;
  const age = value => finite(value) && value >= 0 ? value + elapsed() : null;
  const stateFresh = () => snapshotIsSelected() && snapshot?.flight?.connected === true && finite(age(snapshot.flight.stateAgeS)) && age(snapshot.flight.stateAgeS) <= 2;
  function ensureDisplaySource() {
    const transport = snapshotIsSelected() ? snapshot?.transport : null;
    const source = flightSource() || 'unconfigured', device = snapshotIsSelected() ? snapshot?.deviceId || 'UAV-01' : '';
    const previous = cacheIdentity?.split('|') || [], sameSource = previous[0] === source && previous[1] === device;
    // A disconnect can omit peer metadata; only an explicit source/peer change resets history.
    const identity = [source, device, fromRpi() ? '' : transport?.peerIp || (sameSource ? previous[2] : ''),
      fromRpi() ? '' : transport?.systemId ?? (sameSource ? previous[3] : ''), fromRpi() ? '' : transport?.componentId ?? (sameSource ? previous[4] : '')].join('|');
    const explicitIdentity = snapshotIsSelected() && typeof snapshot?.sourceIdentity === 'string' && snapshot.sourceIdentity ? snapshot.sourceIdentity : null;
    if (identity !== cacheIdentity || (explicitIdentity && explicitIdentity !== cacheSourceIdentity)) {
      displayCache.clear(); definitionCache.clear(); stateCache.clear(); cacheIdentity = identity; cacheSourceIdentity = explicitIdentity;
    }
  }
  function rememberSnapshot() {
    ensureDisplaySource(); if (!snapshotIsSelected()) return;
    snapshotSequence++;
    const flight = snapshot?.flight || {}, originConnected = flight.connected === true && finite(flight.stateAgeS) && flight.stateAgeS >= 0 && flight.stateAgeS <= 2;
    for (const [key, item] of Object.entries(flight.metrics || {})) {
      if (!item || typeof item !== 'object') continue;
      definitionCache.set(key, { ...definitionCache.get(key), ...item });
      const currentValidated = originConnected && item.valid === true && finite(item.value) && finite(item.ageS) && item.ageS >= 0
        && finite(item.maxAgeS) && item.maxAgeS >= 0 && item.ageS <= item.maxAgeS;
      // lastValid is separately validated by the adapter; rawValue is never a display fallback.
      const candidate = currentValidated ? { ...item, unit: typeof item.unit === 'string' ? item.unit : fields.find(field => field[0] === key)?.[2] || '',
        source: item.source || (fromRpi() ? '机载桥未提供来源' : 'MAVLink 来源未提供') } : item.lastValid;
      if (!candidate || !finite(candidate.value) || !finite(candidate.ageS) || candidate.ageS < 0 || !finite(candidate.maxAgeS) || candidate.maxAgeS < 0
        || typeof candidate.unit !== 'string' || typeof candidate.source !== 'string' || !candidate.source.trim()) continue;
      const sampleAt = receivedAt - candidate.ageS * 1000, previous = displayCache.get(key);
      if (!previous || sampleAt > previous.sampleAt) displayCache.set(key, { value: candidate.value, unit: candidate.unit, source: candidate.source, maxAgeS: candidate.maxAgeS, ageBasis: candidate.ageBasis, sampleAt });
    }
    if (!originConnected) return;
    const rememberState = (key, value, sampleAge, valid) => {
      if (valid && finite(sampleAge) && sampleAge >= 0 && sampleAge <= 2) stateCache.set(key, { value, sampleAt: receivedAt - sampleAge * 1000, sequence: snapshotSequence });
    };
    rememberState('mode', flight.mode, flight.stateAgeS, typeof flight.mode === 'string' && !['', 'UNKNOWN', 'DISCONNECTED'].includes(flight.mode));
    rememberState('armed', flight.armed, flight.stateAgeS, typeof flight.armed === 'boolean');
    rememberState('system', flight.details?.systemStatus, flight.stateAgeS, Number.isInteger(flight.details?.systemStatus) && flight.details.systemStatus >= 0 && flight.details.systemStatus <= 8);
    rememberState('landed', flight.landedState, flight.landedStateAgeS, ['ON_GROUND', 'IN_AIR', 'TAKEOFF', 'LANDING'].includes(flight.landedState));
  }
  function statusReading(key) {
    ensureDisplaySource(); const item = stateCache.get(key);
    const ageS = item ? Math.max(0, (performance.now() - item.sampleAt) / 1000) : null;
    const valid = !!item && !errorMessage && stateFresh() && item.sequence === snapshotSequence && ageS <= 2;
    return { value: item?.value ?? null, available: !!item, valid, retained: !!item && !valid, ageS };
  }
  const reasonText = reason => ({ GPS_NO_FIX: 'GPS 未定位', FLIGHT_CONTROLLER_DISCONNECTED: '飞控断连 / 过期', STATE_STALE_FOR_TELEMETRY: '飞控心跳已过期',
    NO_VALID_SAMPLE: '未上报有效样本', NOT_REPORTED: '未上报', NOT_CONNECTED: '旧版遥测桥未接入', NO_SAMPLE: '未上报',
    INVALID: '读数不合法', INVALID_VALUE: '读数不合法', NON_FINITE: '读数不合法', OUT_OF_RANGE: '读数超出有效范围', INVALID_OR_OUT_OF_RANGE: '读数不合法或超出范围',
    STALE: '已过期', STALE_SAMPLE: '已过期', STALE_OR_INVALID: '已过期或读数无效', UNKNOWN_AGE: '采样时间未知',
    INVALID_METADATA: '有效性信息不合法', INVALID_OR_UNREPORTED: '读数不合法或未上报', FRAME_UNAVAILABLE: '坐标系未确认', FRAME_OR_POSE_UNAVAILABLE: '坐标系或姿态不可用', NO_FRESH_COMMAND: '未收到有效的新指令', UNKNOWN: '来源状态未知', UNSUPPORTED_TYPE: '桥接不支持此消息类型', NOT_AVAILABLE: '当前来源不可用', METADATA_NOT_REPORTED: '缺少有效性信息', UNAVAILABLE_OR_STALE: '不可用 / 坐标系未确认', STALE_OR_UNKNOWN_AGE: '已过期或采样时间未知' }[reason] || (reason ? `数据状态未确认（${String(reason).slice(0, 80)}）` : '未上报'));
  const groupNames = { attitude: '姿态与 IMU', imu: '姿态与 IMU', power: '电源与电池', battery: '电源与电池', position: '位置与速度', velocity: '位置与速度',
    gps: 'GNSS 定位', gnss: 'GNSS 定位', environment: '气压、磁场与温度', sensors: '其他传感器', system: '飞控与状态估计', estimator: '飞控与状态估计',
    rc: '遥控器输入', rc_input: '遥控器输入', rc_output: '执行器输出', actuator: '执行器输出', vibration: '振动与状态估计',
    IMU: '姿态与 IMU', 电池: '电源与电池', GPS: 'GNSS 定位', 速度: '位置与速度', 估计器: '飞控与状态估计', 系统: '飞控与状态估计', 飞控系统: '飞控与状态估计', 遥控输入: '遥控器输入', 舵机输出: '执行器输出' };
  function groupFor(key, item) {
    if (typeof item?.group === 'string' && item.group.trim()) return groupNames[item.group] || item.group;
    if (/^(roll|pitch|heading|gyro|accel)/.test(key)) return '姿态与 IMU';
    if (/^battery/.test(key)) return '电源与电池';
    if (/^(latitude|longitude|satellites|hdop|gps)/.test(key)) return 'GNSS 定位';
    if (/^rcInput/.test(key) || key === 'rc3') return '遥控器输入';
    if (/^rcOutput/.test(key) || key === 'throttle') return '执行器输出';
    if (/^velocity[XYZ]$/.test(key)) return '机体系速度 FLU';
    if (/^(vibration|ekf|cpu)/.test(key)) return '飞控与状态估计';
    return '位置与速度';
  }
  function metricDefinitions() {
    ensureDisplaySource();
    const definitions = new Map(fields.map(([key, label, unit, digits]) => [key, { key, label, unit, digits }]));
    for (const [key, item] of definitionCache) {
      if (!item || typeof item !== 'object') continue;
      const known = definitions.get(key);
      definitions.set(key, { key, label: typeof item.label === 'string' && item.label.trim() ? item.label : known?.label || key,
        unit: typeof item.unit === 'string' ? item.unit === 'deg' ? '°' : item.unit : known?.unit || '',
        digits: Number.isInteger(item.digits) && item.digits >= 0 && item.digits <= 8 ? item.digits : known?.digits ?? 2 });
    }
    return [...definitions.values()].map(item => ({ ...item, group: groupFor(item.key, definitionCache.get(item.key)) }));
  }
  function metric(key) {
    ensureDisplaySource();
    const item = snapshotIsSelected() ? snapshot?.flight?.metrics?.[key] : null;
    const ageS = age(item?.ageS);
    const valid = !errorMessage && stateFresh() && item?.valid === true && finite(item.value) && finite(ageS) && finite(item.maxAgeS) && item.maxAgeS >= 0 && ageS <= item.maxAgeS;
    let reason = '实时有效';
    if (!valid) {
      if (!snapshot) reason = errorMessage ? '服务不可用' : '等待数据';
      else if (errorMessage) reason = '连接重试中';
      else if (!fromRpi() && !snapshot.transport?.acceptedMessages) reason = '等待转发';
      else if (!stateFresh()) reason = '飞控断连 / 过期';
      else if (!item) reason = fromRpi() && snapshot.flight?.details?.extraTelemetryStatus !== 'CONNECTED' ? '旧版遥测桥未接入' : '未上报';
      else if (item.valid !== true) reason = reasonText(item.reason);
      else if (!finite(item.value)) reason = '读数不合法';
      else if (!finite(ageS)) reason = '采样时间未知';
      else if (!finite(item.maxAgeS) || item.maxAgeS < 0) reason = '缺少有效期信息';
      else reason = '已过期';
    }
    const retained = !valid && displayCache.has(key), previous = retained ? displayCache.get(key) : null;
    return { value: valid ? item.value : previous?.value ?? null, ageS: retained ? Math.max(0, (performance.now() - previous.sampleAt) / 1000) : ageS,
      source: previous?.source || item?.source || (fromRpi() ? '机载桥未提供来源' : '未收到该 MAVLink 消息'), unit: previous?.unit ?? item?.unit,
      valid, retained, available: valid || retained, reason: retained ? `最近数据 · ${reason}` : reason };
  }
  const setText = (element, value) => { const text = String(value ?? ''); if (element.textContent !== text) element.textContent = text; };
  const tableRows = new Map(), groupRows = new Map(), sourceRows = new Map(), diagnosticRows = new Map(), diagnosticData = new WeakMap(), formattedData = new WeakMap();
  let rawResponse = null, displayedRawResponse = null;
  function updateRawResponse() {
    if (!get('raw-flight-details').open || rawResponse === displayedRawResponse) return;
    setText(get('raw-flight'), rawResponse === null ? '尚未收到数据' : JSON.stringify(rawResponse, null, 2)); displayedRawResponse = rawResponse;
  }
  function updateDiagnosticJson(row, data) {
    diagnosticData.set(row, data);
    if (row.open && (formattedData.get(row) !== data || !formattedData.has(row))) {
      setText(row.children[2], JSON.stringify(data ?? null, null, 2)); formattedData.set(row, data);
    }
  }
  function renderPairs(container, entries) {
    while (container.children.length > entries.length) container.lastElementChild.remove();
    entries.forEach(([label, value], index) => {
      let row = container.children[index];
      if (!row) { row = document.createElement('div'); row.append(document.createElement('dt'), document.createElement('dd')); container.append(row); }
      setText(row.children[0], label); setText(row.children[1], value);
    });
  }
  function renderMetrics() {
    const definitions = metricDefinitions(), groups = [...new Set(definitions.map(item => item.group))];
    const selector = get('telemetry-group-filter'), search = get('telemetry-search').value.trim().toLocaleLowerCase();
    const groupKey = groups.join('\u0000');
    if (selector.dataset.groups !== groupKey) {
      const selection = selector.value;
      selector.replaceChildren(new Option('全部分组', ''), ...groups.map(group => new Option(group, group)));
      selector.value = groups.includes(selection) ? selection : ''; selector.dataset.groups = groupKey;
    }
    const body = get('telemetry-rows'), visibleKeys = new Set(), visibleGroups = new Set(), definitionKeys = new Set(definitions.map(item => item.key));
    let total = 0, valid = 0, retained = 0, cursor = body.firstElementChild;
    const position = node => { if (node !== cursor) body.insertBefore(node, cursor); cursor = node.nextElementSibling; };
    for (const group of groups) {
      const selected = definitions.filter(item => item.group === group && (!selector.value || selector.value === group) && (!search || `${item.label} ${item.key} ${definitionCache.get(item.key)?.source || ''}`.toLocaleLowerCase().includes(search)));
      if (!selected.length) continue;
      visibleGroups.add(group);
      let heading = groupRows.get(group);
      if (!heading) { heading = document.createElement('tr'); heading.className = 'telemetry-group'; const cell = document.createElement('th'); cell.colSpan = 5; cell.scope = 'rowgroup'; heading.append(cell); groupRows.set(group, heading); }
      setText(heading.firstElementChild, `${group} · ${selected.length} 项`); position(heading);
      for (const definition of selected) {
        const { key, label, unit, digits } = definition, item = metric(key);
        visibleKeys.add(key); total++; if (item.valid) valid++; if (item.retained) retained++;
        let row = tableRows.get(key);
        if (!row) { row = document.createElement('tr'); row.dataset.metric = key; for (let i = 0; i < 5; i++) row.append(document.createElement('td')); tableRows.set(key, row); }
        const displayUnit = typeof item.unit === 'string' ? item.unit === 'deg' ? '°' : item.unit : unit;
        const values = [key === 'rangefinder' && !fromRpi() ? '测距（方向未确认）' : label,
          item.available ? `${item.value.toFixed(digits)}${displayUnit ? ' ' + displayUnit : ''}` : '—', item.reason, finite(item.ageS) ? item.ageS.toFixed(2) + ' s' : '—', item.source];
        values.forEach((value, index) => setText(row.children[index], value));
        row.children[2].className = item.valid ? 'value-valid' : item.retained ? 'value-retained' : 'value-missing'; position(row);
      }
    }
    for (const [key, row] of tableRows) if (!visibleKeys.has(key)) { row.remove(); if (!definitionKeys.has(key)) tableRows.delete(key); }
    for (const [key, row] of groupRows) if (!visibleGroups.has(key)) row.remove();
    setText(get('telemetry-count'), `${total} 项 · ${valid} 项实时有效${retained ? ` · ${retained} 项最近数据` : ''}`);
    get('telemetry-empty').hidden = total !== 0;
    setText(get('telemetry-extension-status'), fromRpi() && snapshot && snapshot.flight?.details?.extraTelemetryStatus !== 'CONNECTED' ? '当前机载桥尚未接入扩展遥测。已收到的有效读数会保留并标记最近数据。' : '按参数、通道或数据来源搜索；最近数据保留原样本年龄，未收到的指标显示 —。');
  }
  function diagnosticState(item, defaultAge = 3) {
    if (!item) return { text: '未上报', valid: false, ageS: null };
    const ageS = age(item.ageS), maxAge = finite(item.maxAgeS) && item.maxAgeS >= 0 ? item.maxAgeS : defaultAge;
    if (item.status === 'NOT_CONNECTED') return { text: '旧版遥测桥未接入', valid: false, ageS };
    if (item.status === 'STALE') return { text: '已过期', valid: false, ageS };
    if (['UNSUPPORTED_TYPE', 'NOT_AVAILABLE', 'INVALID_METADATA', 'UNKNOWN_AGE'].includes(item.status)) return { text: reasonText(item.status), valid: false, ageS };
    if (item.status === 'NOT_REPORTED' || item.status === 'NO_SAMPLE' || item.count === 0) return { text: '未上报', valid: false, ageS };
    if (errorMessage || !stateFresh()) return { text: '连接中断 / 仅供诊断', valid: false, ageS };
    if (!finite(ageS)) return { text: '采样时间未知', valid: false, ageS };
    if (ageS > maxAge) return { text: '已过期', valid: false, ageS };
    if (item.valid === false || ['INVALID', 'INVALID_VALUE', 'OUT_OF_RANGE'].includes(item.status)) return { text: reasonText(item.reason || item.status), valid: false, ageS };
    return { text: '已接收 · 仅供诊断', valid: true, ageS };
  }
  function diagnosticElement(map, key, container) {
    let row = map.get(key);
    if (!row) {
      row = document.createElement('details'); row.className = 'telemetry-source'; row.dataset.source = key;
      const summary = document.createElement('summary'); summary.append(document.createElement('span'), document.createElement('span'));
      const note = document.createElement('p'); note.className = 'source-note';
      row.append(summary, note, document.createElement('pre')); map.set(key, row); container.append(row);
      row.addEventListener('toggle', () => updateDiagnosticJson(row, diagnosticData.get(row)));
    }
    return row;
  }
  function renderDiagnostics(details) {
    const enabled = fromRpi(); get('telemetry-sources-card').hidden = !enabled; if (!enabled) return;
    const sources = Array.isArray(details.telemetrySources) ? details.telemetrySources : [], active = new Set();
    const container = get('telemetry-sources'); let received = 0;
    sources.forEach((item, index) => {
      if (!item || typeof item !== 'object') return;
      const key = `${String(item.topic || `未命名来源 ${index + 1}`)}\u0000${String(item.messageType || '')}`; active.add(key);
      const row = diagnosticElement(sourceRows, key, container), state = diagnosticState(item);
      if (state.valid) received++;
      setText(row.children[0].children[0], item.topic || '未命名来源');
      setText(row.children[0].children[1], state.text);
      row.children[0].children[1].className = state.valid ? 'value-valid' : 'value-missing';
      setText(row.children[1], `${item.messageType || '消息类型未提供'} · 收包 ${finite(item.count) && item.count >= 0 ? Math.trunc(item.count) : '—'} · 样本年龄 ${finite(state.ageS) ? state.ageS.toFixed(2) + ' s' : '—'}${typeof item.error === 'string' && item.error ? ' · 原因：' + item.error : ''}`);
      updateDiagnosticJson(row, item.data ?? null);
    });
    for (const [key, row] of sourceRows) if (!active.has(key)) { row.remove(); sourceRows.delete(key); }
    setText(get('telemetry-sources-count'), `${sources.length} 个来源 · ${received} 个在有效期内`);
    get('telemetry-sources-empty').hidden = sources.length !== 0;
    setText(get('telemetry-sources-empty'), details.telemetrySourcesStatus !== 'CONNECTED' ? '当前机载桥尚未接入来源诊断。' : '尚未上报遥测来源。');
    for (const [key, label] of [['velocity', '机载速度与坐标系'], ['motionCommand', '机载运动指令状态'], ['executor', '机载执行器状态']]) {
      const item = details[key], state = diagnosticState(item || { status: details[`${key}Status`] || 'NOT_CONNECTED' }), row = diagnosticElement(diagnosticRows, key, get('flight-execution-diagnostics'));
      setText(row.children[0].children[0], label); setText(row.children[0].children[1], state.text);
      setText(row.children[1], `${item?.source || '来源未提供'} · 样本年龄 ${finite(state.ageS) ? state.ageS.toFixed(2) + ' s' : '—'} · 仅查看机载上报，不发送命令`);
      updateDiagnosticJson(row, item?.data ?? item ?? null);
    }
  }
  function render() {
    ensureDisplaySource();
    const fresh = !errorMessage && stateFresh(), flight = snapshotIsSelected() ? snapshot?.flight || {} : {}, details = flight.details || {};
    const hasRetained = [...displayCache.keys()].some(key => metric(key).retained) || [...stateCache.keys()].some(key => statusReading(key).retained);
    const banner = get('flight-banner');
    let bannerText = errorMessage ? `Mission Planner 遥测不可用：${errorMessage}；正在自动重试。` : !config ? '正在连接 Mission Planner 接收服务…' : !snapshot ? '正在读取 Mission Planner 转发数据…' : fresh ? 'Mission Planner MAVLink 转发已接收 · 正在显示飞控数据。' : snapshot.transport?.acceptedMessages ? 'Mission Planner 转发已中断或飞控心跳过期。' : '接收服务已就绪 · 等待另一台电脑转发 Mission Planner MAVLink 数据。';
    if (fromRpi()) {
      document.title = 'UAV-01 树莓派实时遥测 · Atomori';
      document.querySelector('.eyebrow').textContent = 'UAV-01 / RASPBERRY PI';
      document.querySelector('.subtitle').textContent = '机载 HTTP 只读遥测 · 有效数据与来源';
      document.querySelector('.connection-card h2').textContent = '树莓派遥测链路';
      get('connection-note').textContent = '直接读取已配置的机载只读遥测桥。过期或断连时保留最近有效读数并累计样本年龄；未发送解锁、起飞或参数修改命令。';
      get('attitude-empty').textContent = '未收到有效姿态数据';
      document.querySelector('.telemetry-card .card-note').textContent = '高度与测距采用不同基准。样本年龄累计机载接收后的等待；缓存消息另校验原消息时间，不代表端到端延迟。';
      const columns = document.querySelectorAll('.telemetry-table thead th');
      columns[3].textContent = '样本年龄';
      columns[4].textContent = 'ROS 数据来源';
      get('mirror-source').parentElement.querySelector('dt').textContent = '当前遥测来源';
      get('mirror-count').parentElement.querySelector('dt').textContent = '机载来源累计收包';
      bannerText = errorMessage ? `树莓派遥测不可用：${errorMessage}；正在自动重试。` : fresh ? '已接收树莓派只读遥测。' : '树莓派遥测未返回有效飞控心跳。';
    }
    setText(banner, bannerText + (hasRetained ? ' 部分内容显示最近有效数据，样本年龄持续累计。' : ''));
    banner.classList.toggle('is-connected', fresh && !hasRetained);
    banner.classList.toggle('is-retained', hasRetained);
    get('connection-badge').textContent = fresh ? '飞控在线' : fromRpi() ? '飞控离线/过期' : snapshot?.transport?.acceptedMessages ? '心跳已过期' : '等待转发';
    get('connection-badge').classList.toggle('is-connected', fresh);
    const systemStates = { 0: '未初始化', 1: '启动中', 2: '校准中', 3: '待机', 4: '运行中', 5: '严重异常', 6: '紧急状态', 7: '关机中', 8: '飞行终止' };
    const gpsFix = metric('gpsFix'), satellites = metric('satellites');
    const mode = statusReading('mode'), armed = statusReading('armed'), landed = statusReading('landed'), system = statusReading('system');
    const statusLabel = (item, format = value => value) => item.available ? `${format(item.value)}${item.retained ? `（最近数据 · ${item.ageS.toFixed(1)} s）` : ''}` : '—';
    const rows = [
      ['飞行模式', statusLabel(mode)], ['解锁状态', statusLabel(armed, value => value ? '已解锁' : '未解锁')],
      ['落地状态', statusLabel(landed, value => ({ ON_GROUND: '在地面', IN_AIR: '在空中', TAKEOFF: '起飞中', LANDING: '降落中' }[value] || '未知'))],
      ['系统状态', statusLabel(system, value => systemStates[value] || '未知')],
      ['GPS 定位', gpsFix.available ? ({ 0: '无 GPS', 1: '未定位', 2: '2D 定位', 3: '3D 定位', 4: 'DGPS', 5: 'RTK 浮点', 6: 'RTK 固定', 7: '静态', 8: 'PPP' }[gpsFix.value] || '未知') + (satellites.available ? ` · ${satellites.value} 颗卫星` : '') + (gpsFix.retained || satellites.retained ? '（最近数据）' : '') : '未收到有效状态'],
      ['心跳接收年龄', finite(age(flight.stateAgeS)) ? `${age(flight.stateAgeS).toFixed(2)} s` : '—']
    ];
    renderPairs(get('flight-state'), rows);
    primary.forEach((key, index) => {
      const [, label, unit, digits] = fields.find(field => field[0] === key), item = metric(key);
      const container = get('primary-metrics'); let card = container.children[index];
      if (!card) { card = document.createElement('div'); card.className = 'primary-metric'; const value = document.createElement('strong'); value.append(document.createElement('span'), document.createElement('small')); card.append(document.createElement('span'), value, document.createElement('p')); container.append(card); }
      setText(card.children[0], label); setText(card.children[1].children[0], item.available ? item.value.toFixed(digits) : '—'); setText(card.children[1].children[1], item.available ? unit : '');
      setText(card.children[2], item.retained ? `最近数据 · ${item.ageS.toFixed(1)} s` : item.reason); card.children[2].className = item.retained ? 'value-retained' : '';
    });
    renderMetrics(); renderDiagnostics(details);
    const roll = metric('roll'), pitch = metric('pitch'), attitudeAvailable = roll.available && pitch.available, attitudeValid = roll.valid && pitch.valid;
    get('roll-value').textContent = roll.available ? roll.value.toFixed(1) + '°' : '—';
    get('pitch-value').textContent = pitch.available ? pitch.value.toFixed(1) + '°' : '—';
    const heading = metric('heading');
    get('heading-value').textContent = heading.available ? heading.value.toFixed(1) + '°' : '—';
    for (const [key, item] of [['roll', roll], ['pitch', pitch], ['heading', heading]]) {
      get(`${key}-value`).classList.toggle('value-retained', item.retained);
      get(`${key}-value`).title = item.retained ? `最近数据 · 样本年龄 ${item.ageS.toFixed(1)} s` : item.reason;
    }
    const hudValue = (key, unit, digits = 1) => { const item = metric(key); return item.available ? item.value.toFixed(digits) + unit : '—' + unit; };
    get('hud-airspeed').textContent = hudValue('airspeed', ' m/s');
    get('hud-altitude').textContent = hudValue('relativeAltitude', ' m');
    get('hud-groundspeed').textContent = '地速 ' + hudValue('groundspeed', ' m/s');
    get('hud-voltage').textContent = '电池 ' + hudValue('batteryVoltage', ' V') + ' / ' + hudValue('batteryCurrent', ' A');
    get('hud-armed').textContent = armed.available ? (armed.value ? '已解锁' : '已锁定') + (armed.retained ? ' · 最近数据' : '') : '状态未知';
    get('hud-armed').setAttribute('fill', armed.valid ? armed.value ? '#f5b174' : '#c9e7d8' : '#c8d5e1');
    get('hud-mode').textContent = mode.available ? mode.value + (mode.retained ? ' · 最近数据' : '') : '—';
    get('flight-horizon').setAttribute('visibility', attitudeAvailable ? 'visible' : 'hidden');
    get('flight-horizon').setAttribute('transform', attitudeAvailable ? `rotate(${-roll.value} 320 180) translate(0 ${pitch.value * 3.5})` : '');
    get('attitude-empty').setAttribute('visibility', attitudeAvailable ? 'hidden' : 'visible');
    get('attitude-status').textContent = attitudeValid ? '姿态实时有效' : attitudeAvailable ? `姿态最近数据 · ${Math.max(roll.ageS, pitch.ageS).toFixed(1)} s` : '无有效姿态';
    get('flight-attitude').setAttribute('aria-label', attitudeAvailable ? `${attitudeValid ? '实时姿态' : '最近有效姿态'}：横滚 ${roll.value.toFixed(1)} 度，俯仰 ${pitch.value.toFixed(1)} 度` : '姿态数据不可用');
    const healthFresh = fresh && details.healthValid !== false && finite(age(details.healthAgeS)) && age(details.healthAgeS) <= 3;
    const health = Array.isArray(details.health) ? details.health : [];
    renderPairs(get('flight-health'), (health.length ? health : ['陀螺仪', '加速度计', '磁力计', '气压计', 'GPS', '预解锁检查'].map(label => ({ label, state: '未上报' }))).map(item => {
      let state = healthFresh ? item.state : !fresh ? '飞控断连 / 自检无有效状态' : finite(age(details.healthAgeS)) ? '自检已过期' : '自检未上报';
      if (fromRpi() && !healthFresh) {
        const group = item.label === '陀螺仪' ? 'gyro' : item.label === '加速度计' ? 'accel' : null;
        const samples = group ? ['X', 'Y', 'Z'].map(axis => metric(group + axis)) : [];
        state = samples.length && samples.every(sample => sample.available)
          ? `${samples.every(sample => sample.valid) ? '实时' : `最近数据（${Math.max(...samples.map(sample => sample.ageS)).toFixed(1)} s）`} ${samples.map(sample => sample.value.toFixed(group === 'gyro' ? 4 : 3)).join(' / ')} ${group === 'gyro' ? 'rad/s' : 'm/s²'}（X/Y/Z）· ${state}`
          : state;
      }
      return [item.label, state];
    }));
    const alerts = fresh && Array.isArray(details.alerts) ? details.alerts.filter(item => item.valid !== false && finite(age(item.ageS)) && age(item.ageS) <= 30) : [];
    const alertBox = get('flight-alerts');
    if (!alerts.length) setText(alertBox, '最近 30 秒没有收到有效状态消息');
    else {
      if (!alertBox.children.length) alertBox.textContent = '';
      while (alertBox.children.length > alerts.length) alertBox.lastElementChild.remove();
      alerts.slice().reverse().forEach((item, index) => {
        let row = alertBox.children[index];
        if (!row) { row = document.createElement('p'); const text = document.createElement('span'); text.className = 'alert-message'; row.append(document.createElement('span'), text); alertBox.append(row); }
        setText(row.children[0], `${age(item.ageS).toFixed(1)} s 前 · 等级 ${item.severity}`); setText(row.children[1], item.text);
      });
    }
    get('mirror-source').textContent = snapshot?.transport?.peerIp ? `${snapshot.transport.peerIp} · SYS ${snapshot.transport.systemId} / COMP ${snapshot.transport.componentId}` : '尚未收到转发';
    get('mirror-count').textContent = String(snapshot?.transport?.acceptedMessages ?? 0);
    if (fromRpi()) {
      get('mirror-source').textContent = snapshot?.source === 'uav-rpi-deploy' ? '机载 flight-status-http' : '等待机载遥测';
      const counts = Array.isArray(details.telemetrySources) ? details.telemetrySources.map(item => item.count).filter(value => finite(value) && value >= 0) : [];
      setText(get('mirror-count'), counts.length ? String(counts.reduce((sum, value) => sum + Math.trunc(value), 0)) + '（各来源合计）' : '桥接未提供');
    }
    get('last-response').textContent = lastResponse ? lastResponse.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（本机接收）' : '—';
    get('poll-status').textContent = document.hidden ? '页面隐藏 · 暂停请求' : busy ? '读取中' : errorMessage ? '自动重试中' : '自动刷新';
  }
  async function poll() {
    if (stopped || busy || document.hidden) return;
    const pollStartedAt = performance.now();
    clearTimeout(pollTimer); busy = true; get('refresh-flight').disabled = true;
    try {
      if (!config) config = (await AtomoriApi.request('/integrations', { timeoutMs: 4000 })).data;
      if (!config || !['demo', 'upstream-readonly'].includes(config.mode)) throw new Error('遥测配置无效');
      if (!flightSource() || (fromRpi() ? !config.uavFlightConfigured : !config.missionPlannerConfigured)) {
        snapshot = null; errorMessage = ''; config = null;
        throw new Error('飞控遥测服务尚未配置');
      }
      const requestedAt = performance.now();
      const result = await AtomoriApi.request(fromRpi() ? '/devices/UAV-01/telemetry?source=flight' : '/devices/UAV-01/mission-planner', { timeoutMs: 4000 });
      const expectedSource = fromRpi() ? 'uav-rpi-deploy' : 'mission-planner-mavlink';
      if (!result?.data?.flight || result.data.deviceId !== 'UAV-01' || result.data.source !== expectedSource) throw new Error('遥测响应来源无效');
      if (fromRpi()) result.data.flight.metrics = { ...result.data.flight.details?.metrics, ...result.data.flight.metrics };
      snapshot = result.data;
      receivedAt = AtomoriApi.sampleTime(snapshot, requestedAt);
      lastResponse = new Date(); errorMessage = ''; failureCount = 0; rememberSnapshot();
      rawResponse = snapshot; updateRawResponse();
    } catch (error) {
      // Preserve the original sample clock and mark the last validated values as recent data.
      errorMessage = AtomoriApi.message(error); failureCount++;
      rawResponse = { error: errorMessage, lastReceivedAt: lastResponse?.toISOString() || null }; updateRawResponse();
    } finally {
      busy = false; get('refresh-flight').disabled = false; render();
      // Count request/render time inside the 750 ms cadence; failed requests back off to 4 s.
      if (!stopped && !document.hidden) pollTimer = setTimeout(poll, errorMessage ? Math.min(4000, 750 * 2 ** Math.min(failureCount - 1, 3)) : Math.max(0, 750 - (performance.now() - pollStartedAt)));
    }
  }
  function start() { stopped = false; clearInterval(renderTimer); renderTimer = setInterval(render, 200); poll(); }
  get('refresh-flight').addEventListener('click', poll);
  get('telemetry-group-filter').addEventListener('change', renderMetrics);
  get('telemetry-search').addEventListener('input', renderMetrics);
  get('raw-flight-details').addEventListener('toggle', updateRawResponse);
  document.addEventListener('visibilitychange', () => { clearTimeout(pollTimer); if (!document.hidden) poll(); render(); });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(pollTimer); clearInterval(renderTimer); });
  window.addEventListener('pageshow', event => { if (event.persisted) start(); });
  render(); start();
})();
