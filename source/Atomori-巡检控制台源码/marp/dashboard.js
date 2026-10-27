'use strict';

// Presentation adapter. Device freshness and record mutations remain owned by
// live.js / records.js; this module does not add another device polling loop.
(() => {
  const get = id => document.getElementById(id);
  // Older preview links must enter the same real-data path.
  const url = new URL(location.href);
  if (url.searchParams.has('preview')) { url.searchParams.delete('preview'); history.replaceState(null, '', url); }
  AtomoriRuntime.preview = false;
  const text = (id, value) => { const node = get(id); if (node) node.textContent = value; };
  // User-supplied reference values for this presentation card, not device telemetry.
  const missionReference = {
    name: '综合管廊 A 区 · 日常巡检', status: '进行中', progress: 68,
    phase: 'inspect', distance: '126 m', elapsed: '08:42', findings: '01'
  };
  const connection = (id, online) => {
    const node = get(id);
    node.classList.toggle('is-online', Boolean(online));
    node.replaceChildren(document.createElement('i'), document.createTextNode(online ? '在线' : '未连接'));
  };
  const battery = (id, value) => {
    get(id).style.width = Number.isFinite(value) ? `${Math.max(0, Math.min(100, value))}%` : '0%';
  };
  function renderSensorDots() {
    document.querySelectorAll('.environment-grid b').forEach(node => {
      node.dataset.state = node.textContent === '正常' ? 'normal' : /危险|异常|^触发$/.test(node.textContent) ? 'alert' : 'unknown';
    });
  }
  function renderEvents(events, failed = false) {
    const list = get('dashboard-events');
    list.replaceChildren();
    if (failed || !events.length) {
      const item = document.createElement('li');
      item.className = 'empty-events';
      item.textContent = failed ? '事件加载失败，请点「查看全部」重试' : '暂无事件';
      list.append(item);
      return;
    }
    for (const event of events.slice(0, 3)) {
      const row = document.createElement('li');
      const clock = document.createElement('time');
      const date = new Date(event.occurredAt);
      const validDate = Number.isFinite(date.getTime());
      const sameDay = validDate && date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) === new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
      clock.textContent = !validDate ? '—' : sameDay ? date.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
      if (Number.isFinite(date.getTime())) clock.dateTime = date.toISOString();
      clock.title = Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '事件时间未提供';
      const dot = document.createElement('i');
      if (/疑点|告警|异常/.test(event.title)) dot.className = 'warning';
      const label = document.createElement('span');
      label.textContent = event.title;
      row.title = `人工业务记录 · ${event.detail || event.title}`;
      row.append(clock, dot, label);
      list.append(row);
    }
  }
  function renderProgress(value, phase, status) {
    const valid = Number.isFinite(value);
    const percent = valid ? Math.max(0, Math.min(100, value)) : 0;
    get('dashboard-progress').innerHTML = valid ? `${Math.round(percent)}<small>%</small>` : '—';
    get('dashboard-progress-fill').style.width = `${percent}%`;
    const track = get('mission-progress-track');
    if (valid) track.setAttribute('aria-valuenow', String(Math.round(percent)));
    else track.removeAttribute('aria-valuenow');
    const stage = !valid ? -1 : status === 'completed' ? 4 : phase === 'inspect' ? 2 : phase === 'transit' ? 1 : phase === 'archive' ? 3 : -1;
    document.querySelectorAll('.task-stages>span').forEach((node, index) => {
      node.classList.toggle('done', index < stage);
      node.classList.toggle('current', index === stage);
    });
  }
  function renderRecords(snapshot) {
    text('dashboard-mission-name', missionReference.name);
    text('mission-status', missionReference.status);
    renderProgress(missionReference.progress, missionReference.phase, 'running');
    text('task-findings', missionReference.findings);
    text('task-distance', missionReference.distance); text('task-elapsed', missionReference.elapsed);
    if (snapshot.status.events !== 'loading') renderEvents(snapshot.events.filter(event => event.type !== 'demo'), snapshot.status.events === 'error');
    text('dashboard-source', '任务参考图数据 · 实时设备遥测');
  }
  get('mark-uav-visible').addEventListener('click', () => get('mark-anomaly').click());
  get('dashboard-mode').addEventListener('click', () => document.querySelector('[data-nav="devices"]').click());
  function renderSystemStatus() {
    const node = get('dashboard-system-status');
    text('dashboard-system-status', !serviceOnline ? '数据服务未连接' : uavOnline && ugvOnline ? '设备遥测在线' : uavOnline || ugvOnline ? '部分设备已连接' : '设备未连接');
    node.prepend(document.createElement('i'));
    node.classList.toggle('is-online', serviceOnline && (uavOnline || ugvOnline));
  }
  let serviceOnline = false, uavOnline = false, ugvOnline = false;
  function tick() {
    text('dashboard-clock', new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }));
  }
  tick();
  const clockTimer = setInterval(tick, 1000);
  window.addEventListener('pagehide', () => clearInterval(clockTimer), { once: true });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

  document.addEventListener('atomori:records', event => renderRecords(event.detail));
  document.addEventListener('atomori:connection', event => {
    serviceOnline = event.detail.available; renderSystemStatus();
  });
  document.addEventListener('atomori:uav', event => {
    uavOnline = event.detail.online; renderSystemStatus();
    connection('uav-connection', event.detail.online);
    battery('uav-battery-fill', event.detail.battery);
    get('flight-link').classList.toggle('is-online', event.detail.online);
    get('flight-link').lastChild.textContent = event.detail.online ? '遥测链路正常' : '遥测未连接';
  });
  document.addEventListener('atomori:ugv', event => {
    ugvOnline = event.detail.online; renderSystemStatus();
    connection('ugv-connection', event.detail.online);
    battery('ugv-battery-fill', event.detail.battery);
    text('localization-state', event.detail.localized ? '◎　已定位' : '◎　未定位');
    get('localization-state').classList.toggle('is-online', event.detail.localized);
  });
  document.addEventListener('atomori:relative', event => {
    get('relative-horizontal').innerHTML = event.detail.valid ? `${event.detail.horizontal.toFixed(2)} <small>m</small>` : '—';
    document.querySelector('.relative-position').classList.toggle('is-valid', event.detail.valid);
  });
  document.addEventListener('atomori:sensors', renderSensorDots);
  renderRecords(recordState);

})();
