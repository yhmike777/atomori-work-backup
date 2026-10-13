'use strict';

// 只负责只读设备数据与图传；业务记录由 records.js 管理。
(async () => {
  const get = id => document.getElementById(id);
  let latestFlight = {};
  let latestVision = {};
  let visionReceivedAt = 0;
  let latestUgv = {};
  let ugvReceivedAt = 0;
  let stopped = false;
  const pollingTimers = new Set();
  const carMapName = 'map_20260924_224659';
  const carMapSnapshot = '../assets/generated/console/ugv-lidar-map.png';
  let carMapObjectUrl = null, carMapBusy = false;
  const heightNumber = value => Number.isFinite(value) ? value.toFixed(2) + ' m' : '未上报';
  const heightDiagnostic = () => `<p>离地高度：${heightNumber(latestFlight.rangefinderM)}（采用实时下视测距，以传感器为测量基准）。</p><p>下视传感器距离：${heightNumber(latestFlight.rangefinderM)}（传感器到所测表面的距离）。</p><p>飞控 home 高度估计：${heightNumber(latestFlight.relativeAltitudeM)}（基准未核验，不作为离地高度）。</p><p class="dialog-muted">离地高度采用有效的 /landing/sensor_range；尚未补偿传感器安装偏移或机体倾斜。测距无效或过期时显示 —，不使用 home 估计或相机到标签的距离替代。</p>`;
  let config;
  try {
    config = (await AtomoriApi.request('/integrations')).data;
    if(!config || !['demo','upstream-readonly'].includes(config.mode))throw new Error('接入配置无效');
    AtomoriRuntime.config = config;
    setReadOnlyMode(config.mode !== 'demo');
  } catch {
    setReadOnlyMode(true);
    document.querySelector('.demo-state').textContent='配置不可用 · 控制关闭';
    return;
  }
  if (config.mode !== 'upstream-readonly') return;

  document.querySelector('.demo-state').textContent = '上游只读 · 本机业务';
  document.querySelector('.system-footer span:first-child').textContent = '上游只读 · 演示任务 / 本机业务记录 · 设备来源未验证';
  document.querySelector('.spatial-heading h2 span').textContent = '演示地图 · 未与车端地图配准';
  document.querySelector('.running-label').textContent = '演示任务';
  document.querySelector('.map-hint').textContent = '示意图与点位数值为样本';
  document.querySelector('.map-legend span:last-child').textContent = '设备状态以遥测为准';
  document.querySelector('.link-topology').textContent = '通信拓扑未接入';
  document.querySelector('.system-footer span:last-child').textContent = '定位与链路状态以实际接入数据为准';
  get('dock-state').textContent = '补能未接入';
  get('dock-subline').textContent = '落位与充电电气数据未接入';


  const intercept = (element, action) => element?.addEventListener('click', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    action();
  }, true);
  intercept(document.querySelector('[data-nav="devices"]'), () => {
    openDialog('设备数据接入', `<p>车端网关：${config.carConfigured ? '已配置，状态以遥测为准' : '未配置'}</p><div id="ugv-live-details"></div><p>机载视觉服务：${config.uavVisionConfigured ? '已配置，状态以遥测为准' : '未配置'}</p><p>飞控状态桥：${config.uavFlightConfigured ? '已配置，状态以遥测为准' : '使用视觉服务内嵌快照'}</p>${heightDiagnostic()}<p class="dialog-muted">电池、测距未上报或过期时显示 —。控制指令未开放。</p>`);
    renderUgv();
  });
  intercept(get('site-details'), () => openDialog('B 区 · 综合舱', '<p>场站、设施和任务数据目前仍为演示样本。</p><p class="dialog-muted">仅已配置的车端和机载只读接口显示上游数据。</p>'));

  const metric = (panel, number) => document.querySelector(`.${panel}-panel .metric-grid .metric:nth-child(${number}) strong`);
  const display = (value, digits, unit) => Number.isFinite(value) ? `${value.toFixed(digits)} <small>${unit}</small>` : '—';
  const show = (element, value, digits, unit) => { if (element) element.innerHTML = display(value, digits, unit); };
  const fresh = age => Number.isFinite(age) && age >= 0 && age <= 2;
  const explainMetric = (element, item) => {
    if(!element)return;
    element.title = item ? `${item.source} · ${item.unit} · ${item.valid ? '有效上报' : item.reason} · 数据年龄 ${Number.isFinite(item.ageS) ? item.ageS.toFixed(2)+' s' : '未提供'}` : '上游尚未提供此测量字段';
  };

  function applyVideoTiming() {
    const block = document.querySelector('.signal-block');
    const downview = config.uavVisionConfigured && document.querySelector('[data-camera-tab][aria-pressed="true"]')?.dataset.cameraTab === 'dock';
    const age = latestVision.frameAgeMs;
    const valid = downview && latestVision.sensor === 'ov9281' && Number.isFinite(latestVision.captureFps)
      && latestVision.captureFps > 0 && Number.isFinite(age) && fresh(age / 1000);
    block.querySelector('div > span').textContent = downview ? '视觉帧龄' : '图传延迟';
    show(block.querySelector('strong'), valid ? age : null, 0, 'ms');
    block.querySelector('strong').title = downview
      ? '来源：OV9281 /api/status.frame_age_ms；从视觉分析完成到机载查询时的时间，不包含网络传输和浏览器显示耗时；超过 2 秒或无有效采集数据时清空。'
      : '当前相机尚未提供可验证的端到端图传延迟';
    const notes = block.querySelectorAll('p');
    notes[0].textContent = downview ? '下视 · 视觉结果帧龄' : '当前相机延迟未接入';
    notes[1].textContent = '端到端图传延迟未测量';
    block.querySelector('.mini-trend').style.display = 'none';
  }

  function renderRelativePosition() {
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
    const panel = document.querySelector('.relative-position');
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
  }

  function applyUgv(data) {
    latestUgv = data || {};
    ugvReceivedAt = performance.now();
    renderUgv();
  }

  const ugvAge = age => Number.isFinite(age) ? age + (performance.now() - ugvReceivedAt) / 1000 : null;
  const ugvValue = item => item?.valid === true && Number.isFinite(ugvAge(item.ageS)) && ugvAge(item.ageS) <= item.maxAgeS ? item.value : null;
  const positionText = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
    ? `X ${value[0].toFixed(2)} · Y ${value[1].toFixed(2)} m · 航向 ${(value[2] * 180 / Math.PI).toFixed(1)}°` : '位姿 —';
  function renderUgv() {
    const data = latestUgv;
    const speed = ugvValue(data.metrics?.speed);
    const odomFresh = fresh(ugvAge(data.odom?.ageS));
    show(metric('ugv', 1), null, 0, '%'); // 车端网关没有电量百分比字段
    metric('ugv', 1).title = '车端尚未提供电量百分比，不从电压估算';
    show(metric('ugv', 2), speed, 2, 'm/s');
    show(metric('ugv', 3), ugvValue(data.metrics?.temperature), 1, '°C');
    show(metric('ugv', 4), ugvValue(data.metrics?.humidity), 0, '%RH');
    for (const [index, key] of [[2, 'speed'], [3, 'temperature'], [4, 'humidity']]) {
      const item = data.metrics?.[key];
      explainMetric(metric('ugv', index), item ? { ...item, ageS: ugvAge(item.ageS), valid: Number.isFinite(ugvValue(item)), reason: item.valid && !Number.isFinite(ugvValue(item)) ? '页面缓存已过期' : item.reason } : null);
    }
    const muxFresh = fresh(ugvAge(data.topicAgesS?.ugv_control_mux));
    const emergency = muxFresh && data.controlMux?.emergency_stop === true;
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
    document.querySelectorAll('.environment-grid button').forEach((button, index) => {
      if (!config.carConfigured) { button.querySelector('b').textContent = '—'; return; }
      const [key, label] = [['tilt', '倾斜'], ['flame', '火焰'], ['mq2', 'MQ2']][index];
      const sensor = data.environment?.digital?.[key];
      const valid = sensor?.valid === true && fresh(ugvAge(sensor.ageS));
      button.querySelector('span').textContent = label;
      button.querySelector('b').textContent = valid ? sensor.triggered ? '触发' : '未触发' : '—';
      button.querySelector('b').style.color = valid && sensor.triggered ? 'var(--amber)' : '';
      button.title = '数字传感器开关量，不代表气体浓度；过期或未上报显示 —';
    });
    const details = get('ugv-live-details');
    if (details) {
      const sensorText = (key, unit) => { const value = ugvValue(data.metrics?.[key]); return Number.isFinite(value) ? value.toFixed(2) + ' ' + unit : '—'; };
      const authority = muxFresh ? ({ navigation: '自主导航', operator: '操作端', none: '无' }[data.controlMux?.authority] || escapeText(data.controlMux?.authority || '未知')) : '—';
      const leadscrew = fresh(ugvAge(data.leadscrew?.age_s)) ? data.leadscrew?.status : null;
      details.innerHTML = `<p>车辆状态：${escapeText(get('rover-state').textContent)} · ${escapeText(time)}</p><p>里程计：${escapeText(positionText(odomFresh ? data.odom?.pose : null))}</p><p>地图定位：${escapeText(positionText(localized ? data.localization.map_pose : null))} · ${localized ? escapeText(data.localization.confidence || '未知') : '不可用'}</p><p>环境温湿度：${sensorText('temperature', '°C')} / ${sensorText('humidity', '%RH')} · ${escapeText(data.environment?.error || '')}</p><p>超声测距：${sensorText('ultrasonic', 'm')} · 控制权：${authority}</p><p>推杆：${leadscrew ? escapeText(JSON.stringify(leadscrew)) : '—'}</p><p>电池电压：${Number.isFinite(data.batteryVoltage) ? '上游未提供样本年龄，暂不显示' : '未上报'}</p><p class="dialog-muted">车辆坐标来自车端，未映射到示意地图。MQ2 仅为数字触发信号；O₂、CO、H₂S 浓度未接入。</p>`;
    }
  }

  function applyUav(data) {
    const flight = data.flight || {};
    latestFlight = flight;
    latestVision = data.vision || {};
    visionReceivedAt = performance.now();
    renderRelativePosition();
    applyVideoTiming();
    const valid = flight.connected && fresh(flight.stateAgeS);
    const roll = valid && flight.metrics?.roll?.valid === true ? flight.rollDeg : null;
    const pitch = valid && flight.metrics?.pitch?.valid === true ? flight.pitchDeg : null;
    const attitudeValid = Number.isFinite(roll) && Number.isFinite(pitch);
    const attitudeBlock = document.querySelector('.attitude-block');
    attitudeBlock.querySelector('span').innerHTML = `横滚 <b>${Number.isFinite(roll) ? roll.toFixed(1) + '°' : '—'}</b>　俯仰 <b>${Number.isFinite(pitch) ? pitch.toFixed(1) + '°' : '—'}</b>`;
    const angles = attitudeBlock.querySelectorAll('b');
    explainMetric(angles[0], flight.metrics?.roll);
    explainMetric(angles[1], flight.metrics?.pitch);
    const horizon = attitudeBlock.querySelector('.attitude-horizon');
    horizon.style.visibility = attitudeValid ? 'visible' : 'hidden';
    horizon.setAttribute('transform', attitudeValid ? `rotate(${-roll} 70 47) translate(0 ${pitch * 0.7})` : '');
    attitudeBlock.querySelector('svg').setAttribute('aria-label', attitudeValid ? `无人机姿态：横滚 ${roll.toFixed(1)} 度，俯仰 ${pitch.toFixed(1)} 度` : '无人机姿态数据不可用');
    attitudeBlock.title = '飞控融合姿态；横滚正值为向右倾斜，俯仰正值为抬头；姿态样本超过 0.5 秒或飞控断连时清空。';
    show(metric('uav', 1), valid ? flight.batteryPercent : null, 0, '%');
    show(get('uav-voltage'), valid ? flight.batteryVoltage : null, 2, 'V');
    show(get('range-value'), valid ? flight.rangefinderM : null, 2, 'm');
    for(const [element,key] of [[metric('uav',1),'batteryPercent'],[get('uav-voltage'),'batteryVoltage'],[get('range-value'),'rangefinder']])explainMetric(element,flight.metrics?.[key]);
    const height = get('uav-height');
    height.parentElement.querySelector('span').textContent='离地高度';
    show(height, valid ? flight.rangefinderM : null, 2, 'm');
    explainMetric(height, flight.metrics?.rangefinder);
    height.title += ' · 实时下视测距，以传感器为基准；未补偿安装偏移与机体倾斜';
    get('drone-state').textContent = !config.uavVisionConfigured && !config.uavFlightConfigured ? '机载未连接' : valid ? `${flight.mode} · ${flight.armed ? '已解锁' : '未解锁'}` : '飞控离线/过期';
    document.querySelector('.uav-panel .telemetry-heading small').textContent = valid ? '飞控数据' : '数据过期';
  }

  function schedule(action, delay) {
    if (stopped) return;
    const timer = setTimeout(() => { pollingTimers.delete(timer); if (!stopped) void action(); }, delay);
    pollingTimers.add(timer);
  }

  function openUgvDetails() {
    openDialog('无人车 · 实时遥测', '<div id="ugv-live-details"></div>');
    renderUgv();
  }

  let groundCameraId = 'front', groundObjectUrl = null, groundFrameAt = 0;
  const groundNames = { front: '前视', rear: '后视' };
  const groundCamera = get('ground-camera');
  groundCamera.removeAttribute('src');
  groundCamera.style.visibility = 'hidden';
  document.querySelector('.ground-feed .feed-quality').textContent = config.carConfigured ? '等待车端画面' : '车端未配置';
  document.querySelector('.ground-feed .feed-bottom').textContent = '车端相机 · 帧时间戳未提供';
  document.querySelector('.ground-feed .feed-label').textContent = '车端相机 · 暂无画面';
  async function refreshGroundCamera() {
    const selected = groundCameraId;
    const label = document.querySelector('.ground-feed .feed-label');
    const status = selected === 'front' ? latestUgv.camera : latestUgv.cameraRear;
    try {
      if (status?.ready === false) throw new Error('暂无有效相机帧');
      const response = await fetch(`/api/v1/devices/UGV-01/cameras/${selected}.jpg?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) throw new Error('图像不可用');
      const blob = await response.blob();
      if (stopped || selected !== groundCameraId) return;
      if (groundObjectUrl) URL.revokeObjectURL(groundObjectUrl);
      groundObjectUrl = URL.createObjectURL(blob);
      groundCamera.src = groundObjectUrl;
      groundCamera.alt = `车端${groundNames[selected]}当前画面`;
      groundCamera.style.visibility = 'visible';
      groundFrameAt = performance.now();
      label.textContent = `车端${groundNames[selected]} · 上游画面`;
      document.querySelector('.ground-feed .feed-quality').textContent = '单帧刷新';
      if (get('ugv-expanded-camera')) get('ugv-expanded-camera').src = groundObjectUrl;
    } catch {
      if (!stopped && selected === groundCameraId) {
        groundCamera.style.visibility = 'hidden';
        get('ugv-expanded-camera')?.removeAttribute('src');
        label.textContent = `车端${groundNames[selected]} · 图像不可用`;
        document.querySelector('.ground-feed .feed-quality').textContent = '等待有效帧';
      }
    } finally { schedule(refreshGroundCamera, 1000); }
  }
  groundCamera.onerror = () => { groundCamera.style.visibility = 'hidden'; document.querySelector('.ground-feed .feed-quality').textContent = '图像解码失败'; };
  if (config.carConfigured) {
    const feed = document.querySelector('.ground-feed');
    const mapLayer = document.createElement('div');
    mapLayer.className = 'ground-map-layer';
    mapLayer.innerHTML = '<img id="car-map-image" alt="车端激光雷达已保存地图"><div class="feed-top"><span class="feed-label">车端地图 · 激光雷达</span><span class="feed-quality">已保存地图</span></div><div class="feed-bottom"><span id="car-map-status">缓存地图 · 正在同步…</span><span>0.05 m/格</span></div>';
    mapLayer.title = carMapName + ' · 黑色障碍物，白色空闲，灰色未知';
    get('ground-camera').parentElement.append(mapLayer);
    get('car-map-image').src = carMapSnapshot;
    const tabs = document.createElement('div');
    tabs.className = 'camera-tabs';
    const cameraButton = get('ground-view');
    cameraButton.before(tabs);
    tabs.append(cameraButton);
    const mapButton = document.createElement('button');
    mapButton.id = 'ground-map-view';
    mapButton.textContent = '车端地图';
    tabs.append(mapButton);
    const setGroundMode = map => {
      feed.classList.toggle('show-car-map', map);
      mapButton.setAttribute('aria-pressed', String(map));
      cameraButton.setAttribute('aria-pressed', String(!map));
      cameraButton.textContent = map ? '地面图传' : `切换${groundCameraId === 'front' ? '后视' : '前视'}`;
      get('expand-ground').setAttribute('aria-label', map ? '放大车端地图' : '放大无人车图传');
    };
    mapButton.onclick = () => { setGroundMode(true); void refreshMap(); };
    setGroundMode(true);
    const detailButton = document.createElement('button');
    detailButton.textContent = '车辆详情 ↗';
    detailButton.onclick = openUgvDetails;
    document.querySelector('.ugv-panel .telemetry-heading').append(detailButton);
    document.querySelectorAll('.environment-grid button').forEach(button => intercept(button, openUgvDetails));
    intercept(get('ground-view'), () => {
      if (feed.classList.contains('show-car-map')) { setGroundMode(false); return; }
      groundCameraId = groundCameraId === 'front' ? 'rear' : 'front';
      groundCamera.style.visibility = 'hidden';
      get('ground-view').textContent = `切换${groundCameraId === 'front' ? '后视' : '前视'}`;
      document.querySelector('.ground-feed .feed-label').textContent = `车端${groundNames[groundCameraId]} · 等待画面`;
    });
    intercept(get('expand-ground'), () => {
      if (feed.classList.contains('show-car-map')) {
        openDialog('车端地图 · ' + carMapName, '<img id="ugv-map-image" alt="小车激光雷达已保存地图"><p id="ugv-map-status"></p>');
        get('ugv-map-image').src = carMapObjectUrl || carMapSnapshot;
        get('ugv-map-status').textContent = get('car-map-status').textContent;
        void refreshMap();
        return;
      }
      openDialog(`UGV ${groundNames[groundCameraId]} · 实时画面`, '<img id="ugv-expanded-camera" alt="车端当前帧"><p class="dialog-muted">相机无有效帧时清空画面。</p>');
      if (groundObjectUrl && groundCamera.style.visibility === 'visible') get('ugv-expanded-camera').src = groundObjectUrl;
    });
    const scanButton = document.querySelector('.ugv-panel [data-business="mapping"]');
    scanButton.textContent = '实时雷达 ↗';
    intercept(scanButton, () => {
      openDialog('无人车 · 实时雷达', '<canvas id="ugv-scan" width="600" height="400" aria-label="车端二维激光雷达扫描"></canvas><p id="ugv-scan-status">等待雷达数据…</p><p class="dialog-muted">车体坐标的二维激光扫描；前方朝上，左侧朝左。</p>');
      void refreshScan();
    });
    void refreshGroundCamera();
  }

  let scanBusy = false;
  async function refreshMap() {
    const image = get('car-map-image');
    if (!image || carMapBusy || stopped) return;
    carMapBusy = true;
    let candidateUrl = null;
    try {
      const response = await fetch(`/api/v1/maps/${carMapName}.png?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) throw new Error('地图不可用');
      candidateUrl = URL.createObjectURL(await response.blob());
      const decoded = new Image(); decoded.src = candidateUrl;
      await decoded.decode();
      if (stopped) return;
      const previousUrl = carMapObjectUrl;
      carMapObjectUrl = candidateUrl; candidateUrl = null;
      image.src = carMapObjectUrl;
      if (get('ugv-map-image')) get('ugv-map-image').src = carMapObjectUrl;
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      get('car-map-status').textContent = `车端已保存地图 · 同步 ${new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`;
    } catch {
      if (!stopped) get('car-map-status').textContent = '车端地图不可用 · 显示已缓存地图';
    } finally {
      if (candidateUrl) URL.revokeObjectURL(candidateUrl);
      if (get('ugv-map-status')) get('ugv-map-status').textContent = get('car-map-status').textContent;
      carMapBusy = false;
    }
  }
  async function refreshScan() {
    const canvas = get('ugv-scan');
    if (scanBusy || !canvas || !get('action-dialog').open || stopped) return;
    scanBusy = true;
    const context = canvas.getContext('2d');
    try {
      const data = (await AtomoriApi.request('/devices/UGV-01/scan', { timeoutMs: 3000 })).data;
      if (get('ugv-scan') !== canvas || stopped) return;
      const valid = fresh(data?.age_s) && Array.isArray(data.points);
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
      context.fillStyle = '#eab76d'; context.fillRect(296, 196, 8, 8);
      get('ugv-scan-status').textContent = valid ? `${points.length} 个有效扫描点 · 帧龄 ${data.age_s.toFixed(2)} s · 显示半径 ${radius} m` : '雷达数据过期/缺失';
    } catch {
      if (get('ugv-scan') === canvas) { context.clearRect(0, 0, canvas.width, canvas.height); get('ugv-scan-status').textContent = '雷达离线'; }
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
    const clientId = crypto.randomUUID();
    const url = `/api/v1/devices/UAV-01/cameras/${live[0]}?clientId=${clientId}`;
    liveConnection = { cameraId: live[0], clientId, url, startedAt: Date.now() };
    get('main-camera').src = url;
    get('camera-quality').textContent = '连接图传中…';
  }
  function retryLiveCamera(message = '图传中断 · 自动重连') {
    if (!desiredLiveCamera() || retryTimer) return;
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
      if (!liveConnection || liveConnection.cameraId !== live[0] || camera.getAttribute('src') !== liveConnection.url) {
        clearTimeout(retryTimer); retryTimer = null; retryAttempt = 0;
        openLiveCamera(live);
      }
      camera.alt = live[1];
      get('camera-name').textContent = live[1];
      get('camera-meta').textContent = '只读图传 · 接收状态监测 · 未校验帧时间戳';
      if (live[0] === 'ov9281.mjpg') {
        updateCameraClock();
        if (cameraClockTimer === null) cameraClockTimer = setInterval(updateCameraClock, 1000);
      }
    } else {
      clearTimeout(retryTimer); retryTimer = null; liveConnection = null; retryAttempt = 0;
      const tab = document.querySelector('[data-camera-tab][aria-pressed="true"]')?.dataset.cameraTab;
      get('camera-name').textContent = tab === 'thermal' ? '热成像 · 演示样本' : '可见光 · 演示样本';
      get('camera-quality').textContent = '未接入';
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
    applyVideoTiming();
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
  document.querySelectorAll('[data-camera-tab], #restore-camera').forEach(button => button.addEventListener('click', () => queueMicrotask(applyUavCamera)));
  get('main-camera').onerror = () => { if (liveConnection) retryLiveCamera('图传不可用 · 自动重连'); };

  get('expand-camera').addEventListener('click', event => {
    const tab = document.querySelector('[data-camera-tab][aria-pressed="true"]')?.dataset.cameraTab;
    const url = tab === 'uav' && config.carConfigured ? '/api/v1/devices/UAV-01/cameras/a8.mjpg'
      : tab === 'dock' && config.uavVisionConfigured ? '/api/v1/devices/UAV-01/cameras/ov9281.mjpg' : null;
    if (!url) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openDialog('UAV 上游图传', `<img src="${url}" alt="无人机上游图传"><p class="dialog-muted">只读图传；画面来源和设备状态须现场核验。</p>`);
  }, true);

  for (const id of ['relative-x', 'relative-y', 'relative-z', 'relative-yaw']) get(id).textContent = '—';
  get('vision-state').textContent = config.uavVisionConfigured ? '坐标未配准' : '机载未连接';
  document.querySelector('.relative-position > p').textContent = config.uavVisionConfigured
    ? '机载 AprilTag 数据已接入；此示意图坐标转换待验证。' : '机载视觉未连接';
  document.querySelector('.attitude-block span').textContent = '横滚 —　俯仰 —';
  const relativeDiagram = document.querySelector('.relative-content svg');
  relativeDiagram.setAttribute('aria-label', '机体坐标示意：中心为无人机，圆点为着陆标签；X 向前朝上，Y 向右；一米以内按 27 像素每米显示，超出边界按方向缩放');
  const axes = relativeDiagram.querySelectorAll('text');
  axes[0].textContent = 'y'; axes[1].textContent = 'x';

  async function pollDevice(deviceId, apply, offline) {
    try {
      const data = (await AtomoriApi.request(`/devices/${deviceId}/telemetry`, { timeoutMs: 5000 })).data;
      if (!stopped) apply(data);
    } catch { if (!stopped) offline(); }
  }

  async function repeat(action, delay) {
    if (stopped) return;
    await action();
    schedule(() => repeat(action, delay), delay);
  }
  applyUgv({});
  if (config.carConfigured) void repeat(() => pollDevice('UGV-01', applyUgv, () => applyUgv({})), 1000);
  if (config.uavVisionConfigured || config.uavFlightConfigured) void repeat(() => pollDevice('UAV-01', applyUav, () => applyUav({ flight: {} })), 1000);
  void repeat(async () => { await monitorCamera(); if (!stopped) applyUavCamera(); }, 2000);
  void repeat(refreshScan, 2000);
  if (config.carConfigured) void repeat(refreshMap, 10000);
  const ugvWatchdog = setInterval(() => {
    renderUgv();
    renderRelativePosition();
    if (performance.now() - groundFrameAt > 3000) {
      groundCamera.style.visibility = 'hidden';
      get('ugv-expanded-camera')?.removeAttribute('src');
    }
  }, 250);
  applyUav({ flight: {} });
  window.addEventListener('pagehide', () => {
    stopped = true;
    for (const timer of pollingTimers) clearTimeout(timer);
    pollingTimers.clear(); clearInterval(ugvWatchdog);
    clearTimeout(retryTimer); retryTimer = null; clearInterval(cameraClockTimer); cameraClockTimer = null; liveConnection = null;
    if (groundObjectUrl) URL.revokeObjectURL(groundObjectUrl);
    if (carMapObjectUrl) URL.revokeObjectURL(carMapObjectUrl);
  });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
})();
