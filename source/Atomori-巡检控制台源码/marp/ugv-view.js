'use strict';

// 沿用控制台弹窗。快照状态、传感器年龄、推杆估算与物理反馈分别显示。
window.AtomoriUgvView = (() => {
  const safe = value => String(value ?? '—').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const numeric = (value, unit = '', digits = 2) => Number.isFinite(value) ? `${value.toFixed(digits)}${unit ? ' ' + unit : ''}` : '—';
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
  // Display continuity only: retained readings never drive motion or online state.
  function createMetricDisplay() {
    const samples = new Map();
    let uptime = null, receivedAt = null;
    return (data, key, elapsed, nowMs) => {
      if (!snapshotFresh(data, elapsed)) {
        samples.clear();
        return { value: null, retained: false, ageS: null };
      }
      if (data.receivedAt !== receivedAt) {
        const nextUptime = data.gateway?.uptime_s;
        if (Number.isFinite(nextUptime) && Number.isFinite(uptime) && nextUptime < uptime) samples.clear();
        uptime = nextUptime;
        receivedAt = data.receivedAt;
      }
      const item = data.metrics?.[key];
      const value = metric(data, key, elapsed);
      if (Number.isFinite(value)) {
        const ageS = item.ageS + elapsed;
        samples.set(key, { value, sampledAt: nowMs - ageS * 1000 });
        return { value, ageS, retained: false };
      }
      const previous = samples.get(key);
      const ageS = previous ? (nowMs - previous.sampledAt) / 1000 : null;
      const limit = key === 'speed' ? 5 : 60;
      if (ageS !== null && ageS >= 0 && ageS <= limit) return { value: previous.value, ageS, retained: true };
      samples.delete(key);
      return { value: null, retained: false, ageS };
    };
  }
  const soundState = (data, elapsed) => {
    const sensor = data.environment?.digital?.sound;
    const available = snapshotFresh(data, elapsed) && sensor?.available === true && fresh(sensor.ageS, elapsed);
    const abnormal = available && sensor.valid === true && sensor.triggered === true;
    const defaulted = available && sensor.valid !== true;
    return { text: available ? abnormal ? '异常' : defaulted ? '待判定' : '正常' : '—',
      color: available ? abnormal ? 'var(--red)' : defaulted ? 'var(--amber)' : 'var(--green)' : 'var(--muted)',
      title: !available ? '声音传感器未连接或数据过期'
        : defaulted ? '声音传感器在线，但尚未配置触发判定；没有有效报警结论，未上报分贝值'
        : `声音传感器${abnormal ? '已触发' : '未触发'}；数字触发状态，不代表分贝测量` };
  };
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
  const ageText = (age, elapsed) => numeric(Number.isFinite(age) && age >= 0 ? age + elapsed : null, 's', 1);
  const label = (value, labels) => labels[value] || value || '—';
  const authorityLabels = { navigation: '自主导航', operator: '操作端', operator_teleop: '操作端遥控', operator_nav2: '操作端导航', operator_steering: '巡航转向辅助', none: '无控制权' };
  const stateLabels = ['外侧保持', '向内运动', '内侧保持', '向外运动', '中途保持'];
  const locationLabels = { inactive: '未启动', starting: '启动中', waiting_for_amcl: '等待定位节点', globalizing: '全局定位中', localized: '已定位', error: '定位错误' };
  const rows = values => `<div class="business-list">${values.map(([key, value]) => `<div><span>${safe(key)}</span><b>${safe(value)}</b></div>`).join('')}</div>`;
  const table = (headers, values) => `<table><thead><tr>${headers.map(item => `<th>${safe(item)}</th>`).join('')}</tr></thead><tbody>${values.map(row => `<tr>${row.map(item => `<td>${safe(item)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const group = (id, title, content, open = false) => `<details class="ugv-detail-group" data-group="${id}"${open ? ' open' : ''}><summary>${title}</summary>${content}</details>`;
  const mapInfo = info => rows([
    ['地图尺寸', Number.isFinite(info?.width) && Number.isFinite(info?.height) ? `${info.width} × ${info.height} 格` : '—'],
    ['栅格分辨率', numeric(info?.resolution, 'm/格', 4)], ['地图原点', pose(info?.origin)]
  ]);

  function mechanismState(data, details, elapsed, detailsElapsed) {
    const base = data.leadscrew;
    const valid = snapshotFresh(data, elapsed) && fresh(base?.age_s, elapsed) && base?.status;
    const manual = section(details, 'mechanism', detailsElapsed);
    const mode = manual?.available === true && manual.simulated === true ? '仿真 · ' : '';
    if (!valid) return { state: '机构未连接', subline: '推杆反馈过期/缺失 · 充电电气未接入' };
    const moving = Array.isArray(base.status.state) && base.status.state.some(value => value === 1 || value === 3);
    return { state: `${mode}${moving ? '机构运行中' : '机构保持'}`, subline: '推杆位置为脉冲估算 · 落位/充电电气未接入' };
  }

  function detailsHtml(data, details, elapsed, detailsElapsed) {
    const live = snapshotFresh(data, elapsed);
    const mux = live && fresh(data.topicAgesS?.ugv_control_mux, elapsed) ? data.controlMux : {};
    const command = live && fresh(data.topicAgesS?.ugv_command_gateway, elapsed) ? data.commandGateway : {};
    const localization = data.localization || {};
    const locationFresh = live && fresh(localization.age_s, elapsed);
    const odomFresh = live && fresh(data.odom?.ageS, elapsed);
    const gps = live && fresh(data.gps?.ageS, elapsed, 3) ? data.gps.fix : null;
    const gpsValid = gps && Number.isInteger(gps.status) && gps.status >= 0;
    const environment = data.environment || {};
    const gateway = live ? data.gateway || {} : {};
    const mapping = live ? data.mapping || {} : {};
    const avoidance = live ? data.avoidance || {} : {};
    const navigation = section(details, 'navigation', detailsElapsed);
    const cruise = section(details, 'autoCruise', detailsElapsed);
    const maps = section(details, 'maps', detailsElapsed);
    const manual = section(details, 'mechanism', detailsElapsed);
    const mechanism = manual?.available === true ? manual : null;
    const lead = live && fresh(data.leadscrew?.age_s, elapsed) ? data.leadscrew.status : null;
    const mechanisms = [0, 1].map(index => [
      `组 ${index + 1}`,
      Number.isInteger(lead?.state?.[index]) ? stateLabels[lead.state[index]] || '未知状态' : '—',
      numeric(lead?.pos_mm?.[index], 'mm', 3), flag(lead?.enabled?.[index], '使能', '禁用')
    ]);
    const mapButtons = maps?.names?.map(name => `<button type="button" data-ugv-map="${safe(name)}">${safe(name)}</button>`).join('') || '<span class="dialog-muted">地图列表未提供或为空</span>';
    const snapshotTime = data.observedAt ? new Date(data.observedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
    const status = rows([
      ['车端连接', live ? 'HTTP 状态已接收' : '离线/快照过期'], ['快照时间', snapshotTime],
      ['服务', gateway.service], ['协议版本', gateway.schema_version], ['网关健康', flag(gateway.ok, '正常', '异常')],
      ['网关运行时长', numeric(gateway.uptime_s, 's', 1)], ['相机解码后端', flag(gateway.camera_backend, '可用', '不可用')],
      ['行驶速度（模长）', numeric(metric(data, 'speed', elapsed), 'm/s')], ['后向超声距离', numeric(metric(data, 'ultrasonic', elapsed), 'm')],
      ['环境温度 / 相对湿度', `${numeric(metric(data, 'temperature', elapsed), '°C', 1)} / ${numeric(metric(data, 'humidity', elapsed), '%RH', 1)}`],
      ['电池电量 / 电压', '当前 HTTP 网关未提供有效测量值'], ['温湿度连续错误次数', live ? environment.consecutiveErrors : null],
      ['温湿度采样错误', live ? environment.error || '无错误上报' : '—']
    ]);
    const sound = soundState(data, elapsed);
    const sensors = rows([['声音状态', sound.text]]) +
      `<p class="dialog-muted">${safe(sound.title)}</p>` +
      table(['传感器', '数字触发', 'GPIO', '去抖电平 / 原始电平', '触发电平', '变化次数', '样本年龄'], ['sound', 'flame', 'mq2'].map((key, index) => {
      const sensor = environment.digital?.[key];
      const valid = live && sensor?.valid === true && fresh(sensor.ageS, elapsed);
      return [['声音 GPIO（非分贝）', '火焰', 'MQ2 气体'][index], valid ? flag(sensor.triggered, '触发', '未触发') : '—', sensor?.gpio,
        valid ? `${sensor.level ?? '—'} / ${sensor.rawLevel ?? '—'}` : '—', sensor?.activeLevel, valid ? sensor.changes : null, ageText(sensor?.ageS, elapsed)];
      })) + '<p class="dialog-muted">声音状态只采用有效数字触发信号；判定未配置时显示待判定，尚未接入分贝测量。</p>';
    const location = rows([
      ['里程计位姿（odom）', pose(odomFresh ? data.odom?.pose : null)], ['里程计年龄', ageText(data.odom?.ageS, elapsed)],
      ['地图定位状态（快照）', live ? label(localization.state, locationLabels) : '—'], ['定位后端 / 地图', live ? `${localization.backend || '—'} / ${localization.map_name || '—'}` : '—'],
      ['定位启动时长', live ? numeric(localization.since_s, 's', 1) : '—'], ['地图位姿（map）', pose(locationFresh ? localization.map_pose : null)],
      ['定位置信度', locationFresh ? label(localization.confidence, { high: '高', medium: '中', low: '低', none: '无' }) : '—'],
      ['XY 不确定度 / 航向不确定度', locationFresh ? `${numeric(localization.xy_sigma_m, 'm', 3)} / ${numeric(Number.isFinite(localization.yaw_sigma_rad) ? localization.yaw_sigma_rad * 180 / Math.PI : null, '°')}` : '—'],
      ['地图位姿年龄', ageText(localization.age_s, elapsed)], ['定位错误', live ? localization.error || '无错误上报' : '—'],
      ['GPS 定位状态', gps ? label(String(gps.status), { '-1': '无定位', '0': '普通定位', '1': 'SBAS 定位', '2': 'GBAS 定位' }) : '—'],
      ['GPS 纬度 / 经度', gpsValid ? `${numeric(gps.latitude, '°', 7)} / ${numeric(gps.longitude, '°', 7)}` : '—'],
      ['GPS 高度', numeric(gpsValid ? gps.altitude : null, 'm', 1)], ['GPS 样本年龄', ageText(data.gps?.ageS, elapsed)]
    ]);
    const control = rows([
      ['控制权', label(mux.authority, authorityLabels)], ['控制原因', mux.reason], ['控制混合器使能 / 通行门', `${flag(mux.enabled)} / ${flag(mux.gate_open)}`],
      ['急停（混合器 / 指令网关）', `${flag(mux.emergency_stop)} / ${flag(command.emergency_stop)}`],
      ['要求任务状态', flag(mux.require_mission_status)], ['任务活动 / 暂停', `${flag(mux.mission_active)} / ${flag(mux.mission_paused)}`],
      ['设备侧任务状态 / 速度比例', `${mux.mission_state ?? '—'} / ${numeric(mux.mission_gate, '', 3)}`], ['操作端请求控制', flag(mux.operator_requested)],
      ['混合器输出（指令值）', `${numeric(mux.output_linear_mps, 'm/s')} / ${numeric(mux.output_angular_rps, 'rad/s')}`],
      ['指令网关使能 / 原因', `${flag(command.enabled)} / ${command.reason || '—'}`],
      ['指令网关输出（指令值）', `${numeric(command.output_linear_mps, 'm/s')} / ${numeric(command.output_angular_rps, 'rad/s')}`],
      ['输入指令年龄 / 超时阈值', `${ageText(command.input_age_s, elapsed)} / ${numeric(command.command_timeout_s, 's')}`],
      ['避障巡航状态（查询快照）', avoidance.available === true ? flag(avoidance.cruise_enabled, '启用', '停止') : '未上报']
    ]) + table(['混合器输入', '年龄'], Object.entries(mux.ages_s || {}).map(([key, value]) => [label(key, { navigation: '导航', teleop: '遥控', mission_status: '任务状态', mission_gate: '任务门控', operator: '操作端心跳' }), ageText(value, elapsed)]));
    const map = rows([
      ['SLAM 建图状态', flag(mapping.active, '建图中', '未建图')], ['建图运行时长', numeric(mapping.since_s, 's', 1)],
      ['建图初始位姿（TF 查询）', pose(mapping.initial_pose)], ['建图当前位姿（TF 查询）', pose(mapping.current_pose)],
      ['栅格地图样本年龄', ageText(data.map?.age_s, elapsed)]
    ]) + mapInfo(live ? data.map?.info : null) + '<p class="dialog-muted">TF 查询未提供变换年龄；地图可以是已保存数据。原管廊态势图保留。</p>' + `<div class="ugv-detail-toolbar"><button type="button" data-ugv-map="current">查看当前栅格地图</button>${mapButtons}</div>`;
    const navigationContent = rows([
      ['导航状态（查询快照）', navigation ? flag(navigation.active, '执行中', '未执行') : '接口不可用/过期'], ['已加载地图', flag(navigation?.hasMap)],
      ['导航目标', point(navigation?.goal)], ['路径点数量', navigation?.path?.length],
      ['自动巡航（查询快照）', cruise ? flag(cruise.active, '执行中', '未执行') : '接口不可用/过期'], ['巡航初始点', point(cruise?.initial)], ['巡航地图', cruise?.mapName]
    ]) + mapInfo(cruise?.mapInfo) + (navigation?.path?.length ? `<details class="ugv-path" data-group="path"><summary>查看导航路径点</summary>${table(['序号', 'X（m）', 'Y（m）'], navigation.path.map((value, index) => [index + 1, numeric(value[0]), numeric(value[1])]))}</details>` : '') + '<p class="dialog-muted">导航坐标取决于设备后端：Nav2 为 map，自研避障为 odom。这里显示状态，未下发导航目标。</p>';
    const leadContent = table(['机构', '软件状态', '相对位置（估算）', '使能'], mechanisms) + rows([
      ['机构样本年龄', ageText(data.leadscrew?.age_s, elapsed)], ['详细接口状态（查询时）', manual ? flag(manual.available, '在线', '离线') : '接口不可用/过期'],
      ['运行模式', mechanism ? flag(mechanism.simulated, '仿真', 'GPIO 输出') : '未上报'],
      ['忙碌 / 运动 / 复位（查询快照）', `${flag(mechanism?.busy)} / ${flag(mechanism?.moving)} / ${flag(mechanism?.resetting)}`],
      ['脉冲频率', numeric(mechanism?.speed, 'steps/s', 0)], ['位置基准', mechanism?.position_reference === 'relative_to_node_start' ? '节点启动后的相对脉冲估算' : mechanism?.position_reference || '未上报'],
      ['驱动报警硬件反馈', mechanism?.alarm_feedback === false ? '无硬件反馈' : '未核验'], ['机构消息', manual?.message],
      ['顺序归中软件标记', flag(mechanism?.simulation_clamped, '归中', '释放')], ['下次顺序动作', label(mechanism?.simulation_next_action, { clamp: '归中', release: '释放' })],
      ['物理落位 / 充电电流 / 接触确认', '未提供传感器反馈']
    ]) + (mechanism ? rows([['详情相对位置（估算）', Array.isArray(mechanism.pos_mm) ? mechanism.pos_mm.map(value => numeric(value, 'mm', 3)).join(' / ') : '—'],
      ['详情软件状态', Array.isArray(mechanism.state) ? mechanism.state.map(value => stateLabels[value] || '未知').join(' / ') : '—'],
      ['详情使能', Array.isArray(mechanism.enabled) ? mechanism.enabled.map(value => flag(value)).join(' / ') : '—']]) : '') +
      (mechanism?.simulation_geometry ? table(['组', '原开口（mm）', '目标开口（mm）', '单侧行程（mm）', '圈数', '脉冲数'], Object.entries(mechanism.simulation_geometry).map(([key, value]) => [key, value?.open_gap_mm, value?.target_gap_mm, value?.travel_mm, value?.turns, value?.pulses])) : '') +
      (Array.isArray(mechanism?.pins) ? table(['组', 'STEP GPIO', 'DIR GPIO', 'EN GPIO'], mechanism.pins.map((pins, index) => [index + 1, pins?.step, pins?.direction, pins?.enable])) : '') +
      (mechanism?.output ? `<pre class="ugv-raw">${safe(mechanism.output)}</pre>` : '') + '<p class="dialog-muted">位置与归中标记来自脉冲计数/软件状态，不证明机械限位、无人机落位、报警消除或充电完成。</p>';
    const cameras = table(['相机', '查询时状态', '样本年龄'], [['前视', 'camera'], ['后视', 'cameraRear'], ['俯视', 'cameraTop']].map(([name, key]) => [name,
      live && fresh(data[key]?.age_s, elapsed, 3) ? flag(data[key]?.ready, '有有效帧', '暂无有效帧') : '过期/未上报', ageText(data[key]?.age_s, elapsed)])) +
      '<div class="ugv-detail-toolbar"><button type="button" data-ugv-camera="front">查看前视</button><button type="button" data-ugv-camera="rear">查看后视</button><button type="button" data-ugv-camera="top">查看俯视</button></div><p class="dialog-muted">俯视 JPEG 路由存在，但该版本 /api/status 未输出俯视帧龄；画面接收时间不代表采样时间。</p>';
    const topics = table(['ROS 数据源', '样本年龄'], Object.entries(data.topicAgesS || {}).map(([key, value]) => [key, ageText(value, elapsed)]));
    const raw = safe(JSON.stringify({ status: data.rawSnapshot || null, details: details?.sections || null }, null, 2));
    return `<p class="dialog-muted">只读同步 · ${live ? '已接收车端快照' : '车端离线或快照已过期'} · 控制指令关闭</p>` +
      group('status', '车辆与环境', status, true) + group('digital', '数字报警与采样状态', sensors) + group('location', '定位与 GPS', location) +
      group('control', '控制权与指令链路', control) + group('map', '建图与已保存地图', map) + group('navigation', '导航与自动巡航', navigationContent) +
      group('mechanism', '居中推杆机构', leadContent) + group('camera', '相机与画面', cameras) + group('topics', 'ROS 数据新鲜度', topics) +
      group('raw', '原始只读参数', `<p class="dialog-muted">未经实时有效性过滤的最后一次原始快照，仅供诊断；请以各分组的有效值为准。</p><pre class="ugv-raw">${raw}</pre>`);
  }

  function renderDetails(container, data, details, elapsed, detailsElapsed) {
    const html = detailsHtml(data, details, elapsed, detailsElapsed);
    if (container._ugvHtml === html) return;
    const opened = new Map([...container.querySelectorAll('details[data-group]')].map(element => [element.dataset.group, element.open]));
    const scroller = container.closest('#dialog-body');
    const scrollTop = scroller?.scrollTop;
    container.innerHTML = html;
    container._ugvHtml = html;
    container.querySelectorAll('details[data-group]').forEach(element => { if (opened.has(element.dataset.group)) element.open = opened.get(element.dataset.group); });
    if (scroller) scroller.scrollTop = scrollTop;
  }

  return { renderDetails, mechanismState, section, snapshotFresh, soundState, cameraState, mapState, createMetricDisplay };
})();
