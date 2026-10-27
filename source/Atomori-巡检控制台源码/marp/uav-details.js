'use strict';

(() => {
  const get = id => document.getElementById(id);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const fields = [
    ['roll', '横滚', '°', 1], ['pitch', '俯仰', '°', 1], ['heading', '航向', '°', 1],
    ['batteryPercent', '电池电量', '%', 0], ['batteryVoltage', '电池电压', 'V', 2],
    ['rangefinder', '下视测距', 'm', 2], ['relativeAltitude', '相对 home 高度', 'm', 2],
    ['localAltitude', '局部 ENU 高度', 'm', 2], ['altitudeMsl', '海拔高度（MSL）', 'm', 2],
    ['verticalSpeed', '升降速度（向上为正）', 'm/s', 2],
    ['throttle', '飞控油门输出', '%', 1], ['rc3', '遥控器通道 3', 'µs', 0],
    ['airspeed', '空速', 'm/s', 2], ['groundspeed', '地速', 'm/s', 2], ['batteryCurrent', '电池电流', 'A', 2],
    ['latitude', '纬度', '°', 7], ['longitude', '经度', '°', 7], ['satellites', 'GPS 卫星数', '', 0], ['hdop', 'GPS HDOP', '', 2], ['gpsFix', 'GPS 定位等级', '', 0],
    ['vibrationX', 'X 轴振动', 'm/s²', 2], ['vibrationY', 'Y 轴振动', 'm/s²', 2], ['vibrationZ', 'Z 轴振动', 'm/s²', 2], ['ekfFlags', 'EKF 状态标志', '', 0], ['cpuLoad', '飞控负载', '%', 1]
  ];
  const primary = ['batteryPercent', 'batteryVoltage', 'batteryCurrent', 'relativeAltitude', 'groundspeed', 'airspeed'];
  let snapshot = null, config = null, receivedAt = 0, lastResponse = null, errorMessage = '', busy = false, stopped = false, pollTimer, renderTimer;
  const flightSource = () => Object.hasOwn(config || {}, 'uavFlightSource')
    ? ['mission-planner', 'raspberry-pi'].includes(config.uavFlightSource) ? config.uavFlightSource : null
    : config?.liveOnly === true && config.uavFlightConfigured === true ? 'raspberry-pi' : config?.missionPlannerConfigured ? 'mission-planner' : null;
  const fromRpi = () => flightSource() === 'raspberry-pi';
  const elapsed = () => snapshot ? Math.max(0, (performance.now() - receivedAt) / 1000) : 0;
  const age = value => finite(value) && value >= 0 ? value + elapsed() : null;
  const stateFresh = () => snapshot?.flight?.connected === true && finite(age(snapshot.flight.stateAgeS)) && age(snapshot.flight.stateAgeS) <= 2;
  const reasonText = reason => ({ GPS_NO_FIX: 'GPS 未定位', FLIGHT_CONTROLLER_DISCONNECTED: '飞控断连 / 过期', NO_VALID_SAMPLE: '未收到有效样本', STALE_OR_INVALID: '数据过期 / 无效', METADATA_NOT_REPORTED: '缺少有效性信息', UNAVAILABLE_OR_STALE: '不可用 / 坐标系未确认', STALE_OR_UNKNOWN_AGE: '数据过期 / 年龄未知' }[reason] || '未上报');
  function metric(key) {
    const item = snapshot?.flight?.metrics?.[key];
    const ageS = age(item?.ageS);
    const valid = stateFresh() && item?.valid === true && finite(item.value) && finite(ageS) && finite(item.maxAgeS) && ageS <= item.maxAgeS;
    return { value: valid ? item.value : null, ageS, source: item?.source || '未收到该 MAVLink 消息', valid,
      reason: valid ? '实时有效' : !snapshot ? errorMessage ? '服务不可用' : '等待数据' : !fromRpi() && !snapshot.transport?.acceptedMessages ? '等待转发' : !stateFresh() ? '飞控断连 / 过期' : item?.valid ? '页面缓存已过期' : reasonText(item?.reason) };
  }
  function render() {
    const fresh = stateFresh(), flight = snapshot?.flight || {}, details = flight.details || {};
    const banner = get('flight-banner');
    banner.textContent = errorMessage ? `Mission Planner 遥测不可用：${errorMessage}；正在自动重试。` : !config ? '正在连接 Mission Planner 接收服务…' : !snapshot ? '正在读取 Mission Planner 转发数据…' : fresh ? 'Mission Planner MAVLink 转发已接收 · 正在显示飞控数据。' : snapshot.transport?.acceptedMessages ? 'Mission Planner 转发已中断或飞控心跳过期，数值已清空。' : '接收服务已就绪 · 等待另一台电脑转发 Mission Planner MAVLink 数据。';
    if (fromRpi()) {
      document.title = 'UAV-01 树莓派实时遥测 · Atomori';
      document.querySelector('.eyebrow').textContent = 'UAV-01 / RASPBERRY PI';
      document.querySelector('.subtitle').textContent = '机载 HTTP 只读遥测 · 有效数据与来源';
      document.querySelector('.connection-card h2').textContent = '树莓派遥测链路';
      get('connection-note').textContent = '直接读取已配置的机载只读遥测桥。缺失或过期数据不显示；未发送解锁、起飞或参数修改命令。';
      get('attitude-empty').textContent = '未收到有效姿态数据';
      document.querySelector('.telemetry-card .card-note').textContent = '高度与测距采用不同基准。样本年龄来自机载桥接收计时，并累计页面等待时间，不代表端到端延迟。';
      const columns = document.querySelectorAll('.telemetry-table thead th');
      columns[3].textContent = '样本年龄（桥接收）';
      columns[4].textContent = 'ROS 数据来源';
      get('mirror-source').parentElement.querySelector('dt').textContent = '当前遥测来源';
      get('mirror-count').parentElement.querySelector('dt').textContent = '消息计数（未提供）';
      banner.textContent = errorMessage ? `树莓派遥测不可用：${errorMessage}；正在自动重试。` : fresh ? '已接收树莓派只读遥测 · 仅显示有效上报。' : '树莓派遥测未返回有效飞控心跳，过期数值已清空。';
    }
    banner.classList.toggle('is-connected', fresh);
    get('connection-badge').textContent = fresh ? '飞控在线' : fromRpi() ? '飞控离线/过期' : snapshot?.transport?.acceptedMessages ? '心跳已过期' : '等待转发';
    get('connection-badge').classList.toggle('is-connected', fresh);
    const systemStates = { 0: '未初始化', 1: '启动中', 2: '校准中', 3: '待机', 4: '运行中', 5: '严重异常', 6: '紧急状态', 7: '关机中', 8: '飞行终止' };
    const gpsFix = metric('gpsFix'), satellites = metric('satellites');
    const rows = [
      ['飞行模式', fresh ? flight.mode || '未知' : '—'], ['解锁状态', fresh ? flight.armed === true ? '已解锁' : '未解锁' : '未知'],
      ['落地状态', fresh && finite(age(flight.landedStateAgeS)) && age(flight.landedStateAgeS) <= 2 ? ({ ON_GROUND: '在地面', IN_AIR: '在空中', TAKEOFF: '起飞中', LANDING: '降落中' }[flight.landedState] || '未知') : '未知'],
      ['系统状态', fresh ? systemStates[details.systemStatus] || '未上报' : '—'],
      ['GPS 定位', gpsFix.valid ? ({ 0: '无 GPS', 1: '未定位', 2: '2D 定位', 3: '3D 定位', 4: 'DGPS', 5: 'RTK 浮点', 6: 'RTK 固定', 7: '静态', 8: 'PPP' }[gpsFix.value] || '未知') + (satellites.valid ? ` · ${satellites.value} 颗卫星` : '') : '未收到有效状态'],
      ['心跳接收年龄', finite(age(flight.stateAgeS)) ? `${age(flight.stateAgeS).toFixed(2)} s` : '—']
    ];
    get('flight-state').innerHTML = rows.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('');
    get('primary-metrics').innerHTML = primary.map(key => {
      const [, label, unit, digits] = fields.find(field => field[0] === key), item = metric(key);
      return `<div class="primary-metric"><span>${label}</span><strong>${item.valid ? item.value.toFixed(digits) + `<small>${unit}</small>` : '—'}</strong><p>${escape(item.reason)}</p></div>`;
    }).join('');
    get('telemetry-rows').innerHTML = fields.map(([key, label, unit, digits]) => {
      const item = metric(key);
      const fieldLabel = key === 'rangefinder' && !fromRpi() ? '测距（方向未确认）' : label;
      return `<tr><td>${fieldLabel}</td><td>${item.valid ? item.value.toFixed(digits) + ' ' + unit : '—'}</td><td class="${item.valid ? 'value-valid' : 'value-missing'}">${escape(item.reason)}</td><td>${finite(item.ageS) ? item.ageS.toFixed(2) + ' s' : '—'}</td><td>${escape(item.source)}</td></tr>`;
    }).join('');
    const roll = metric('roll'), pitch = metric('pitch'), attitudeValid = roll.valid && pitch.valid;
    get('roll-value').textContent = roll.valid ? roll.value.toFixed(1) + '°' : '—';
    get('pitch-value').textContent = pitch.valid ? pitch.value.toFixed(1) + '°' : '—';
    const heading = metric('heading');
    get('heading-value').textContent = heading.valid ? heading.value.toFixed(1) + '°' : '—';
    const hudValue = (key, unit, digits = 1) => { const item = metric(key); return item.valid ? item.value.toFixed(digits) + unit : '—' + unit; };
    get('hud-airspeed').textContent = hudValue('airspeed', ' m/s');
    get('hud-altitude').textContent = hudValue('relativeAltitude', ' m');
    get('hud-groundspeed').textContent = '地速 ' + hudValue('groundspeed', ' m/s');
    get('hud-voltage').textContent = '电池 ' + hudValue('batteryVoltage', ' V') + ' / ' + hudValue('batteryCurrent', ' A');
    get('hud-armed').textContent = fresh ? flight.armed === true ? '已解锁' : '已锁定' : '状态未知';
    get('hud-armed').setAttribute('fill', fresh ? flight.armed === true ? '#f5b174' : '#c9e7d8' : '#c8d5e1');
    get('hud-mode').textContent = fresh ? flight.mode || '未知模式' : '—';
    get('flight-horizon').setAttribute('visibility', attitudeValid ? 'visible' : 'hidden');
    get('flight-horizon').setAttribute('transform', attitudeValid ? `rotate(${-roll.value} 320 180) translate(0 ${pitch.value * 3.5})` : '');
    get('attitude-empty').setAttribute('visibility', attitudeValid ? 'hidden' : 'visible');
    get('attitude-status').textContent = attitudeValid ? '姿态有效' : '无有效姿态';
    get('flight-attitude').setAttribute('aria-label', attitudeValid ? `横滚 ${roll.value.toFixed(1)} 度，俯仰 ${pitch.value.toFixed(1)} 度` : '姿态数据不可用');
    const healthFresh = fresh && finite(age(details.healthAgeS)) && age(details.healthAgeS) <= 3;
    const health = Array.isArray(details.health) ? details.health : [];
    get('flight-health').innerHTML = (health.length ? health : ['陀螺仪', '加速度计', '磁力计', '气压计', 'GPS', '预解锁检查'].map(label => ({ label, state: '未上报' }))).map(item => `<div><dt>${escape(item.label)}</dt><dd>${escape(healthFresh ? item.state : '未上报 / 已过期')}</dd></div>`).join('');
    const alerts = fresh && Array.isArray(details.alerts) ? details.alerts.filter(item => finite(age(item.ageS)) && age(item.ageS) <= 30) : [];
    get('flight-alerts').innerHTML = alerts.length ? alerts.slice().reverse().map(item => `<p><span>${age(item.ageS).toFixed(1)} s 前 · 等级 ${escape(item.severity)}</span>${escape(item.text)}</p>`).join('') : '最近 30 秒没有收到有效状态消息';
    get('mirror-source').textContent = snapshot?.transport?.peerIp ? `${snapshot.transport.peerIp} · SYS ${snapshot.transport.systemId} / COMP ${snapshot.transport.componentId}` : '尚未收到转发';
    get('mirror-count').textContent = String(snapshot?.transport?.acceptedMessages ?? 0);
    if (fromRpi()) {
      get('mirror-source').textContent = snapshot?.source === 'uav-rpi-deploy' ? '机载 flight-status-http' : '等待机载遥测';
      get('mirror-count').textContent = '—';
    }
    get('last-response').textContent = lastResponse ? lastResponse.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（本机接收）' : '—';
    get('poll-status').textContent = document.hidden ? '页面隐藏 · 暂停请求' : busy ? '读取中' : errorMessage ? '自动重试中' : '自动刷新';
  }
  async function poll() {
    if (stopped || busy || document.hidden) return;
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
      if (fromRpi()) result.data.flight.metrics = { ...result.data.flight.metrics, ...result.data.flight.details?.metrics };
      snapshot = result.data;
      const adapterElapsed = snapshot.ageIncludes === 'device-http-and-response-wait' && finite(snapshot.snapshotAgeS) && snapshot.snapshotAgeS >= 0 ? snapshot.snapshotAgeS * 1000 : 0;
      receivedAt = Math.min(performance.now(), requestedAt + adapterElapsed);
      lastResponse = new Date(); errorMessage = '';
      get('raw-flight').textContent = JSON.stringify(snapshot, null, 2);
    } catch (error) {
      snapshot = null; errorMessage = AtomoriApi.message(error);
      get('raw-flight').textContent = '本次未获取到有效数据：' + errorMessage;
    } finally {
      busy = false; get('refresh-flight').disabled = false; render();
      if (!stopped && !document.hidden) pollTimer = setTimeout(poll, errorMessage ? 3000 : 200);
    }
  }
  function start() { stopped = false; clearInterval(renderTimer); renderTimer = setInterval(render, 200); poll(); }
  get('refresh-flight').addEventListener('click', poll);
  document.addEventListener('visibilitychange', () => { clearTimeout(pollTimer); if (!document.hidden) poll(); render(); });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(pollTimer); clearInterval(renderTimer); });
  window.addEventListener('pageshow', event => { if (event.persisted) start(); });
  render(); start();
})();
