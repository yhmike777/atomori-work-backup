import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';

test('三维模型与手势运行资源可同源读取，模块 MIME 支持 nosniff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomori-static-viewer-'));
  const assetDir = join(root, 'assets', 'product-viewer');
  await mkdir(assetDir, { recursive: true });
  const resources = [
    ['model.glb', 'model/gltf-binary', Buffer.from([0x67, 0x6c, 0x54, 0x46, 0, 255])],
    ['vision.mjs', 'text/javascript; charset=utf-8', Buffer.from('export const ready = true;')],
    ['vision.wasm', 'application/wasm', Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])],
    ['gesture.task', 'application/octet-stream', Buffer.from([1, 2, 3, 255])]
  ];
  for (const [name, , bytes] of resources) await writeFile(join(assetDir, name), bytes);
  await writeFile(join(assetDir, 'private.txt'), 'not a public asset type');
  const server = createServer(createApp({ webRoot: root, store: {} }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/assets/product-viewer/`;
  try {
    for (const [name, contentType, bytes] of resources) {
      const response = await fetch(base + name);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), contentType);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      const head = await fetch(base + name, { method: 'HEAD' });
      assert.equal(head.headers.get('content-length'), String(bytes.length));
      assert.equal((await head.arrayBuffer()).byteLength, 0);
    }
    assert.equal((await fetch(base + 'missing.glb')).status, 404);
    assert.equal((await fetch(base + 'private.txt')).status, 404);
    assert.equal((await fetch(base.replace('/assets/product-viewer/', '/product-viewer/package.json'))).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
