'use strict';

// 只保存服务端已确认的快照；本地设备演示事件独立展示，不参与导出。
const recordState = {
  mission: null, assets: [], findings: [], rechecks: [], events: [],
  status: { metadata: 'loading', findings: 'loading', rechecks: 'loading', events: 'loading' },
  errors: {}, generation: 0, view: null, busy: new Set(), draft: null, submitting: false
};
const demoEvents = [];
// Dashboard records are operator entries, never bundled demonstration seeds.
const isRealtimeDashboard = () => document.body.classList.contains('dashboard-page');
const isOperatorFinding = item => /(?:^|_)operator$/.test(item?.source || '') && !/_demo_/.test(item.source);
const visibleRecords = (key, data) => !isRealtimeDashboard() ? data
  : key === 'findings' ? data.filter(isOperatorFinding)
  : key === 'events' ? data.filter(item => item.type !== 'demo') : data;
const operatorExport = data => ({ mode: 'operator-records', exportedAt: data.exportedAt, recordDirectoryId: data.mission?.id || null, missionState: 'unavailable', findings: visibleRecords('findings', data.findings || []), rechecks: data.rechecks || [], events: visibleRecords('events', data.events || []) });
const findingStatus = { pending: '待确认', acknowledged: '已知悉', reviewed: '已复核' };
const statusLabel = status => findingStatus[status] || '未知状态';
const pointIdOf = point => String(point).match(/^([A-D]-\d{2})(?:\s|$)/)?.[1];
const assetForPoint = point => recordState.assets.find(asset => asset.pointId === pointIdOf(point));
const recordPoint = record => {
  const asset = recordState.assets.find(item => item.id === record.assetId);
  return asset ? `${asset.pointId} ${asset.name}` : record.pointId;
};
const recordPrefix = () => {
  if (!recordState.mission) throw new Error('任务目录尚未加载，请重试加载');
  return '/missions/' + encodeURIComponent(recordState.mission.id);
};
const ready = (...resources) => resources.every(key => recordState.status[key] === 'ready');
const currentNotice = () => recordState.findings.find(item => item.status === 'pending')
  || recordState.findings.find(item => item.status === 'acknowledged');
const surfaceRecord = () => recordState.findings.findLast(item => item.pointId === 'B-08');

function recordStateMessage(resource) {
  if (recordState.status[resource] === 'loading') return '加载中…';
  if (recordState.status[resource] === 'error') return '加载失败：' + recordState.errors[resource];
  return '';
}
function recordBanner(resource) {
  const message = recordStateMessage(resource);
  return message ? `<p class="dialog-warning" role="status">${escapeText(message)}${recordState[resource]?.length ? '；以下为上次服务端快照，操作暂不可用。' : ''}</p>` : '';
}
function addEvent(title, detail) {
  demoEvents.unshift({ time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), title, detail });
}
function eventRows(list, local = false) {
  return list.map(event => `<tr><td>${escapeText(local ? event.time : event.occurredAt)}</td><td>${escapeText(local ? '本地设备操作演示' : event.type === 'demo' ? '服务端演示种子' : '本机业务事件')}<br>${escapeText(event.title)}<br><span class="dialog-muted">${escapeText(event.detail)}${event.findingId ? ' · 疑点 ' + escapeText(event.findingId) : ''}${event.recheckId ? ' · 复查 ' + escapeText(event.recheckId) : ''}</span></td></tr>`).join('');
}
function renderRecordView() {
  document.dispatchEvent(new CustomEvent('atomori:records', { detail: recordState }));
  if (recordState.view === 'records' && $('action-dialog').open) drawRecords();
  else if (recordState.view === 'tasks' && $('action-dialog').open) drawTasks();
}
async function loadRecords({ background = false } = {}) {
  const generation = ++recordState.generation;
  if (!ready('metadata')) {
    recordState.status.metadata = 'loading';
    renderRecordView();
    try {
      const [missions, assets] = await Promise.all([AtomoriApi.request('/missions'), AtomoriApi.request('/assets')]);
      if (generation !== recordState.generation) return;
      if (!Array.isArray(missions.data) || missions.data.length !== 1 || !missions.data[0]?.id || !Array.isArray(assets.data)) throw new Error('任务或设施目录无效，无法确定当前任务');
      recordState.mission = missions.data[0];
      recordState.assets = assets.data;
      recordState.status.metadata = 'ready';
    } catch (error) {
      if (generation !== recordState.generation) return;
      for (const key of ['metadata', 'findings', 'rechecks', 'events']) {
        recordState.status[key] = 'error'; recordState.errors[key] = AtomoriApi.message(error);
      }
      renderRecordView(); return;
    }
  }
  if (!background) {
    for (const key of ['findings', 'rechecks', 'events']) recordState.status[key] = 'loading';
    renderRecordView();
  }
  await Promise.all(['findings', 'rechecks', 'events'].map(async key => {
    try {
      const result = await AtomoriApi.request(recordPrefix() + '/' + key);
      if (generation !== recordState.generation) return;
      if (!Array.isArray(result.data)) throw new Error('服务端记录格式错误');
      recordState[key] = visibleRecords(key, result.data); recordState.status[key] = 'ready'; delete recordState.errors[key];
    } catch (error) {
      if (generation !== recordState.generation) return;
      recordState.status[key] = 'error'; recordState.errors[key] = AtomoriApi.message(error);
    }
  }));
  if (generation === recordState.generation) renderRecordView();
}
function recordActions() {
  return [{ label: '刷新 / 重试加载', run: loadRecords }, { label: '导出服务端记录', run: exportRecords }];
}
function drawRecords() {
  openDialog('巡检记录与事件', `<p class="dialog-muted">${escapeText(recordState.mission?.id || '任务加载中')} · 人工业务记录 · 历史记录保留原始时间 · 未关联实机任务</p>${recordBanner('metadata')}${recordBanner('findings')}<h3>疑点记录 · ${recordState.findings.length} 项</h3>${recordState.findings.length ? `<table><thead><tr><th>点位 / 来源 / ID</th><th>观察备注</th><th>状态</th><th>处理</th></tr></thead><tbody>${recordState.findings.map(item => {
    const disabled = !ready('findings', 'metadata') || recordState.busy.has('finding:' + item.id);
    return `<tr><td>${escapeText(recordPoint(item))}<br>${escapeText(item.source)}<br><small>${escapeText(item.id)}</small></td><td class="record-note">${escapeText(item.note)}</td><td>${escapeText(statusLabel(item.status))}</td><td><div class="record-actions"><button data-ack="${escapeText(item.id)}" ${disabled || item.status !== 'pending' ? 'disabled' : ''}>知悉</button><button data-resolve="${escapeText(item.id)}" ${disabled || item.status === 'reviewed' ? 'disabled' : ''}>复核完成</button><button data-recheck="${escapeText(item.id)}" ${!ready('metadata', 'rechecks') || recordState.busy.has('recheck:' + item.assetId) ? 'disabled' : ''}>加入复查</button></div></td></tr>`;
  }).join('')}</tbody></table>` : ready('findings') ? '<p class="dialog-muted">暂无疑点记录，可从图传区域标记疑点。</p>' : ''}<h3 class="record-heading">服务端事件</h3>${recordBanner('events')}<table><tbody>${eventRows(recordState.events)}</tbody></table>${ready('events') && !recordState.events.length ? '<p class="dialog-muted">暂无服务端事件。</p>' : ''}${isRealtimeDashboard() ? '' : `<h3 class="record-heading">本地设备操作演示</h3><table><tbody>${eventRows(demoEvents, true)}</tbody></table>`}`, recordActions());
  recordState.view = 'records';
}
function showRecords() { drawRecords(); void loadRecords(); }
function drawTasks() {
  openDialog('任务与复查队列', `<p class="dialog-muted">实机任务状态待接入。复查队列保存人工业务记录，不会下发机器人任务。</p>${recordBanner('metadata')}<div class="task-item"><strong>${isRealtimeDashboard() ? '实机任务状态待接入' : escapeText(recordState.mission?.name || '任务未加载')}</strong><span>${escapeText(recordState.mission?.id || '—')} · 本机记录目录</span></div><h3 class="record-heading">复查队列 · ${recordState.rechecks.length} 项</h3>${recordBanner('rechecks')}${recordState.rechecks.map(item => `<div class="task-item"><strong>${escapeText(recordPoint(item))}<br><small>${escapeText(item.id)}</small></strong><button data-cancel-recheck="${escapeText(item.id)}" ${!ready('rechecks') || recordState.busy.has('recheck:' + item.assetId) ? 'disabled' : ''}>取消复查</button></div>`).join('')}${ready('rechecks') && !recordState.rechecks.length ? '<p class="dialog-muted">暂无复查记录。</p>' : ''}`, recordActions());
  recordState.view = 'tasks';
}
function showTasks() { drawTasks(); void loadRecords(); }
async function mutateRecord(key, request, success) {
  if (recordState.busy.has(key)) return;
  recordState.busy.add(key); renderRecordView();
  try {
    await request(); toast(success);
    await loadRecords();
  } catch (error) {
    toast(AtomoriApi.message(error));
    // 包括409和网络超时：重新读取服务端，不用本地状态推断提交结果。
    await loadRecords();
  } finally { recordState.busy.delete(key); renderRecordView(); }
}
function updateFinding(id, status) {
  const finding = recordState.findings.find(item => item.id === id);
  if (!ready('metadata', 'findings') || !finding) return toast('记录尚未加载，请刷新后重试');
  if (finding.status === 'reviewed') return toast('已复核记录不可退回');
  return mutateRecord('finding:' + id, () => AtomoriApi.request(recordPrefix() + '/findings/' + encodeURIComponent(id), {
    method: 'PATCH', body: { status, expectedStatus: finding.status }
  }), status === 'reviewed' ? '人工复核已保存' : '知悉状态已保存');
}
function addRecheck(point, assetId) {
  if (!ready('metadata', 'rechecks')) return toast('复查队列尚未加载，请刷新后重试');
  const asset = assetForPoint(point);
  if (!asset || (assetId && asset.id !== assetId)) return toast('该点位未匹配后端设施目录，无法加入复查');
  if (recordState.rechecks.some(item => item.assetId === asset.id)) return toast('该设施已在复查队列，不会重复加入');
  return mutateRecord('recheck:' + asset.id, () => AtomoriApi.request(recordPrefix() + '/rechecks', {
    method: 'POST', body: { assetId: asset.id }
  }), '已保存复查记录；不会下发机器人任务');
}
function cancelRecheck(id) {
  const item = recordState.rechecks.find(record => record.id === id);
  if (!ready('rechecks') || !item) return toast('请刷新复查队列后重试');
  return mutateRecord('recheck:' + item.assetId, () => AtomoriApi.request(recordPrefix() + '/rechecks/' + encodeURIComponent(id), { method: 'DELETE' }), '复查记录已取消');
}
function observationSource(key) {
  const config = AtomoriRuntime.config;
  if ((!config || isRealtimeDashboard()) && ['uav', 'ugv', 'dock', 'thermal'].includes(key)) return `${key}_source_unconfirmed_operator`;
  const upstream = key === 'ugv' || key === 'uav' ? config?.carConfigured : key === 'dock' ? config?.uavVisionConfigured : false;
  return `${key}_${upstream ? 'upstream_unverified' : 'demo'}_operator`;
}
function markAnomaly(key = state.camera, point = state.cameraPoint, preset = '') {
  if (isRealtimeDashboard() && !ready('metadata')) { void loadRecords(); return toast('正在加载设施目录，请稍后重试标记'); }
  const source = observationSource(key);
  const draft = { point: isRealtimeDashboard() ? '' : point, source, requestId: crypto.randomUUID(), attemptedNote: null };
  const pointField = isRealtimeDashboard() ? `<label for="anomaly-point">人工选择点位（静态设施目录）<select id="anomaly-point"><option value="">请选择，当前设备未提供巡检点位</option>${recordState.assets.map(asset => `<option value="${escapeText(asset.pointId)}">${escapeText(asset.pointId + ' ' + asset.name)}</option>`).join('')}</select></label>` : `<p><strong>${escapeText(point)}</strong> · ${escapeText(source)}</p>`;
  recordState.draft = draft;
  openDialog('标记巡检疑点', `${pointField}<label for="anomaly-note">观察备注<textarea id="anomaly-note" maxlength="300" placeholder="描述观察到的部位及异常现象">${escapeText(preset)}</textarea></label><p id="finding-save-error" class="dialog-warning" role="alert" hidden></p><p class="dialog-muted">保存为人工观察备注，点位由操作者确认；不自动附加测量结果或图像证据。</p>`, [{ label: '取消', run: closeDialog }, { label: '保存记录', primary: true, run: () => saveFinding(draft) }]);
}
async function saveFinding(draft) {
  if (recordState.submitting || recordState.draft !== draft) return;
  const input = $('anomaly-note'), errorNode = $('finding-save-error');
  const note = input.value.trim();
  const errorMessage = message => { errorNode.textContent = message; errorNode.hidden = false; };
  if (!note || note.length > 300) { errorMessage('请输入 1–300 字观察备注'); input.focus(); return; }
  const pointInput = $('anomaly-point');
  if (pointInput) {
    if (!pointInput.value) { errorMessage('请人工选择观察点位'); pointInput.focus(); return; }
    if (draft.point !== pointInput.value && draft.attemptedNote !== null) draft.requestId = crypto.randomUUID();
    draft.point = pointInput.value;
  }
  const asset = assetForPoint(draft.point);
  if (ready('metadata') && !asset) { errorMessage('该点位未匹配后端设施目录，禁止绑定其他设施'); return; }
  // 超时后同一份输入沿用幂等键；用户修改输入后视为新提交。
  if (draft.attemptedNote !== null && draft.attemptedNote !== note) draft.requestId = crypto.randomUUID();
  draft.attemptedNote = note;
  recordState.submitting = true; errorNode.hidden = true;
  const buttons = [...$('dialog-actions').querySelectorAll('button'), $('close-dialog')];
  buttons.forEach(button => { button.disabled = true; }); input.disabled = true; if (pointInput) pointInput.disabled = true;
  const submit = buttons.find(button => button.classList.contains('confirm')); submit.textContent = '保存中…';
  let saved = false;
  try {
    if (!ready('metadata')) await loadRecords();
    const matched = assetForPoint(draft.point);
    if (!ready('metadata')) throw new Error('任务或设施目录加载失败，请重试；备注已保留');
    if (!matched) throw new Error('该点位未匹配后端设施目录，禁止绑定其他设施');
    const response = await AtomoriApi.request(recordPrefix() + '/findings', {
      method: 'POST', body: { assetId: matched.id, source: draft.source, note, requestId: draft.requestId }
    });
    if (!response?.data?.id) throw new Error('保存响应无有效记录 ID，请重试核对');
    saved = true;
  } catch (error) { errorMessage(AtomoriApi.message(error) + '；备注已保留，可重试'); }
  finally {
    recordState.submitting = false; input.disabled = false; if (pointInput) pointInput.disabled = false;
    buttons.forEach(button => { button.disabled = false; }); submit.textContent = '保存记录';
  }
  if (saved) { closeDialog(); recordState.draft = null; toast('疑点已保存到本机后端'); await loadRecords(); }
}
async function exportRecords() {
  if (recordState.busy.has('export')) return;
  recordState.busy.add('export');
  const buttons = [...$('dialog-actions').querySelectorAll('button')].filter(button => button.textContent.includes('导出'));
  buttons.forEach(button => { button.disabled = true; });
  try {
    const data = await AtomoriApi.request(recordPrefix() + '/export');
    const link = document.createElement('a');
    const url = URL.createObjectURL(new Blob([JSON.stringify(isRealtimeDashboard() ? operatorExport(data) : data, null, 2)], { type: 'application/json' }));
    link.href = url; link.download = 'Atomori-本机业务记录.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('服务端记录已生成下载');
  } catch (error) { toast(AtomoriApi.message(error)); }
  finally { recordState.busy.delete('export'); buttons.forEach(button => { button.disabled = false; }); }
}

// Refresh visible summary without disrupting note drafts, mutations, or an open dialog.
let recordRefreshTimer;
async function refreshRecordSummary() {
  try {
    if (isRealtimeDashboard() && !document.hidden && !$('action-dialog').open
        && !recordState.submitting && !recordState.busy.size
        && !Object.values(recordState.status).includes('loading')) await loadRecords({ background: true });
  } finally { recordRefreshTimer = setTimeout(refreshRecordSummary, 5000); }
}
recordRefreshTimer = setTimeout(refreshRecordSummary, 5000);
window.addEventListener('pagehide', () => clearTimeout(recordRefreshTimer), { once: true });
