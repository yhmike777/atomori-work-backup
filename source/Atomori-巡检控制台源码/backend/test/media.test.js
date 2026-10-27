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

test('活动 MJPEG 健康记录不被超过128次JPEG请求挤出，记录总数保持有界', { timeout: 12000 }, async t => {
  let closeStream;
  const streamClosed = new Promise(resolve => { closeStream = resolve; });
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
  const upstream = await listen(t, (req, res) => {
    if (req.url === '/api/camera.jpg') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(jpeg);
      return;
    }
    assert.equal(req.url, '/api/camera/stream');
    res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=FRAME' });
    const send = () => res.write(Buffer.concat([
      Buffer.from(`--FRAME\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),
      jpeg, Buffer.from('\r\n')
    ]));
    send();
    const timer = setInterval(send, 20);
    res.on('close', () => { clearInterval(timer); closeStream(); });
  });
  const integrations = createUpstreamIntegrations({ carUrl: upstream });
  const proxy = await listen(t, app(integrations));
  const response = await fetch(`${proxy}/api/v1/devices/UGV-01/cameras/front.mjpg?clientId=active-ground-video`, {
    signal: AbortSignal.timeout(10000)
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.ok(first.value.length > 0);

  // Simulate older dashboard tabs repeatedly fetching independent JPEG snapshots.
  for (let index = 0; index < 140; index++) {
    const snapshot = await fetch(`${proxy}/api/v1/devices/UGV-01/cameras/front.jpg?clientId=old-tab-${index}`);
    assert.equal(snapshot.status, 200);
    assert.deepEqual(Buffer.from(await snapshot.arrayBuffer()), jpeg);
  }
  const status = await fetch(`${proxy}/api/v1/devices/UGV-01/streams`);
  assert.equal(status.status, 200);
  const { data } = await status.json();
  assert.ok(data.streamHealth.length <= 128, '已完成的短请求不能使健康记录无限增长');
  const active = data.streamHealth.find(item => item.clientId === 'active-ground-video');
  assert.ok(active, '长期活动的 MJPEG 记录必须保留，避免前端错误判定图传中断');
  assert.equal(active.cameraId, 'front.mjpg');
  assert.equal(active.active, true);
  assert.ok(active.receivedBytes >= first.value.length);
  assert.equal((await reader.read()).done, false, '批量JPEG请求后原视频流仍能接收数据');
  await reader.cancel();
  await within(streamClosed);
});
