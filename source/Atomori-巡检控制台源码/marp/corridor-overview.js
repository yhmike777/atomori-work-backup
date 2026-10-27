'use strict';

(() => {
  const get = id => document.getElementById(id);
  const regions = { A: '入口保障区', B: '综合巡检区', C: '电力设备区', D: '给排水区' };
  const points = [
    { id: 'A-01', name: '入口竖井', x: 6.3, y: 19.2 },
    { id: 'B-08', name: '阀组', x: 40, y: 45.4 },
    { id: 'B-11', name: '通风机', x: 54, y: 29.5 },
    { id: 'B-12', name: '防火门', x: 67.7, y: 69.7 },
    { id: 'C-06', name: '电缆接头', x: 76.4, y: 16.7 },
    { id: 'D-10', name: '泵房接口', x: 76.7, y: 70.6 }
  ];
  const mapNetwork = {
    A: [[[6.3,21],[15.8,21.4],[15.8,34.5],[23.3,34.8],[23.5,45.4],[34.7,45.4]],[[4.7,75.4],[5.2,61.3],[17.8,60.4],[18.4,51.6],[23.3,51.6],[23.5,45.4]]],
    B: [[[34.7,45.4],[47.4,45.3],[66,45.4]],[[47.5,10.7],[47.6,33.3],[47.4,45.3],[47.9,59.1]],[[31.2,21.2],[34.9,21.4],[34.9,33.3],[47.6,33.3],[52.8,35.1]],[[47.9,59.1],[40.8,59.2],[40.4,72.6],[55,72.6],[55,59.3],[47.9,59.1]],[[47.4,45.3],[66,45.4],[66,69.9],[55,69.9],[55,59.3]],[[47.3,72.6],[47.2,85]]],
    C: [[[66,45.4],[70.1,44.4],[70.1,21.2],[81.6,21.3],[81.8,31.3],[94.6,31.3],[94.7,22]],[[70.1,44.4],[88.3,44.8],[88.3,31.7],[81.8,31.3],[81.8,21.3],[70.1,21.2],[70.1,44.4]],[[81.6,21.3],[87.2,21.2],[87.1,11.8]]],
    D: [[[66,65.1],[73.6,65.1],[79,66],[79.9,80]]]
  };
  const previewRoute = [[34.7,45.4],[40,45.4],[47.4,45.3],[54.9,45.4],[62.2,45.4],[47.4,45.3],[47.6,33.3],[52.8,35.1],[47.6,33.3],[47.4,45.3],[47.9,59.1],[40.8,59.2],[40.4,72.6],[55,72.6],[55,69.9],[66,69.9]];
  const mapPath = vertices => 'M' + vertices.map(([x, y]) => `${x * 10} ${y * 5}`).join('L');
  const zoneColors = { A: '#8be0ed', B: '#9cbdff', C: '#f7cf8d', D: '#83e6c4' };
  for (const [zone, lines] of Object.entries(mapNetwork)) {
    for (const [width, color, opacity] of [[26, '#284957', 1], [14, zoneColors[zone], 0.65]]) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', lines.map(mapPath).join(' '));
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', width);
      path.setAttribute('stroke-opacity', opacity);
      get('network-lines').append(path);
    }
  }
  get('preview-route').setAttribute('d', mapPath(previewRoute));

  const params = new URLSearchParams(location.search);
  let selected = points.find(point => point.id === params.get('point')) || points[1];
  let records = { status: 'loading', assets: [], findings: [], error: '' };
  let loading = false;

  function setFlatView(flat) {
    get('corridor-map').classList.toggle('is-2d', flat);
    get('toggle-map').setAttribute('aria-pressed', String(flat));
    get('toggle-map').textContent = flat ? '切换 2.5D' : '切换二维';
    get('map-view-label').textContent = flat ? '二维四区线路示意' : '2.5D 空间示意';
  }
  get('toggle-map').addEventListener('click', () => setFlatView(!get('corridor-map').classList.contains('is-2d')));
  get('toggle-route').addEventListener('click', () => {
    const visible = get('toggle-route').getAttribute('aria-pressed') !== 'true';
    get('toggle-route').setAttribute('aria-pressed', String(visible));
    get('toggle-route').textContent = visible ? '隐藏路径' : '显示路径';
    get('preview-route').style.display = visible ? '' : 'none';
  });
  setFlatView(params.get('view') === '2d');

  function renderDetails() {
    get('point-title').textContent = `${selected.id} · ${selected.name}`;
    get('point-zone').textContent = `${selected.id[0]} 区 · ${regions[selected.id[0]]}`;
    document.querySelectorAll('[data-point]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.point === selected.id)));
    get('point-records').replaceChildren();
    if (records.status !== 'ready') {
      get('point-asset').textContent = records.status === 'loading' ? '加载中…' : '尚未读取';
      get('record-status').textContent = records.status === 'loading' ? '正在读取本机记录…' : `本机记录暂不可用：${records.error}`;
      return;
    }
    const asset = records.assets.find(item => item.pointId === selected.id);
    get('point-asset').textContent = asset?.id || '未匹配后端目录';
    const findings = records.findings.filter(item => item.pointId === selected.id);
    get('record-status').textContent = findings.length ? `共 ${findings.length} 条本机业务记录` : '该点位暂无本机疑点记录';
    const statusNames = { pending: '待确认', acknowledged: '已知悉', reviewed: '已复核' };
    for (const finding of findings) {
      const row = document.createElement('li');
      row.textContent = finding.note || '未填写观察备注';
      const meta = document.createElement('small');
      meta.textContent = `${statusNames[finding.status] || '未知状态'} · ${finding.source || '来源未注明'}`;
      row.append(meta);
      get('point-records').append(row);
    }
  }

  for (const point of points) {
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'asset-pin';
    pin.style.left = `${point.x}%`;
    pin.style.top = `${point.y}%`;
    pin.dataset.point = point.id;
    pin.setAttribute('aria-label', `${point.id} ${point.name}，查看示意点位档案`);
    const dot = document.createElement('i');
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = `${point.id} · ${point.name}`;
    const hint = document.createElement('em');
    hint.textContent = '示意点位 · 测量未接入';
    label.append(hint);
    pin.append(dot, label);
    get('point-pins').append(pin);
    const item = document.createElement('button');
    item.type = 'button';
    item.dataset.point = point.id;
    item.textContent = `${point.id} ${point.name}`;
    get('point-list').append(item);
    for (const button of [pin, item]) button.addEventListener('click', () => { selected = point; renderDetails(); });
  }

  async function loadRecords() {
    if (loading) return;
    loading = true;
    records.status = 'loading';
    get('reload-records').disabled = true;
    renderDetails();
    try {
      const [missions, assets] = await Promise.all([AtomoriApi.request('/missions'), AtomoriApi.request('/assets')]);
      if (!Array.isArray(missions?.data) || missions.data.length !== 1 || !missions.data[0]?.id || !Array.isArray(assets?.data)) throw new Error('任务或设施目录无效');
      const result = await AtomoriApi.request('/missions/' + encodeURIComponent(missions.data[0].id) + '/findings');
      if (!Array.isArray(result?.data) || assets.data.some(item => !item || typeof item.pointId !== 'string') || result.data.some(item => !item || typeof item.pointId !== 'string')) throw new Error('设施或疑点记录格式无效');
      records = { status: 'ready', assets: assets.data, findings: result.data, error: '' };
    } catch (error) {
      records = { status: 'error', assets: [], findings: [], error: AtomoriApi.message(error) };
    } finally {
      loading = false;
      get('reload-records').disabled = false;
      renderDetails();
    }
  }
  get('reload-records').addEventListener('click', loadRecords);
  renderDetails();
  void loadRecords();
})();
