'use strict';

// 只负责只读设备数据与图传；业务记录由 records.js 管理。
(async () => {
  const get = id => document.getElementById(id);
  const optionalText = (selector, text) => { const element = document.querySelector(selector); if (element) element.textContent = text; };
  let latestFlight = {};
  let uavReceivedAt = 0;
  let latestVision = {};
  let visionReceivedAt = 0;
  let latestUgv = {};
  let ugvReceivedAt = 0;
  let latestUgvDetails = {};
  let ugvDetailsReceivedAt = 0;
  const ugvBattery = AtomoriUgvBattery.create();
  const ugvMetricDisplay = AtomoriUgvView.createMetricDisplay();
  let stopped = false;
  function renderAttitude(roll = null, pitch = null) {
    const block = document.querySelector('.attitude-block');
    const valid = Number.isFinite(roll) && Number.isFinite(pitch);
    get('uav-roll').textContent = Number.isFinite(roll) ? roll.toFixed(1) + '°' : '—';
    get('uav-pitch').textContent = Number.isFinite(pitch) ? pitch.toFixed(1) + '°' : '—';
    block.dataset.valid = String(valid);
    get('attitude-status').hidden = valid;
    // Retain the instrument face offline, explicitly labelled as a reference, never a measured level attitude.
    block.querySelector('.attitude-horizon').setAttribute('transform', valid ? `rotate(${-roll} 60 60) translate(0 ${pitch * 0.8})` : '');
    block.querySelector('svg').setAttribute('aria-label', valid
      ? `无人机姿态：横滚 ${roll.toFixed(1)} 度，俯仰 ${pitch.toFixed(1)} 度`
      : '无人机姿态数据不可用，仪表为静态参考底图');
    block.title = '飞控融合姿态；横滚正值为向右倾斜，俯仰正值为抬头；样本过期或断连时读数清空，仪表显示静态参考底图。';
  }
  const pollingTimers = new Set();
  const referenceMapUrl = document.body.dataset.carMapImage || '';
  let carMapName = referenceMapUrl ? '参考图片' : 'current';
  let carMapFetchedAt = 0, carMapSampleAgeS = null;
  let carMapObjectUrl = null, carMapBusy = false;
  const heightNumber = value => Number.isFinite(value) ? value.toFixed(2) + ' m' : '未上报';
  const diagnosticFlightValue = (key, value) => {
    if (flightSource() === 'mission-planner' && key === 'rangefinder') return null;
    const elapsed = (performance.now() - uavReceivedAt) / 1000;
    const item = latestFlight.metrics?.[key];
    const age = Number.isFinite(item?.ageS) ? item.ageS : item?.ageBasis === 'upstream_bridge_validity_gate' ? latestFlight.stateAgeS : null;
    return latestFlight.connected === true && Number.isFinite(latestFlight.stateAgeS) && latestFlight.stateAgeS >= 0 && latestFlight.stateAgeS + elapsed <= 2
      && item?.valid === true && Number.isFinite(age) && age >= 0 && age + elapsed <= item.maxAgeS ? value : null;
  };
  const heightDiagnostic = () => flightSource() === 'mission-planner'
    ? `<p>离地高度：未上报。下视传感器距离：未上报。</p><p>飞控 home 高度估计：<span data-flight-diagnostic="relativeAltitude">${heightNumber(diagnosticFlightValue('relativeAltitude', latestFlight.metrics?.relativeAltitude?.value))}</span>（基准未核验，不作为离地高度）。</p><p class="dialog-muted">Mission Planner 转发的测距方向尚未确认，不能作为下视距离或离地高度。</p>`
    : `<p>离地高度：<span data-flight-diagnostic="rangefinder">${heightNumber(diagnosticFlightValue('rangefinder', latestFlight.rangefinderM))}</span>（采用实时下视测距，以传感器为测量基准）。</p><p>下视传感器距离：<span data-flight-diagnostic="rangefinder">${heightNumber(diagnosticFlightValue('rangefinder', latestFlight.rangefinderM))}</span>（传感器到所测表面的距离）。</p><p>飞控 home 高度估计：<span data-flight-diagnostic="relativeAltitude">${heightNumber(diagnosticFlightValue('relativeAltitude', latestFlight.relativeAltitudeM))}</span>（基准未核验，不作为离地高度）。</p><p class="dialog-muted">离地高度采用有效的 /landing/sensor_range；尚未补偿传感器安装偏移或机体倾斜。测距无效或过期时显示 —，不使用 home 估计或相机到标签的距离替代。</p>`;
  let config;
  const flightSource = () => Object.hasOwn(config || {}, 'uavFlightSource')
    ? ['mission-planner', 'raspberry-pi'].includes(config.uavFlightSource) ? config.uavFlightSource : null
    : config?.uavFlightConfigured ? 'raspberry-pi' : config?.missionPlannerConfigured ? 'mission-planner' : null;
  const independentFlight = () => flightSource() !== null;
  document.addEventListener('click', event => {
    if (config || !event.target.closest('#expand-ground,#expand-camera,#ground-view,#ground-camera-shortcut,[data-camera],[data-nav="devices"],[data-business],#restore-camera,#thermal-view')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    openDialog('正在读取设备配置', '<p>正在连接实时数据服务，收到有效设备数据后显示画面与测量。</p>');
  }, true);
  // Install these entries before loading configuration so offline details remain reachable.
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-open-ugv-details],[data-open-ugv-scan]');
    if (!button) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!config?.carConfigured) {
      openDialog('无人车数据不可用', '<p>尚未连接车端只读服务，无法读取实时遥测、相机或雷达。</p>');
    } else if (button.matches('[data-open-ugv-scan]')) openScan();
    else openUgvDetails();
  }, true);
  try {
    config = (await AtomoriApi.request('/integrations')).data;
    if(!config || !['demo','upstream-readonly'].includes(config.mode))throw new Error('接入配置无效');
    // This console only displays measured device data, including when no adapter is configured.
    config = { ...config, liveOnly: true };
    AtomoriRuntime.config = config;
    document.dispatchEvent(new CustomEvent('atomori:connection', { detail: { available: true, mode: config.mode } }));
    setReadOnlyMode(true);
  } catch {
    document.dispatchEvent(new CustomEvent('atomori:connection', { detail: { available: false } }));
    config = { liveOnly: true };
    setReadOnlyMode(true);
    document.querySelectorAll('.device-panel .metric-grid strong,.relative-position dd').forEach(element => { element.textContent = '—'; });
    for (const id of ['main-camera', 'ground-camera']) { get(id).removeAttribute('src'); get(id).alt = '未收到真实图像'; }
    document.querySelectorAll('.camera-feed .feed-quality').forEach(element => { element.textContent = '未连接'; });
    document.querySelectorAll('.camera-feed .feed-bottom').forEach(element => { element.textContent = '未收到设备图像'; });
    for (const id of ['relative-drone', 'relative-vector']) { if (get(id)) get(id).style.visibility = 'hidden'; }
    get('drone-state').textContent = get('rover-state').textContent = '连接未确认';
    optionalText('#vision-state', '视觉未连接');
    optionalText('#dock-state', '补能未接入');
    optionalText('#dock-subline', '落位与充电电气数据未接入');
    document.querySelectorAll('.environment-grid b').forEach(element => { element.textContent = '—'; });
    document.querySelectorAll('.device-panel .telemetry-heading small').forEach(element => { element.textContent = '数据不可用'; });
    renderAttitude();
    get('video-latency').textContent = '—';
    document.querySelectorAll('[data-camera-tab],#expand-camera,#ground-view,#expand-ground').forEach(element => { element.disabled = true; });
    document.querySelectorAll('[data-business],.asset-pin,#instrument-finding,[data-nav="devices"]').forEach(element => {
      if (element.dataset.business === 'mapping' && element.closest('.business-nav')) {
        element.onclick = () => location.assign('corridor-overview.html');
      } else element.disabled = true;
    });
    applyLiveOnlyLabels();
    return;
  }
  optionalText('.spatial-heading h2 span', '演示地图 · 未与车端地图配准');
  optionalText('.running-label', '演示任务');
  optionalText('.map-hint', '示意图与点位数值为样本');
  optionalText('.map-legend span:last-child', '设备状态以遥测为准');
  document.querySelector('.link-topology').textContent = '通信拓扑未接入';
  optionalText('#dock-state', '补能未接入');
  optionalText('#dock-subline', '落位与充电电气数据未接入');


  const intercept = (element, action) => element?.addEventListener('click', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    action();
  }, true);
  intercept(document.querySelector('[data-nav="devices"]'), () => {
    openDialog('设备数据接入', `<p>车端网关：${config.carConfigured ? '已配置，状态以遥测为准' : '未配置'}</p><div id="ugv-live-details"></div><p>机载视觉服务：${config.uavVisionConfigured ? '已配置，状态以遥测为准' : '未配置'}</p><p>飞控遥测来源：${flightSource() === 'mission-planner' ? 'Mission Planner 转发' : flightSource() === 'raspberry-pi' ? '树莓派只读状态桥' : config.uavVisionConfigured ? '视觉服务内嵌快照' : '未配置'}，状态以有效心跳为准。</p>${heightDiagnostic()}<p class="dialog-muted">电池、测距未上报或过期时显示 —。控制指令未开放。</p>`);
    renderUgv();
  });
  intercept(document.querySelector('.business-nav [data-business="mapping"]'), () => location.assign('corridor-overview.html?view=2d'));

  const metric = (panel, number) => document.querySelector(`.${panel}-panel .metric-grid .metric:nth-child(${number}) strong`);
  const display = (value, digits, unit) => Number.isFinite(value) ? `${value.toFixed(digits)} <small>${unit}</small>` : '—';
  const show = (element, value, digits, unit) => { if (element) element.innerHTML = display(value, digits, unit); };
  const fresh = age => Number.isFinite(age) && age >= 0 && age <= 2;
  const explainMetric = (element, item) => {
    if(!element)return;
    element.title = item ? `${item.source} · ${item.unit} · ${item.valid ? '有效上报' : item.reason} · 数据年龄 ${Number.isFinite(item.ageS) ? item.ageS.toFixed(2)+' s' : '未提供'}` : '上游尚未提供此测量字段';
  };

  function applyLiveOnlyLabels() {
    if (!config.liveOnly) return;
    optionalText('.spatial-heading h2 span', '管廊示意图 · 未与实机配准');
    optionalText('.map-hint', '示意图无实时设施测量数据');
    document.querySelectorAll('.spatial-kpis > div > b').forEach(element => { element.textContent = '—'; });
    document.querySelectorAll('.asset-pin').forEach(element => {
      element.querySelectorAll('em').forEach(value => { value.textContent = '测量未接入'; });
      element.setAttribute('aria-label', `${element.dataset.sitePoint || element.querySelector('span')?.firstChild?.textContent || '设施'}，测量未接入`);
    });
    document.querySelectorAll('.map-marker,.twin-route,#map-route,#map-rover,#map-drone,#map-ground-fov,#map-air-fov,#map-uav-label').forEach(element => { element.style.visibility = 'hidden'; });
    optionalText('#instrument-summary', '测量未接入');
    optionalText('#mission-location', '实时任务位置未接入');
    if (document.querySelector('.mission-strip')) {
      get('mission-id').textContent = '实机任务未接入';
      document.querySelector('.mission-name > strong').firstChild.textContent = '实机任务 ';
      document.querySelector('.running-label').textContent = '未接入';
      get('progress-count').textContent = '—';
      document.querySelector('.mission-completion > span').lastChild.textContent = ' / —';
      get('progress-bar').style.width = '0%';
      document.querySelectorAll('.mission-stages > div').forEach((element, index) => { element.classList.remove('done', 'current'); element.querySelector('i').textContent = String(index + 1); });
    }
    get('target-bracket').style.visibility = 'hidden';
  }
  if (config.liveOnly) {
    applyLiveOnlyLabels();
    for (const key of config.carConfigured ? ['surface', 'instrument', 'acoustic'] : ['surface', 'instrument', 'acoustic', 'thermal', 'gas']) {
      document.querySelectorAll(`[data-business="${key}"]`).forEach(button => intercept(button, () => openDialog('实机测量未接入', '<p>该设备未提供可核验的实时测量数据。</p><p class="dialog-muted">实时模式不使用样本图片、仪表读数或声学频谱替代设备数据。</p>')));
    }
    intercept(get('instrument-finding'), () => openDialog('仪表测量未接入', '<p>尚未收到真实仪表测量数据。</p>'));
    document.querySelectorAll('.asset-pin').forEach(button => intercept(button, () => openDialog('设施测量未接入', '<p>尚未收到该设施的真实测量或图像数据。</p>')));
    if (!config.carConfigured) {
      for (const id of ['ground-view', 'expand-ground']) intercept(get(id), () => openDialog('车端未连接', '<p>小车接口当前保持断开，没有实时图像。</p>'));
    }
  }

  function renderRelativePosition() {
    const panel = document.querySelector('.relative-position');
    if (!panel) return;
    const relative = latestVision.relativePose;
    const ageS = Number.isFinite(relative?.ageS) ? relative.ageS + (performance.now() - visionReceivedAt) / 1000 : null;
    const valid = relative?.valid === true && relative.frame === 'BODY_FRD'
      && [relative.xM, relative.yM, relative.zM].every(Number.isFinite)
      && Number.isFinite(ageS) && ageS >= 0 && ageS <= relative.maxAgeS;
    const signed = (value, digits, unit) => `${value > 0 ? '+' : ''}${value.toFixed(digits)} <small>${unit}</small>`;
    const entries = [['relative-x', 'xM', 3, 'm'], ['relative-y', 'yM', 3, 'm'], ['relative-z', 'zM', 3, 'm'], ['relative-yaw', 'yawDeg', 1, '°']];
    for (const [id, key, digits, unit] of entries) {
      get(id).innerHTML = valid && Number.isFinite(relative[key]) ? signed(relative[key], digits, unit) : '—';
    }
    const state = get('vision-state');
    state.textContent = !config.uavVisionConfigured ? '机载未连接' : valid ? `视觉定位 · Tag ${relative.tagId ?? '—'}`
      : relative?.reason === 'TAG_NOT_DETECTED' ? '未识别标签'
      : relative?.reason === 'QUALITY_REJECTED' ? '视觉质量未通过'
      : relative?.reason === 'STALE_OR_UNKNOWN_AGE' || relative?.valid ? '视觉数据过期'
      : relative?.reason === 'INVALID_POSE' ? '相对位姿无效' : '视觉离线';
    state.classList.toggle('amber', !valid);
    get('relative-x').title = '着陆标签相对无人机机体的位置，BODY_FRD：X 向前为正';
    get('relative-y').title = '着陆标签相对无人机机体的位置，BODY_FRD：Y 向右为正';
    get('relative-z').title = '标签相对机体的向下距离，BODY_FRD：Z 向下为正；不是飞控 home 高度';
    get('relative-yaw').title = '标签平台前向相对机头的角度，向机体右侧为正；不是飞控绝对航向';
    panel.querySelector('p').textContent = valid ? `BODY_FRD · 标签相对机体 · ${ageS.toFixed(2)} s 前` : state.textContent;
    panel.title = `机载视觉估计，采用树莓派相机外参和标签标定；精度尚未现场核验。${relative?.rangeCorrectionStatus ? ' 距离标定：' + relative.rangeCorrectionStatus : ''}`;
    const marker = get('relative-drone'), vector = get('relative-vector');
    marker.style.visibility = vector.style.visibility = valid ? 'visible' : 'hidden';
    if (valid) {
      const scale = 27 / Math.max(1, Math.hypot(relative.xM, relative.yM));
      const x = 43 + relative.yM * scale, y = 40 - relative.xM * scale;
      marker.setAttribute('cx', x); marker.setAttribute('cy', y);
      vector.setAttribute('d', `M43 40 ${x} ${y}`);
    }
    document.dispatchEvent(new CustomEvent('atomori:relative', { detail: { valid, horizontal: valid ? Math.hypot(relative.xM, relative.yM) : null } }));
  }

  function applyUgv(data, requestedAt = performance.now()) {
    latestUgv = data || {};
    // The localhost adapter stamps receivedAt after sampling. Browser connection-pool
    // queueing happens BEFORE that sample and must not prematurely expire it.
    const receivedAt = Date.parse(data?.receivedAt), now = Date.now();
    const adapterElapsed = Number.isFinite(data?.snapshotAgeS) && data.snapshotAgeS >= 0 ? data.snapshotAgeS * 1000 : 0;
    ugvReceivedAt = Number.isFinite(receivedAt) && receivedAt <= now
      ? performance.now() - (now - receivedAt)
      : Math.min(performance.now(), requestedAt + adapterElapsed);
    renderUgv();
  }

  const ugvAge = age => Number.isFinite(age) ? age + (performance.now() - ugvReceivedAt) / 1000 : null;
  const ugvValue = item => item?.valid === true && Number.isFinite(ugvAge(item.ageS)) && ugvAge(item.ageS) >= 0 && ugvAge(item.ageS) <= item.maxAgeS ? item.value : null;
  const positionText = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
    ? `X ${value[0].toFixed(2)} · Y ${value[1].toFixed(2)} m · 航向 ${(value[2] * 180 / Math.PI).toFixed(1)}°` : '位姿 —';
  function renderUgv() {
    const data = latestUgv;
    const elapsed = (performance.now() - ugvReceivedAt) / 1000;
    const detailsElapsed = (performance.now() - ugvDetailsReceivedAt) / 1000;
    const snapshotFresh = AtomoriUgvView.snapshotFresh(data, elapsed);
    const speed = ugvValue(data.metrics?.speed);
    const odomFresh = fresh(ugvAge(data.odom?.ageS));
    const batteryEstimate = ugvBattery.update({ fresh: config.carConfigured && snapshotFresh,
      sampleId: data.receivedAt || null, sampleAtMs: Date.parse(data.receivedAt), uptimeS: data.gateway?.uptime_s, nowMs: Date.now() });
    show(metric('ugv', 1), batteryEstimate.percent, 0, '%');
    metric('ugv', 1).title = batteryEstimate.title;
    for (const [index, key, digits, unit] of [[2, 'speed', 2, 'm/s'], [3, 'temperature', 1, '°C'], [4, 'humidity', 0, '%RH']]) {
      const item = data.metrics?.[key];
      const element = metric('ugv', index);
      const reading = ugvMetricDisplay(config.carConfigured ? data : {}, key, elapsed, performance.now());
      show(element, reading.value, digits, unit);
      explainMetric(element, item ? { ...item, ageS: ugvAge(item.ageS), valid: Number.isFinite(ugvValue(item)), reason: item.valid && !Number.isFinite(ugvValue(item)) ? '页面缓存已过期' : item.reason } : null);
      if (reading.retained) {
        element.innerHTML += `<small class="metric-sample-note">上次有效 · ${Math.ceil(reading.ageS)} 秒前</small>`;
        element.title = `上次有效读数，非当前测量；${reading.ageS.toFixed(1)} 秒前。${element.title}`;
      }
    }
    const muxFresh = snapshotFresh && fresh(ugvAge(data.topicAgesS?.ugv_control_mux));
    const gatewayFresh = snapshotFresh && fresh(ugvAge(data.topicAgesS?.ugv_command_gateway));
    const emergency = (muxFresh && data.controlMux?.emergency_stop === true) || (gatewayFresh && data.commandGateway?.emergency_stop === true);
    get('rover-state').textContent = !config.carConfigured ? '车端未配置' : emergency ? '急停状态' : Number.isFinite(speed) ? Math.abs(speed) < 0.02 ? '驻停' : '行驶中' : data.receivedAt ? '里程计过期/缺失' : '车端离线';
    get('rover-state').classList.toggle('amber', !Number.isFinite(speed) || emergency);
    const updated = data.observedAt ? new Date(data.observedAt) : null;
    const time = updated && Number.isFinite(updated.getTime()) ? updated.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '时间未提供';
    document.querySelector('.ugv-panel .telemetry-heading small').textContent = Number.isFinite(speed) ? time : '数据不可用';
    document.querySelector('.ugv-panel .telemetry-heading small').title = '车端状态快照时间；各传感器独立检查样本年龄';
    const localized = data.localization?.active === true && data.localization?.state === 'localized' && fresh(ugvAge(data.localization?.age_s));
    const location = localized ? data.localization.map_pose : odomFresh ? data.odom.pose : null;
    document.querySelector('.link-topology').textContent = `${localized ? '地图' : '里程计'} · ${positionText(location)}`;
    document.querySelector('.link-topology').title = '车端原始坐标；地图未叠加车辆标记，点击车辆详情查看更多数据';
    document.dispatchEvent(new CustomEvent('atomori:ugv', { detail: { online: config.carConfigured && snapshotFresh, localized, battery: batteryEstimate.percent } }));
    document.querySelectorAll('.environment-grid button').forEach((button, index) => {
      const [key, label] = [['sound', '声音'], ['flame', '火焰'], ['mq2', '气体检测']][index];
      button.querySelector('span').textContent = label;
      if (key === 'sound') {
        const sound = AtomoriUgvView.soundState(config.carConfigured ? data : {}, elapsed);
        button.querySelector('b').textContent = sound.text;
        button.querySelector('b').style.color = sound.color;
        button.title = sound.title;
        return;
      }
      const sensor = data.environment?.digital?.[key];
      const valid = config.carConfigured && sensor?.valid === true
        && typeof sensor.triggered === 'boolean' && fresh(ugvAge(sensor.ageS));
      const gas = key === 'mq2';
      button.querySelector('b').textContent = valid
        ? gas ? sensor.triggered ? '危险' : '正常' : sensor.triggered ? '触发' : '未触发'
        : '—';
      button.querySelector('b').style.color = gas
        ? valid ? sensor.triggered ? 'var(--red)' : 'var(--green)' : 'var(--muted)'
        : valid && sensor.triggered ? 'var(--amber)' : '';
      button.title = gas
        ? '气体检测依据 MQ2 数字报警信号：触发显示危险，未触发显示正常；不代表气体种类或浓度。离线、过期或未上报显示 —'
        : '数字传感器开关量，不代表气体浓度；过期或未上报显示 —';
    });
    document.dispatchEvent(new CustomEvent('atomori:sensors'));
    const details = get('ugv-live-details');
    if (details && get('action-dialog').open) AtomoriUgvView.renderDetails(details, data, latestUgvDetails, elapsed, detailsElapsed);
    if (config.carConfigured && document.querySelector('.dock-status')) {
      const dock = AtomoriUgvView.mechanismState(data, latestUgvDetails, elapsed, detailsElapsed);
      get('dock-state').textContent = dock.state;
      get('dock-subline').textContent = dock.subline;
      document.querySelector('.dock-status').classList.remove('charging');
    }
  }

  function applyUav(data, requestedAt = performance.now()) {
    // The adapter has already included its request/wait duration in every sample.
    // Add only browser transit, and never replace the other independent source.
    const adapterElapsed = data.ageIncludes === 'device-http-and-response-wait' && Number.isFinite(data.snapshotAgeS) && data.snapshotAgeS >= 0 ? data.snapshotAgeS * 1000 : 0;
    const sampleReceivedAt = Math.min(performance.now(), requestedAt + adapterElapsed);
    if (Object.hasOwn(data, 'flight')) { latestFlight = data.flight || {}; uavReceivedAt = sampleReceivedAt; }
    if (Object.hasOwn(data, 'vision')) { latestVision = data.vision || {}; visionReceivedAt = sampleReceivedAt; }
    renderUav();
  }

  function renderUav() {
    const flight = latestFlight;
    document.querySelectorAll('[data-flight-diagnostic]').forEach(node => {
      const key = node.dataset.flightDiagnostic;
      node.textContent = heightNumber(diagnosticFlightValue(key, key === 'rangefinder' ? flight.rangefinderM : flightSource() === 'mission-planner' ? flight.metrics?.relativeAltitude?.value : flight.relativeAltitudeM));
    });
    const elapsed = (performance.now() - uavReceivedAt) / 1000;
    const metricValue = (key, value) => {
      const item = flight.metrics?.[key];
      const age = Number.isFinite(item?.ageS) ? item.ageS : item?.ageBasis === 'upstream_bridge_validity_gate' ? flight.stateAgeS : null;
      return item?.valid === true && Number.isFinite(age) && age >= 0 && age + elapsed <= item.maxAgeS ? value : null;
    };
    renderRelativePosition();
    const valid = flight.connected === true && fresh(Number.isFinite(flight.stateAgeS) ? flight.stateAgeS + elapsed : null);
    const roll = valid ? metricValue('roll', flight.rollDeg) : null;
    const pitch = valid ? metricValue('pitch', flight.pitchDeg) : null;
    renderAttitude(roll, pitch);
    explainMetric(get('uav-roll'), flight.metrics?.roll);
    explainMetric(get('uav-pitch'), flight.metrics?.pitch);
    show(metric('uav', 1), valid ? metricValue('batteryPercent', flight.batteryPercent) : null, 0, '%');
    show(get('uav-voltage'), valid ? metricValue('batteryVoltage', flight.batteryVoltage) : null, 2, 'V');
    const downwardRange = valid && flightSource() !== 'mission-planner' ? metricValue('rangefinder', flight.rangefinderM) : null;
    show(get('range-value'), downwardRange, 2, 'm');
    for(const [element,key] of [[metric('uav',1),'batteryPercent'],[get('uav-voltage'),'batteryVoltage'],[get('range-value'),'rangefinder']])explainMetric(element,flight.metrics?.[key]);
    const height = get('uav-height');
    height.parentElement.querySelector('span').textContent='离地高度';
    show(height, downwardRange, 2, 'm');
    explainMetric(height, flight.metrics?.rangefinder);
    height.title += ' · 实时下视测距，以传感器为基准；未补偿安装偏移与机体倾斜';
    if (flightSource() === 'mission-planner') height.title = get('range-value').title = 'Mission Planner 测距方向未确认，尚无可用的下视距离或离地高度';
    get('drone-state').textContent = !config.uavVisionConfigured && !independentFlight() ? '飞控未连接' : valid ? `${flight.mode} · ${flight.armed ? '已解锁' : '未解锁'}` : '飞控离线/过期';
    document.querySelector('.uav-panel .telemetry-heading small').textContent = valid ? flightSource() === 'mission-planner' ? 'Mission Planner' : '飞控数据' : '数据过期';
    document.dispatchEvent(new CustomEvent('atomori:uav', { detail: { online: valid, battery: valid ? metricValue('batteryPercent', flight.batteryPercent) : null } }));
  }

  function schedule(action, delay) {
    if (stopped) return;
    const timer = setTimeout(() => { pollingTimers.delete(timer); if (!stopped) void action(); }, delay);
    pollingTimers.add(timer);
  }

  function openUgvDetails(group) {
    openDialog('无人车 · 实时遥测', '<div id="ugv-live-details"></div>');
    renderUgv();
    const section = typeof group === 'string' ? get('ugv-live-details').querySelector(`[data-group="${group}"]`) : null;
    if (section) { section.open = true; section.scrollIntoView({ block: 'start' }); }
  }

  let groundCameraId = 'front', groundObjectUrl = null, groundFrameAt = 0, groundFrameAgeS = null, groundBusy = false;
  let groundStream = null, groundRetryAt = 0, groundRequest = null, groundEpoch = 0;
  const groundNames = { front: '前视', rear: '后视', top: '俯视' };
  let setGroundMode = () => {};
  const groundCamera = get('ground-camera');
  groundCamera.removeAttribute('src');
  groundCamera.style.visibility = 'hidden';
  document.querySelector('.ground-feed .feed-quality').textContent = config.carConfigured ? '等待车端画面' : '车端未配置';
  document.querySelector('.ground-feed .feed-bottom').textContent = '车端相机 · 等待有效采样年龄';
  document.querySelector('.ground-feed .feed-label').textContent = '车端相机 · 暂无画面';
  const groundStatus = () => AtomoriUgvView.cameraState(latestUgv, groundCameraId, (performance.now() - ugvReceivedAt) / 1000);
  const groundVisible = () => !stopped && !document.hidden && !document.querySelector('.ground-feed').classList.contains('show-car-map');
  const groundStreamUrl = clientId => `/api/v1/devices/UGV-01/cameras/front.mjpg?clientId=${clientId}`;
  function stopGroundStream() {
    groundEpoch += 1;
    groundStream = null;
    groundRequest?.abort(); groundRequest = null;
    groundBusy = false;
    groundCamera.removeAttribute('src');
    get('ugv-expanded-camera')?.removeAttribute('src');
  }
  function clearGroundFrame(reason) {
    stopGroundStream();
    groundCamera.style.visibility = 'hidden'; groundCamera.removeAttribute('src');
    get('ugv-expanded-camera')?.removeAttribute('src');
    if (groundObjectUrl) URL.revokeObjectURL(groundObjectUrl);
    groundObjectUrl = null; groundFrameAt = 0; groundFrameAgeS = null;
    document.querySelector('.ground-feed .feed-label').textContent = `车端${groundNames[groundCameraId]} · 暂无画面`;
    document.querySelector('.ground-feed .feed-quality').textContent = '无有效实时帧';
    document.querySelector('.ground-feed .feed-bottom').textContent = reason;
    if (get('ugv-camera-status')) get('ugv-camera-status').textContent = reason;
  }
  function renderGroundFreshness() {
    const status = groundStatus();
    if (groundCameraId === 'front') {
      if (!groundVisible()) { if (groundStream) clearGroundFrame('图传已暂停'); return; }
      // The car's MJPEG endpoint emits new frames only. Once verified, incoming
      // bytes establish video liveness independently of a delayed telemetry poll.
      if (!status.valid && groundStream?.lastDataAt == null) { clearGroundFrame(status.reason); return; }
      if (!groundStream) return;
      const silenceS = (performance.now() - (groundStream.lastDataAt ?? groundStream.startedAt)) / 1000;
      if (silenceS > (groundStream.lastDataAt === null ? 8 : 3)) {
        groundRetryAt = performance.now() + 1000; clearGroundFrame('视频中断，正在重连'); return;
      }
      if (groundStream.lastDataAt !== null) {
        const label = status.valid ? `设备帧龄 ≤ ${status.ageS.toFixed(1)} s · 连续视频` : '连续接收车端新画面';
        document.querySelector('.ground-feed .feed-bottom').textContent = label;
        if (get('ugv-camera-status')) get('ugv-camera-status').textContent = label;
      }
      return;
    }
    const ageS = Number.isFinite(groundFrameAgeS) ? groundFrameAgeS + (performance.now() - groundFrameAt) / 1000 : null;
    if (!status.valid || (groundObjectUrl && (!Number.isFinite(ageS) || ageS > 3))) {
      clearGroundFrame(!status.valid ? status.reason : '已显示相机帧过期，等待新帧');
      return;
    }
    if (groundObjectUrl) {
      const label = `相机采样年龄 ≤ ${ageS.toFixed(1)} s · 设备帧龄与请求等待累计`;
      document.querySelector('.ground-feed .feed-bottom').textContent = `画面年龄 ≤ ${ageS.toFixed(1)} s`;
      document.querySelector('.ground-feed .feed-bottom').title = label;
      if (get('ugv-camera-status')) get('ugv-camera-status').textContent = label;
    }
  }
  function selectGroundCamera(selected) {
    if (!Object.hasOwn(groundNames, selected)) return;
    groundCameraId = selected;
    groundRetryAt = 0;
    get('ground-camera-select').value = selected;
    clearGroundFrame('等待有效实时帧');
    setGroundMode(false);
    void refreshGroundCamera();
  }
  async function refreshGroundCamera() {
    if (!groundVisible() || groundBusy || !config.carConfigured) return;
    if (groundCameraId === 'front') {
      if ((!groundStream && !groundStatus().valid) || performance.now() < groundRetryAt) return;
      if (!groundStream) {
        const clientId = `ugv-front-${crypto.randomUUID()}`;
        groundStream = { clientId, startedAt: performance.now(), lastDataAt: null, checkedAt: -Infinity, bytes: 0 };
        groundCamera.src = groundStreamUrl(clientId);
        groundCamera.alt = '车端前视连续视频'; groundCamera.style.visibility = 'visible';
        document.querySelector('.ground-feed .feed-label').textContent = '车端前视 · 实时图传';
        document.querySelector('.ground-feed .feed-quality').textContent = '连接视频中…';
        const expanded = get('ugv-expanded-camera');
        if (expanded && get('action-dialog').open) expanded.src = groundStreamUrl(`ugv-expanded-${crypto.randomUUID()}`);
      }
      const connection = groundStream;
      if (performance.now() - connection.checkedAt < 1000) return;
      connection.checkedAt = performance.now(); groundBusy = true;
      const requestedAt = performance.now(), epoch = groundEpoch;
      const controller = new AbortController(); groundRequest = controller;
      try {
        const response = await fetch('/api/v1/devices/UGV-01/streams', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]) });
        if (!response.ok) throw new Error('视频状态暂不可用');
        const data = (await response.json()).data;
        if (epoch !== groundEpoch || groundStream !== connection) return;
        const health = data.streamHealth?.find(item => item.clientId === connection.clientId && item.cameraId === 'front.mjpg');
        if (health?.active && Number.isFinite(health.idleAgeMs) && health.idleAgeMs >= 0 && health.receivedBytes > connection.bytes) {
          connection.bytes = health.receivedBytes;
          const lastDataAt = Date.parse(health.lastDataAt), now = Date.now();
          connection.lastDataAt = Number.isFinite(lastDataAt) && lastDataAt <= now
            ? performance.now() - (now - lastDataAt)
            : requestedAt - health.idleAgeMs;
          document.querySelector('.ground-feed .feed-quality').textContent = '连续视频';
        }
      } catch { /* A transient health-request failure does not clear a fresh playing frame. */ }
      finally {
        if (epoch === groundEpoch) { groundBusy = false; groundRequest = null; renderGroundFreshness(); }
      }
      return;
    }
    groundBusy = true;
    const selected = groundCameraId, epoch = groundEpoch;
    const status = groundStatus(), started = performance.now();
    let candidateUrl = null;
    try {
      if (!status.valid) throw new Error(status.reason);
      groundRequest = new AbortController();
      const response = await fetch(`/api/v1/devices/UGV-01/cameras/${selected}.jpg?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.any([groundRequest.signal, AbortSignal.timeout(3000)]) });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) throw new Error('图像不可用');
      candidateUrl = URL.createObjectURL(await response.blob());
      const decoded = new Image(); decoded.src = candidateUrl;
      await decoded.decode();
      if (epoch !== groundEpoch || !groundVisible() || selected !== groundCameraId) return;
      if (!groundStatus().valid || status.ageS + (performance.now() - started) / 1000 > status.maxAgeS) throw new Error('相机帧在请求期间过期');
      const previousUrl = groundObjectUrl;
      groundObjectUrl = candidateUrl; candidateUrl = null;
      groundCamera.src = groundObjectUrl;
      groundCamera.alt = `车端${groundNames[selected]}当前画面`;
      groundCamera.style.visibility = 'visible';
      groundFrameAt = started; groundFrameAgeS = status.ageS;
      document.querySelector('.ground-feed .feed-label').textContent = `车端${groundNames[selected]} · 实时图传`;
      document.querySelector('.ground-feed .feed-quality').textContent = '实时帧刷新';
      if (get('ugv-expanded-camera')) get('ugv-expanded-camera').src = groundObjectUrl;
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      renderGroundFreshness();
    } catch (error) {
      if (epoch === groundEpoch && !stopped && selected === groundCameraId) {
        if (!groundObjectUrl) clearGroundFrame(error.message || '图像不可用');
        else renderGroundFreshness();
      }
    } finally {
      if (candidateUrl) URL.revokeObjectURL(candidateUrl);
      if (epoch === groundEpoch) { groundBusy = false; groundRequest = null; }
    }
  }
  groundCamera.onerror = () => { groundRetryAt = performance.now() + 1000; clearGroundFrame('图传中断，正在重连'); };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearGroundFrame('页面隐藏，图传已暂停');
    else void refreshGroundCamera();
  });
  get('action-dialog').addEventListener('close', () => get('ugv-expanded-camera')?.removeAttribute('src'));
  {
    const feed = document.querySelector('.ground-feed');
    const mapLayer = document.createElement('div');
    mapLayer.className = 'ground-map-layer';
    mapLayer.innerHTML = '<img id="car-map-image" alt="车端当前栅格地图"><div class="feed-top"><span class="feed-label">车端地图 · 激光雷达</span><span class="feed-quality">等待有效地图</span></div><div class="feed-bottom"><span id="car-map-status">当前地图未连接</span><span id="car-map-resolution">—</span></div>';
    mapLayer.title = carMapName + ' · 黑色障碍物，白色空闲，灰色未知';
    get('ground-camera').parentElement.append(mapLayer);
    const tabs = document.createElement('div');
    tabs.className = 'camera-tabs';
    const cameraButton = get('ground-view');
    cameraButton.before(tabs);
    tabs.append(cameraButton);
    const mapButton = document.createElement('button');
    mapButton.id = 'ground-map-view';
    mapButton.textContent = '车端地图';
    tabs.append(mapButton);
    const cameraSelect = document.createElement('select');
    cameraSelect.id = 'ground-camera-select'; cameraSelect.setAttribute('aria-label', '地面图传相机');
    for (const [id, name] of Object.entries(groundNames)) {
      const option = document.createElement('option'); option.value = id; option.textContent = name; cameraSelect.append(option);
    }
    cameraSelect.disabled = !config.carConfigured;
    cameraSelect.onchange = () => selectGroundCamera(cameraSelect.value);
    feed.append(cameraSelect);
    setGroundMode = map => {
      feed.classList.toggle('show-car-map', map);
      mapButton.setAttribute('aria-pressed', String(map));
      cameraButton.setAttribute('aria-pressed', String(!map));
      cameraButton.textContent = '地面图传';
      cameraSelect.hidden = map;
      get('expand-ground').setAttribute('aria-label', map ? '放大车端地图' : '放大无人车图传');
      if (map) clearGroundFrame('地图视图，图传已暂停');
    };
    mapButton.onclick = () => {
      if (referenceMapUrl) carMapName = '参考图片';
      setGroundMode(true); void refreshMap();
    };
    setGroundMode(false);
    if (referenceMapUrl) void refreshMap();
    const detailButton = document.createElement('button');
    detailButton.id = 'ugv-details-button'; detailButton.dataset.openUgvDetails = ''; detailButton.textContent = '车辆详情 ↗';
    detailButton.onclick = openUgvDetails;
    document.querySelector('.ugv-panel .telemetry-heading').append(detailButton);
    document.querySelectorAll('.environment-grid button').forEach(button => intercept(button, openUgvDetails));
    intercept(document.querySelector('.business-nav [data-business="thermal"]'), () => openUgvDetails('status'));
    intercept(document.querySelector('.business-nav [data-business="gas"]'), () => openUgvDetails('digital'));
    intercept(get('ground-view'), () => { setGroundMode(false); void refreshGroundCamera(); });
    intercept(get('expand-ground'), () => {
      if (feed.classList.contains('show-car-map')) {
        openDialog('车端地图 · ' + carMapName, '<img id="ugv-map-image" alt="车端地图"><p id="ugv-map-status"></p>');
        if (carMapObjectUrl) get('ugv-map-image').src = carMapObjectUrl;
        get('ugv-map-status').textContent = get('car-map-status').textContent;
        void refreshMap();
        return;
      }
      openDialog(`UGV ${groundNames[groundCameraId]} · 实时画面`, '<img id="ugv-expanded-camera" alt="车端当前帧"><p id="ugv-camera-status" class="dialog-muted">相机无有效新鲜帧时清空画面。</p>');
      if (groundStream) get('ugv-expanded-camera').src = groundStreamUrl(`ugv-expanded-${crypto.randomUUID()}`);
      else if (groundObjectUrl && groundCamera.style.visibility === 'visible') get('ugv-expanded-camera').src = groundObjectUrl;
      renderGroundFreshness();
    });
    const scanButton = document.querySelector('.ugv-panel [data-business="mapping"]');
    if (scanButton) { scanButton.id = 'ugv-scan-button'; scanButton.dataset.openUgvScan = ''; scanButton.textContent = '实时雷达 ↗'; }
  }

  function openScan() {
    openDialog('无人车 · 实时雷达', '<canvas id="ugv-scan" width="600" height="400" aria-label="车端二维激光雷达扫描"></canvas><p id="ugv-scan-status">等待雷达数据…</p><p id="ugv-escape-status"></p><p class="dialog-muted">车体坐标的二维激光扫描；前方朝上，左侧朝左。橙色折线为设备上报的脱困路径。</p>');
    void refreshScan();
  }

  get('dialog-body').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || !config.carConfigured) return;
    const selectedMap = button.dataset.ugvMap;
    const selectedCamera = button.dataset.ugvCamera;
    if (selectedMap && /^[A-Za-z0-9_-]{1,128}$/.test(selectedMap)) {
      closeDialog();
      carMapName = selectedMap;
      clearMap('正在请求 ' + selectedMap);
      setGroundMode(true);
      void refreshMap();
    } else if (Object.hasOwn(groundNames, selectedCamera)) {
      closeDialog();
      selectGroundCamera(selectedCamera);
    }
  });

  let scanBusy = false;
  let scanReceivedAt = 0, scanAgeS = null;
  function clearMap(reason) {
    const image = get('car-map-image');
    if (!image) return;
    image.removeAttribute('src'); image.style.visibility = 'hidden';
    get('ugv-map-image')?.removeAttribute('src');
    if (carMapObjectUrl) URL.revokeObjectURL(carMapObjectUrl);
    carMapObjectUrl = null; carMapFetchedAt = 0; carMapSampleAgeS = null;
    get('car-map-status').textContent = reason;
    get('car-map-resolution').textContent = '—';
    document.querySelector('.ground-map-layer .feed-quality').textContent = '地图不可用';
    if (get('ugv-map-status')) get('ugv-map-status').textContent = reason;
  }
  function renderMapFreshness() {
    if (!carMapObjectUrl || carMapName !== 'current') return;
    const state = AtomoriUgvView.mapState(latestUgv, (performance.now() - ugvReceivedAt) / 1000);
    const imageAgeS = Number.isFinite(carMapSampleAgeS) ? carMapSampleAgeS + (performance.now() - carMapFetchedAt) / 1000 : null;
    if (!state.valid || !Number.isFinite(imageAgeS) || imageAgeS > state.maxAgeS) {
      clearMap(!state.valid ? state.reason : '地图图像已过期，等待新快照');
      return;
    }
    get('car-map-status').textContent = `当前栅格地图 · 样本年龄 ≤ ${Math.max(imageAgeS, state.ageS).toFixed(1)} s`;
    if (get('ugv-map-status')) get('ugv-map-status').textContent = get('car-map-status').textContent;
  }
  async function refreshMap() {
    const image = get('car-map-image');
    if (!image || stopped) return;
    if (referenceMapUrl && carMapName === '参考图片') {
      if (carMapObjectUrl) URL.revokeObjectURL(carMapObjectUrl);
      carMapObjectUrl = null; carMapFetchedAt = 0; carMapSampleAgeS = null;
      if (image.getAttribute('src') !== referenceMapUrl) image.src = referenceMapUrl;
      image.alt = '车端地图参考图片'; image.style.visibility = 'visible';
      const expanded = get('ugv-map-image');
      if (expanded && expanded.getAttribute('src') !== referenceMapUrl) expanded.src = referenceMapUrl;
      document.querySelector('.ground-map-layer .feed-label').textContent = '车端地图';
      document.querySelector('.ground-map-layer .feed-quality').textContent = '参考图片';
      document.querySelector('.ground-map-layer').title = '用户提供的地图参考图片';
      get('car-map-status').textContent = '静态参考图片';
      get('car-map-resolution').textContent = '';
      if (get('ugv-map-status')) get('ugv-map-status').textContent = '静态参考图片';
      return;
    }
    if (carMapBusy) return;
    carMapBusy = true;
    const selected = carMapName;
    const started = performance.now();
    let candidateUrl = null;
    try {
      if (!config.carConfigured) throw new Error('车端未连接');
      const sample = AtomoriUgvView.mapState(latestUgv, (performance.now() - ugvReceivedAt) / 1000);
      if (selected === 'current' && !sample.valid) throw new Error(sample.reason);
      const response = await fetch(`/api/v1/maps/${selected}.png?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) throw new Error('地图不可用');
      candidateUrl = URL.createObjectURL(await response.blob());
      const decoded = new Image(); decoded.src = candidateUrl;
      await decoded.decode();
      if (stopped || selected !== carMapName) return;
      const current = selected === 'current';
      const latest = AtomoriUgvView.mapState(latestUgv, (performance.now() - ugvReceivedAt) / 1000);
      if (current && (!latest.valid || sample.ageS + (performance.now() - started) / 1000 > sample.maxAgeS)) throw new Error(!latest.valid ? latest.reason : '地图样本在请求期间过期');
      const previousUrl = carMapObjectUrl;
      carMapObjectUrl = candidateUrl; candidateUrl = null;
      carMapFetchedAt = started; carMapSampleAgeS = sample.ageS;
      image.src = carMapObjectUrl;
      image.alt = current ? '车端当前栅格地图' : '车端历史保存地图';
      image.style.visibility = 'visible';
      if (get('ugv-map-image')) get('ugv-map-image').src = carMapObjectUrl;
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      document.querySelector('.ground-map-layer .feed-label').textContent = '车端地图 · 激光雷达';
      document.querySelector('.ground-map-layer .feed-quality').textContent = current ? '当前栅格快照' : '历史保存地图';
      document.querySelector('.ground-map-layer').title = selected + ' · 黑色障碍物，白色空闲，灰色未知';
      get('car-map-status').textContent = current ? '正在接收当前地图' : `${selected} · 历史地图，采样时间未知`;
      renderMapFreshness();
      const cruise = AtomoriUgvView.section(latestUgvDetails, 'autoCruise', (performance.now() - ugvDetailsReceivedAt) / 1000);
      const info = current ? latestUgv.map?.info : cruise?.mapName === selected ? cruise.mapInfo : null;
      get('car-map-resolution').textContent = Number.isFinite(info?.resolution) && info.resolution > 0 ? `${info.resolution} m/格` : '分辨率未上报';
    } catch (error) {
      if (!stopped && selected === carMapName) clearMap(error.message || '车端地图不可用');
    } finally {
      if (candidateUrl) URL.revokeObjectURL(candidateUrl);
      if (get('ugv-map-status')) get('ugv-map-status').textContent = get('car-map-status').textContent;
      carMapBusy = false;
      if (!stopped && selected !== carMapName) void refreshMap();
    }
  }
  async function refreshScan() {
    const canvas = get('ugv-scan');
    if (scanBusy || !canvas || !get('action-dialog').open || stopped) return;
    scanBusy = true;
    const context = canvas.getContext('2d');
    try {
      const started = performance.now();
      const data = (await AtomoriApi.request('/devices/UGV-01/scan', { timeoutMs: 3000 })).data;
      if (get('ugv-scan') !== canvas || stopped) return;
      scanReceivedAt = performance.now();
      scanAgeS = Number.isFinite(data?.age_s) ? data.age_s + (scanReceivedAt - started) / 1000 : null;
      const valid = fresh(scanAgeS) && Array.isArray(data.points);
      context.clearRect(0, 0, canvas.width, canvas.height);
      const points = valid ? data.points.filter(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) && point[1] > 0) : [];
      const radius = Math.max(2, Math.min(20, Number.isFinite(data.range_max) ? data.range_max : 10));
      const scale = 170 / radius;
      context.strokeStyle = '#33475e'; context.fillStyle = '#82b8ee';
      for (let ring = 1; ring <= 4; ring++) { context.beginPath(); context.arc(300, 200, ring * 42.5, 0, 2 * Math.PI); context.stroke(); }
      for (const [angle, distance] of points) {
        if (distance > radius) continue;
        const radians = angle * Math.PI / 180;
        context.fillRect(300 - Math.sin(radians) * distance * scale - 2, 200 - Math.cos(radians) * distance * scale - 2, 4, 4);
      }
      const escapePath = valid && Array.isArray(data.escape_path) ? data.escape_path.filter(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)) : [];
      if (escapePath.length) {
        context.beginPath(); context.moveTo(300, 200); context.strokeStyle = '#eab76d';
        for (const [x, y] of escapePath) context.lineTo(300 - y * scale, 200 - x * scale);
        context.stroke();
      }
      get('ugv-escape-status').textContent = escapePath.length ? `脱困路径 · ${escapePath.length} 个车体坐标点` : '脱困路径 · 未上报';
      context.fillStyle = '#eab76d'; context.fillRect(296, 196, 8, 8);
      get('ugv-scan-status').textContent = valid ? `${points.length} 个有效扫描点 · 帧龄 ${scanAgeS.toFixed(2)} s · 显示半径 ${radius} m` : '雷达数据过期/缺失';
    } catch {
      if (get('ugv-scan') === canvas) { scanAgeS = null; context.clearRect(0, 0, canvas.width, canvas.height); get('ugv-scan-status').textContent = '雷达离线'; get('ugv-escape-status').textContent = ''; }
    } finally { scanBusy = false; }
  }

  let liveConnection = null;
  let retryTimer = null;
  let retryAttempt = 0;
  let cameraClockTimer = null;
  const cameraClock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  function updateCameraClock() {
    if (desiredLiveCamera()?.[0] !== 'ov9281.mjpg') return;
    const time = document.querySelector('.uav-panel .feed-bottom span:last-child');
    time.textContent = `当前时间 ${cameraClock.format(new Date())}`;
    time.title = '本机当前时间（Asia/Shanghai），每秒更新；不代表相机帧的采样时间';
  }
  function desiredLiveCamera() {
    const tab = document.querySelector('[data-camera-tab][aria-pressed="true"]')?.dataset.cameraTab;
    return tab === 'uav' && config.carConfigured ? ['a8.mjpg', 'UAV 前视 · 上游图传']
      : tab === 'dock' && config.uavVisionConfigured ? ['ov9281.mjpg', 'OV9281 · 下视预览'] : null;
  }
  function openLiveCamera(live) {
    // An offline vision service can occupy a browser HTTP slot for seconds.
    // Its independent status poll will discover recovery before we open MJPEG.
    if (live[0] === 'ov9281.mjpg' && latestVision.sensor !== 'ov9281') {
      liveConnection = null;
      get('main-camera').removeAttribute('src');
      get('main-camera').style.visibility = 'hidden';
      get('camera-quality').textContent = '机载视觉未连接';
      return;
    }
    const clientId = crypto.randomUUID();
    const url = `/api/v1/devices/UAV-01/cameras/${live[0]}?clientId=${clientId}`;
    liveConnection = { cameraId: live[0], clientId, url, startedAt: Date.now() };
    get('main-camera').src = url;
    get('main-camera').style.visibility = 'visible';
    get('camera-quality').textContent = '连接图传中…';
  }
  function retryLiveCamera(message = '图传中断 · 自动重连') {
    if (!desiredLiveCamera() || retryTimer) return;
    get('main-camera').removeAttribute('src');
    get('main-camera').style.visibility = 'hidden';
    get('camera-quality').textContent = message;
    const expected = liveConnection;
    const delay = Math.min(10000, 1000 * 2 ** Math.min(retryAttempt++, 4));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      const live = desiredLiveCamera();
      if (live && liveConnection === expected) openLiveCamera(live);
    }, delay);
  }
  function applyUavCamera() {
    const live = desiredLiveCamera();
    const camera = get('main-camera');
    if (live) {
      if (!retryTimer && (!liveConnection || liveConnection.cameraId !== live[0] || camera.getAttribute('src') !== liveConnection.url)) {
        clearTimeout(retryTimer); retryTimer = null; retryAttempt = 0;
        openLiveCamera(live);
      }
      camera.alt = live[1];
      get('camera-name').textContent = live[1];
      get('camera-meta').textContent = '上游图传 · 帧时间未校验';
      get('camera-meta').title = '持续监测上游传输状态；设备未提供可核验的图像采样时间戳';
      if (live[0] === 'ov9281.mjpg') {
        updateCameraClock();
        if (cameraClockTimer === null) cameraClockTimer = setInterval(updateCameraClock, 1000);
      }
    } else {
      clearTimeout(retryTimer); retryTimer = null; liveConnection = null; retryAttempt = 0;
      const tab = document.querySelector('[data-camera-tab][aria-pressed="true"]')?.dataset.cameraTab;
      get('camera-name').textContent = tab === 'thermal' ? '热成像 · 演示样本' : '可见光 · 演示样本';
      get('camera-quality').textContent = '未接入';
      if (config.liveOnly) {
        camera.removeAttribute('src');
        camera.alt = '真实图像未接入';
        get('camera-name').textContent = tab === 'thermal' ? '热成像 · 未接入' : '实时图像 · 未接入';
        get('camera-meta').textContent = '无可核验的实时画面';
      }
      if (tab === 'dock') {
        camera.removeAttribute('src');
        camera.alt = '下视未连接';
        get('camera-name').textContent = 'OV9281 · 下视未连接';
        get('camera-meta').textContent = '机载视觉未连接';
      }
    }
    if (live?.[0] !== 'ov9281.mjpg') {
      clearInterval(cameraClockTimer); cameraClockTimer = null;
      const time = document.querySelector('.uav-panel .feed-bottom span:last-child');
      time.textContent = '采样时间未提供';
      time.title = '';
    }
  }
  async function monitorCamera() {
    const connection = liveConnection;
    if (!connection) return;
    try {
      const data = (await AtomoriApi.request('/devices/UAV-01/streams', { timeoutMs: 3000 })).data;
      if (connection !== liveConnection) return;
      const health = data.streamHealth?.find(item => item.clientId === connection.clientId && item.cameraId === connection.cameraId);
      if (health?.active && Number.isFinite(health.idleAgeMs) && health.idleAgeMs < 5000) {
        if (!retryTimer) get('camera-quality').textContent = '上游视频 · 持续接收';
        // 连续稳定十秒后再重置退避，避免故障服务每帧都被重置重试频率。
        if (Date.now() - connection.startedAt > 10000) retryAttempt = 0;
      } else if (health?.closedAt || (Date.now() - connection.startedAt > 10000 && (!health || health.idleAgeMs === null || health.idleAgeMs >= 5000))) {
        retryLiveCamera();
      }
    } catch { if (connection === liveConnection) retryLiveCamera('图传状态不可用 · 自动重连'); }
  }
  if (config.uavVisionConfigured) document.querySelector('[data-camera-tab="dock"]').click();
  applyUavCamera();
  document.querySelectorAll('[data-camera-tab], #restore-camera').forEach(button => button.addEventListener('click', () => {
    clearTimeout(retryTimer); retryTimer = null;
    queueMicrotask(applyUavCamera);
  }));
  get('main-camera').onerror = () => { if (liveConnection) retryLiveCamera('图传不可用 · 自动重连'); };

  get('expand-camera').addEventListener('click', event => {
    const tab = document.querySelector('[data-camera-tab][aria-pressed="true"]')?.dataset.cameraTab;
    const url = tab === 'uav' && config.carConfigured ? '/api/v1/devices/UAV-01/cameras/a8.mjpg'
      : tab === 'dock' && config.uavVisionConfigured ? '/api/v1/devices/UAV-01/cameras/ov9281.mjpg' : null;
    if (!url) {
      if (config.liveOnly) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openDialog('无实时图像', '<p>当前相机未接入真实图传，未显示样本图片。</p>');
      }
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    // Enlarge the monitored feed itself: a second unmonitored MJPEG image could freeze.
    const feed = get('main-camera').closest('.camera-feed');
    if (feed.requestFullscreen) feed.requestFullscreen().catch(() => toast('浏览器未允许图传全屏'));
    else toast('当前浏览器不支持图传全屏');
  }, true);

  renderAttitude();
  if (document.querySelector('.relative-position')) {
    for (const id of ['relative-x', 'relative-y', 'relative-z', 'relative-yaw']) get(id).textContent = '—';
    get('vision-state').textContent = config.uavVisionConfigured ? '坐标未配准' : '机载未连接';
    document.querySelector('.relative-position > p').textContent = config.uavVisionConfigured
      ? '机载 AprilTag 数据已接入；此示意图坐标转换待验证。' : '机载视觉未连接';
    const relativeDiagram = document.querySelector('.relative-content > svg');
    relativeDiagram.setAttribute('aria-label', '机体坐标示意：中心为无人机，圆点为着陆标签；X 向前朝上，Y 向右；一米以内按 27 像素每米显示，超出边界按方向缩放');
    const axes = relativeDiagram.querySelectorAll('text');
    axes[0].textContent = 'y'; axes[1].textContent = 'x';
  }

  async function pollDevice(deviceId, apply, offline, source) {
    try {
      const requestedAt = performance.now();
      const data = (await AtomoriApi.request(`/devices/${deviceId}/telemetry${source ? '?source=' + source : ''}`, { timeoutMs: 5000 })).data;
      if (!stopped) apply(data, requestedAt);
    } catch { if (!stopped) offline(); }
  }

  async function repeat(action, delay) {
    if (stopped) return;
    await action();
    schedule(() => repeat(action, delay), delay);
  }
  applyUgv({});
  // Keep the previous sample's original age through transient HTTP failures.
  if (config.carConfigured) void repeat(() => pollDevice('UGV-01', applyUgv, () => { renderUgv(); renderGroundFreshness(); }), 500);
  if (config.carConfigured) void repeat(async () => {
    if (document.hidden) return;
    const requestedAt = performance.now();
    try { latestUgvDetails = (await AtomoriApi.request('/devices/UGV-01/details', { timeoutMs: 4000 })).data || {}; }
    catch { latestUgvDetails = {}; }
    ugvDetailsReceivedAt = requestedAt;
    renderUgv();
  }, 3000);
  if (flightSource() === 'mission-planner') void repeat(async () => {
    const requestedAt = performance.now();
    try {
      const data = (await AtomoriApi.request('/devices/UAV-01/mission-planner', { timeoutMs: 4000 })).data;
      if (data?.deviceId !== 'UAV-01' || data.source !== 'mission-planner-mavlink' || typeof data.flight?.connected !== 'boolean') throw new Error('飞控遥测来源无效');
      if (!stopped) applyUav(data, requestedAt);
    } catch { if (!stopped) applyUav({ flight: {} }); }
  }, 200);
  else if (flightSource() === 'raspberry-pi') void repeat(() => pollDevice('UAV-01', applyUav, () => applyUav({ flight: {} }), 'flight'), 200);
  if (config.uavVisionConfigured) void repeat(() => pollDevice('UAV-01', applyUav,
    () => applyUav(independentFlight() ? { vision: {} } : { flight: {}, vision: {} }), independentFlight() ? 'vision' : undefined), 500);
  void repeat(async () => { await monitorCamera(); if (!stopped) applyUavCamera(); }, 2000);
  void repeat(refreshScan, 2000);
  if (config.carConfigured) void repeat(refreshMap, 2000);
  if (config.carConfigured) void repeat(refreshGroundCamera, 100);
  const ugvWatchdog = setInterval(() => {
    renderUgv();
    renderUav();
    applyLiveOnlyLabels();
    renderGroundFreshness();
    renderMapFreshness();
    const scan = get('ugv-scan');
    if (scan && get('action-dialog').open && scanAgeS !== null && !fresh(scanAgeS + (performance.now() - scanReceivedAt) / 1000)) {
      scan.getContext('2d').clearRect(0, 0, scan.width, scan.height);
      get('ugv-scan-status').textContent = '雷达数据过期/缺失';
      get('ugv-escape-status').textContent = '';
    }
  }, 250);
  applyUav({ flight: {} });
  window.addEventListener('pagehide', () => {
    stopped = true;
    stopGroundStream();
    for (const timer of pollingTimers) clearTimeout(timer);
    pollingTimers.clear(); clearInterval(ugvWatchdog);
    clearTimeout(retryTimer); retryTimer = null; clearInterval(cameraClockTimer); cameraClockTimer = null; liveConnection = null;
    if (groundObjectUrl) URL.revokeObjectURL(groundObjectUrl);
    if (carMapObjectUrl) URL.revokeObjectURL(carMapObjectUrl);
  });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
})();
