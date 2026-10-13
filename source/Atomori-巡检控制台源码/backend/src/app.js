import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { assets, devices, mission, missionId, site } from './catalog.js';
import { unconfiguredIntegrations } from './integrations.js';

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
const allowedStatus = new Set(['acknowledged', 'reviewed']);

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function fail(res, status, code, message) { json(res, status, { error: { code, message } }); }

function proxyMedia(res, upstream, health, abort) {
  res.writeHead(200, {
    'content-type': upstream.headers.get('content-type'),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  const stream = Readable.fromWeb(upstream.body);
  let idleTimer;
  const cleanup = () => {
    clearTimeout(idleTimer);
    if (health) { health.active = false; health.closedAt = new Date().toISOString(); }
    abort?.();
  };
  if (health) {
    health.active = true;
    const watch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { cleanup(); stream.destroy(); res.destroy(); }, 15_000);
      idleTimer.unref();
    };
    stream.on('data', chunk => { health.receivedBytes += chunk.length; health.lastDataAt = new Date().toISOString(); watch(); });
    watch();
  }
  stream.on('error', () => res.destroy());
  stream.on('end', cleanup);
  res.on('close', () => { cleanup(); stream.destroy(); });
  stream.pipe(res);
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw Object.assign(new Error('请求体过大'), { status: 413 });
  }
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed;
  }
  catch { throw Object.assign(new Error('JSON 格式错误'), { status: 400 }); }
}

function event(data, title, detail, now, related = {}) {
  data.events.unshift({ id: crypto.randomUUID(), missionId, type: 'operator', title, detail, occurredAt: now, ...related });
}

async function serveFile(req, res, root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { return fail(res, 400, 'BAD_PATH', '路径编码错误'); }
  const path = resolve(root, `.${decoded}`);
  if (path !== root && !path.startsWith(root + sep)) return fail(res, 403, 'FORBIDDEN', '无权访问此路径');
  if (!mime[extname(path)]) return fail(res, 404, 'NOT_FOUND', '文件不存在');
  try {
    const info = await stat(path);
    if (!info.isFile()) return fail(res, 404, 'NOT_FOUND', '文件不存在');
    res.writeHead(200, { 'content-type': mime[extname(path)], 'content-length': info.size, 'x-content-type-options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    createReadStream(path).pipe(res);
  } catch (error) {
    if (error.code === 'ENOENT') return fail(res, 404, 'NOT_FOUND', '文件不存在');
    throw error;
  }
}

export function createApp({ store, webRoot, integrations = unconfiguredIntegrations }) {
  const mediaHealth = new Map();
  return async (req, res) => {
    try {
      const requestUrl = new URL(req.url, 'http://localhost');
      const pathname = requestUrl.pathname;
      if (pathname === '/') {
        res.writeHead(302, { location: '/marp/%E5%B7%A1%E6%A3%80%E6%8E%A7%E5%88%B6%E5%8F%B0.html' });
        return res.end();
      }
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持此方法');
        if (!pathname.startsWith('/marp/') && !pathname.startsWith('/assets/')) return fail(res, 404, 'NOT_FOUND', '文件不存在');
        return serveFile(req, res, webRoot, pathname);
      }
      if (!pathname.startsWith('/api/v1/')) return fail(res, 404, 'NOT_FOUND', '接口不存在');
      if (req.method === 'GET' && pathname === '/api/v1/health') return json(res, 200, { status: 'ok', mode: integrations.status?.().mode || 'demo' });
      if (req.method === 'GET' && pathname === '/api/v1/integrations') return json(res, 200, { data: integrations.status?.() || { mode: 'demo', commandsEnabled: false } });
      if (req.method === 'GET' && pathname === '/api/v1/devices/UAV-01/mission-planner') {
        if (!integrations.missionPlanner) return fail(res, 503, 'ADAPTER_NOT_CONFIGURED', 'Mission Planner 接收服务未配置');
        return json(res, 200, { data: await integrations.missionPlanner() });
      }
      if (req.method === 'GET' && pathname === '/api/v1/site') return json(res, 200, { data: site });
      if (req.method === 'GET' && pathname === '/api/v1/assets') return json(res, 200, { data: assets, mode: 'demo', catalogComplete: false });
      const assetMatch = pathname.match(/^\/api\/v1\/assets\/([^/]+)$/);
      if (req.method === 'GET' && assetMatch) {
        const asset = assets.find(item => item.id === assetMatch[1] || item.pointId === assetMatch[1]);
        return asset ? json(res, 200, { data: asset, mode: 'demo' }) : fail(res, 404, 'ASSET_NOT_FOUND', '设施不存在');
      }
      const measurementMatch = pathname.match(/^\/api\/v1\/assets\/([^/]+)\/measurements$/);
      if (req.method === 'GET' && measurementMatch) {
        const asset = assets.find(item => item.id === measurementMatch[1] || item.pointId === measurementMatch[1]);
        if (!asset) return fail(res, 404, 'ASSET_NOT_FOUND', '设施不存在');
        return json(res, 200, { data: await integrations.measurements(asset.id) });
      }
      if (req.method === 'GET' && pathname === '/api/v1/missions') return json(res, 200, { data: [mission], mode: 'demo' });
      if (req.method === 'GET' && pathname === `/api/v1/missions/${missionId}`) return json(res, 200, { data: mission, mode: 'demo' });
      if (req.method === 'GET' && pathname === '/api/v1/devices') {
        const configured = integrations.status?.() || {};
        return json(res, 200, { data: devices.map(item => ({ ...item, connection: ((item.id === 'UGV-01' && configured.carConfigured) || (item.id === 'UAV-01' && (configured.uavVisionConfigured || configured.uavFlightConfigured))) ? 'configured-unverified' : 'unconfigured' })), mode: configured.mode || 'demo' });
      }
      if (req.method === 'GET' && pathname === '/api/v1/maps/current.png') return proxyMedia(res, await integrations.mapImage());
      const savedMapMatch = pathname.match(/^\/api\/v1\/maps\/([A-Za-z0-9_-]{1,128})\.png$/);
      if (req.method === 'GET' && savedMapMatch) return proxyMedia(res, await integrations.mapImage(savedMapMatch[1]));
      if (req.method === 'GET' && pathname === '/api/v1/devices/UGV-01/scan') return json(res, 200, { data: await integrations.scan() });
      const cameraMatch = pathname.match(/^\/api\/v1\/devices\/([^/]+)\/cameras\/([^/]+)$/);
      if (req.method === 'GET' && cameraMatch) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.once('close', abort);
        const clientId = requestUrl.searchParams.get('clientId')?.slice(0, 80) || crypto.randomUUID();
        const health = { clientId, deviceId: cameraMatch[1], cameraId: cameraMatch[2], openedAt: new Date().toISOString(), lastDataAt: null, receivedBytes: 0, active: false, closedAt: null };
        // 仅保留最近连接，避免历史连接占用无限内存。
        mediaHealth.set(clientId + ':' + cameraMatch[1] + ':' + cameraMatch[2], health);
        while (mediaHealth.size > 128) mediaHealth.delete(mediaHealth.keys().next().value);
        try { return proxyMedia(res, await integrations.media(cameraMatch[1], cameraMatch[2], { signal: controller.signal }), health, abort); }
        catch (error) { health.closedAt = new Date().toISOString(); abort(); throw error; }
      }
      const deviceMatch = pathname.match(/^\/api\/v1\/devices\/([^/]+)\/(telemetry|streams)$/);
      if (req.method === 'GET' && deviceMatch) {
        if (!devices.some(item => item.id === deviceMatch[1])) return fail(res, 404, 'DEVICE_NOT_FOUND', '设备不存在');
        const value = deviceMatch[2] === 'telemetry' ? await integrations.telemetry(deviceMatch[1]) : await integrations.stream(deviceMatch[1]);
        if (deviceMatch[2] === 'streams') value.streamHealth = [...mediaHealth.values()].filter(item => item.deviceId === deviceMatch[1]).map(item => ({ ...item, idleAgeMs: item.lastDataAt ? Date.now() - Date.parse(item.lastDataAt) : null }));
        return json(res, 200, { data: value });
      }
      if (req.method === 'POST' && pathname === '/api/v1/commands') {
        const input = await body(req);
        return json(res, 202, { data: await integrations.command(input) });
      }

      const prefix = `/api/v1/missions/${missionId}`;
      if (pathname.startsWith('/api/v1/missions/') && !pathname.startsWith(prefix + '/')) return fail(res, 404, 'MISSION_NOT_FOUND', '任务不存在');
      const records = store.snapshot();
      if (req.method === 'GET' && pathname === `${prefix}/findings`) return json(res, 200, { data: records.findings, mode: 'demo' });
      if (req.method === 'GET' && pathname === `${prefix}/rechecks`) return json(res, 200, { data: records.rechecks, mode: 'demo' });
      if (req.method === 'GET' && pathname === `${prefix}/events`) return json(res, 200, { data: records.events, mode: 'demo' });
      if (req.method === 'GET' && pathname === `${prefix}/export`) {
        return json(res, 200, { mode: 'demo', exportedAt: new Date().toISOString(), mission, ...records }, { 'content-disposition': 'attachment; filename="atomori-records.json"' });
      }
      if (req.method === 'POST' && pathname === `${prefix}/findings`) {
        const input = await body(req);
        const asset = assets.find(item => item.id === input.assetId);
        if (!asset || typeof input.source !== 'string' || !input.source.trim() || typeof input.note !== 'string' || !input.note.trim() || input.note.length > 300) return fail(res, 400, 'VALIDATION_ERROR', '需要有效的 assetId、source 和 1–300 字备注');
        if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 120)) return fail(res, 400, 'VALIDATION_ERROR', 'requestId 必须为 1–120 字字符串');
        const requestId = input.requestId?.trim();
        const source = input.source.trim().slice(0, 80);
        const note = input.note.trim();
        const now = new Date().toISOString();
        const result = await store.change(data => {
          if (requestId) {
            const existing = data.findings.find(item => item.requestId === requestId);
            if (existing) {
              if (existing.assetId !== asset.id || existing.source !== source || existing.note !== note) throw Object.assign(new Error('该 requestId 已用于不同的疑点内容'), { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
              return { finding: existing, created: false };
            }
          }
          const finding = { id: crypto.randomUUID(), missionId, assetId: asset.id, pointId: asset.pointId, source, note, status: 'pending', createdAt: now, updatedAt: now, ...(requestId ? { requestId } : {}) };
          data.findings.push(finding);
          event(data, '巡检疑点已记录', asset.pointId, now, { findingId: finding.id, assetId: asset.id });
          return { finding, created: true };
        });
        return json(res, result.created ? 201 : 200, { data: result.finding, mode: 'demo' });
      }
      const findingMatch = pathname.match(new RegExp(`^${prefix}/findings/([^/]+)$`));
      if (req.method === 'PATCH' && findingMatch) {
        const input = await body(req);
        if (!allowedStatus.has(input.status)) return fail(res, 400, 'VALIDATION_ERROR', 'status 只能为 acknowledged 或 reviewed');
        if (input.expectedStatus !== undefined && !['pending', 'acknowledged', 'reviewed'].includes(input.expectedStatus)) return fail(res, 400, 'VALIDATION_ERROR', 'expectedStatus 必须为 pending、acknowledged 或 reviewed');
        if (!records.findings.some(item => item.id === findingMatch[1])) return fail(res, 404, 'FINDING_NOT_FOUND', '疑点不存在');
        const now = new Date().toISOString();
        const updated = await store.change(data => {
          const finding = data.findings.find(item => item.id === findingMatch[1]);
          if (!finding) throw Object.assign(new Error('疑点不存在'), { status: 404, code: 'FINDING_NOT_FOUND' });
          if (input.expectedStatus !== undefined && finding.status !== input.expectedStatus) throw Object.assign(new Error('记录状态已改变，请刷新后重试'), { status: 409, code: 'STATUS_CONFLICT' });
          if (finding.status === 'reviewed' && input.status !== 'reviewed') throw Object.assign(new Error('已复核记录不可退回'), { status: 409 });
          if (finding.status === input.status) return finding;
          finding.status = input.status;
          finding.updatedAt = now;
          event(data, input.status === 'reviewed' ? '人工复核已完成' : '告警已知悉', finding.pointId, now, { findingId: finding.id, assetId: finding.assetId });
          return finding;
        });
        return json(res, 200, { data: updated, mode: 'demo' });
      }
      if (req.method === 'POST' && pathname === `${prefix}/rechecks`) {
        const input = await body(req);
        const asset = assets.find(item => item.id === input.assetId);
        if (!asset) return fail(res, 400, 'VALIDATION_ERROR', '需要有效的 assetId');
        if (records.rechecks.some(item => item.assetId === asset.id)) return fail(res, 409, 'RECHECK_EXISTS', '该设施已在复查队列');
        const now = new Date().toISOString();
        const created = await store.change(data => {
          if (data.rechecks.some(item => item.assetId === asset.id)) throw Object.assign(new Error('该设施已在复查队列'), { status: 409, code: 'RECHECK_EXISTS' });
          const recheck = { id: crypto.randomUUID(), missionId, assetId: asset.id, pointId: asset.pointId, status: 'queued', createdAt: now };
          data.rechecks.push(recheck);
          event(data, '复查队列已加入', `${asset.pointId} · 仅保存业务记录，不下发机器人任务`, now, { recheckId: recheck.id, assetId: asset.id });
          return recheck;
        });
        return json(res, 201, { data: created, mode: 'demo' });
      }
      const recheckMatch = pathname.match(new RegExp(`^${prefix}/rechecks/([^/]+)$`));
      if (req.method === 'DELETE' && recheckMatch) {
        if (!records.rechecks.some(item => item.id === recheckMatch[1])) return fail(res, 404, 'RECHECK_NOT_FOUND', '复查任务不存在');
        await store.change(data => {
          const index = data.rechecks.findIndex(item => item.id === recheckMatch[1]);
          if (index === -1) throw Object.assign(new Error('复查任务不存在'), { status: 404, code: 'RECHECK_NOT_FOUND' });
          const [removed] = data.rechecks.splice(index, 1);
          event(data, '复查队列已取消', removed.pointId, new Date().toISOString(), { recheckId: removed.id, assetId: removed.assetId });
        });
        res.writeHead(204); return res.end();
      }
      return fail(res, 404, 'NOT_FOUND', '接口不存在');
    } catch (error) {
      if (error.status) return fail(res, error.status, error.code || (error.status === 409 ? 'CONFLICT' : 'BAD_REQUEST'), error.message);
      console.error(error);
      return fail(res, 500, 'INTERNAL_ERROR', '服务器内部错误');
    }
  };
}
