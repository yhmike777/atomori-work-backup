import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { createApp } from '../src/app.js';
import { createUpstreamIntegrations } from '../src/upstream.js';

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function within(promise, timeoutMs = 2000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('上游连接未及时关闭')), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function app(integrations) {
  return createApp({ integrations, store: { snapshot: () => ({}) }, webRoot: process.cwd() });
}

test('MJPEG 代理持续超过旧 8 秒限制，客户端取消后关闭上游连接', { timeout: 16000 }, async t => {
  let closeUpstream;
  const upstreamClosed = new Promise(resolve => { closeUpstream = resolve; });
  const upstream = await listen(t, (req, res) => {
    assert.equal(req.url, '/stream.mjpg');
    res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=FRAME' });
    let frame = 0;
    const send = () => {
      // 合成帧仅用于协议测试；不代表实机图片。
      const bytes = Buffer.from([0xff, 0xd8, frame++ % 256, 0xff, 0xd9]);
      res.write(`--FRAME\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.length}\r\n\r\n`);
      res.write(bytes);
      res.write('\r\n');
    };
    send();
    const interval = setInterval(send, 80);
    res.on('close', () => { clearInterval(interval); closeUpstream(); });
  });
  const integrations = createUpstreamIntegrations({ uavVisionUrl: upstream });
  const proxy = await listen(t, app(integrations));
  const response = await fetch(`${proxy}/api/v1/devices/UAV-01/cameras/ov9281.mjpg`, { signal: AbortSignal.timeout(14000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /multipart\/x-mixed-replace/);
  const reader = response.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  const started = Date.now();
  let chunks = 0;
  while (Date.now() - started < 9200) {
    const { done, value } = await reader.read();
    assert.equal(done, false, '持续视频不应提前结束');
    assert.ok(value.length > 0);
    chunks++;
  }
  assert.ok(chunks > 80, '整个测试期间应持续接收新帧');
  await reader.cancel();
  await within(upstreamClosed);
});

test('客户端在收到视频响应头之前断开，也会取消待建立的上游请求', { timeout: 5000 }, async t => {
  let started;
  let closed;
  const upstreamStarted = new Promise(resolve => { started = resolve; });
  const upstreamClosed = new Promise(resolve => { closed = resolve; });
  const upstream = await listen(t, (req, res) => {
    started();
    res.on('close', closed);
    // 故意不发送响应头，检查初始化阶段的取消链路。
  });
  const integrations = createUpstreamIntegrations({ uavVisionUrl: upstream });
  const proxy = await listen(t, app(integrations));
  const client = get(`${proxy}/api/v1/devices/UAV-01/cameras/ov9281.mjpg`);
  client.on('error', () => {});
  t.after(() => client.destroy());
  await within(upstreamStarted);
  client.destroy();
  await within(upstreamClosed);
});

test('上游非成功响应仍被拒绝，错误状态不会代理成视频成功', async t => {
  const upstream = await listen(t, (_req, res) => { res.writeHead(503); res.end('unavailable'); });
  const integrations = createUpstreamIntegrations({ uavVisionUrl: upstream });
  await assert.rejects(integrations.media('UAV-01', 'ov9281.mjpg'), error => {
    assert.equal(error.code, 'UPSTREAM_UNAVAILABLE');
    assert.match(error.message, /503/);
    return true;
  });
});

test('上游视频类型错误仍被拒绝且未消费响应体被取消', { timeout: 5000 }, async t => {
  let closed;
  const upstreamClosed = new Promise(resolve => { closed = resolve; });
  const upstream = await listen(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write('wrong content type');
    res.on('close', closed);
  });
  const integrations = createUpstreamIntegrations({ uavVisionUrl: upstream });
  await assert.rejects(integrations.media('UAV-01', 'ov9281.mjpg'), { code: 'UPSTREAM_INVALID' });
  await within(upstreamClosed);
});

test('有限遥测 HTTP 请求仍有超时，不会跟随长流取消超时保护', { timeout: 6500 }, async t => {
  let closed;
  const upstreamClosed = new Promise(resolve => { closed = resolve; });
  const upstream = await listen(t, (_req, res) => { res.on('close', closed); });
  const integrations = createUpstreamIntegrations({ uavVisionUrl: upstream });
  const started = Date.now();
  await assert.rejects(integrations.telemetry('UAV-01'), { code: 'UPSTREAM_UNAVAILABLE' });
  assert.ok(Date.now() - started >= 2000, '保留既有 2.5 秒有限请求超时');
  await within(upstreamClosed);
});

test('收到响应头后的有限 JSON 响应体读取仍有超时', { timeout: 6500 }, async t => {
  let closed;
  const upstreamClosed = new Promise(resolve => { closed = resolve; });
  const upstream = await listen(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
    res.on('close', closed);
  });
  const integrations = createUpstreamIntegrations({ uavVisionUrl: upstream });
  await assert.rejects(integrations.telemetry('UAV-01'), { code: 'UPSTREAM_INVALID' });
  await within(upstreamClosed);
});
