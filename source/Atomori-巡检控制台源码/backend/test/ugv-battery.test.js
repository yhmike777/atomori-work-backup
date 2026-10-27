import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = { window: {} };
vm.runInNewContext(readFileSync(new URL('../../marp/ugv-battery.js', import.meta.url), 'utf8'), context);
const { create, DURATION_MS } = context.window.AtomoriUgvBattery;
const EPOCH = 1700000000000;
const HOUR = 3600000;
const memoryStorage = () => {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};
const sample = (elapsedMs, changes = {}) => ({ fresh: true, sampleId: `sample-${elapsedMs}`,
  sampleAtMs: EPOCH + elapsedMs, uptimeS: 100 + elapsedMs / 1000, nowMs: EPOCH + elapsedMs, ...changes });
const offline = elapsedMs => ({ fresh: false, nowMs: EPOCH + elapsedMs });
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} != ${expected}`);

test('首次新鲜连接从100%开始，4小时线性下降到0且不出现负电量', () => {
  const battery = create({ storage: memoryStorage() });
  assert.equal(battery.update(offline(0)).percent, null);
  assert.equal(battery.update(sample(0)).percent, 100);
  assert.equal(battery.update(sample(HOUR)).percent, 75);
  assert.equal(battery.update(sample(2 * HOUR)).percent, 50);
  assert.equal(battery.update(sample(DURATION_MS)).percent, 0);
  assert.equal(battery.update(sample(5 * HOUR)).percent, 0);
  const result = battery.update(sample(6 * HOUR));
  assert.equal(result.estimated, true);
  assert.match(result.title, /4 小时续航线性估算，非电池实测/);
  assert.equal(result.remainingMs, 0);
});

test('刷新及关闭页面后重开，设备uptime连续时沿用原起点', () => {
  const storage = memoryStorage();
  create({ storage }).update(sample(0));
  const refreshed = create({ storage });
  assert.equal(refreshed.update(sample(HOUR)).percent, 75);
  assert.equal(create({ storage }).update(sample(2 * HOUR)).percent, 50);
});

test('多标签共享最新起点，旧快照不能误判uptime回退', () => {
  const storage = memoryStorage();
  const a = create({ storage }), b = create({ storage });
  a.update(sample(0));
  a.update(sample(HOUR));
  assert.equal(b.update(sample(0, { nowMs: EPOCH + HOUR })).percent, 75);
  a.update(sample(HOUR + 1000, { uptimeS: 1 }));
  assert.equal(b.update(sample(HOUR + 2000, { uptimeS: 2 })).elapsedMs, 1000);
});

test('短暂请求失败显示空值，恢复后继续计时而非恢复满电', () => {
  const battery = create({ storage: memoryStorage() });
  battery.update(sample(0));
  assert.equal(battery.update(offline(1000)).percent, null);
  for (let t = 2000; t <= 20000; t += 1000) battery.update(offline(t));
  closeTo(battery.update(sample(21000)).percent, 100 - 21000 / DURATION_MS * 100);
});

test('连续观测失联30秒后，即使uptime连续，重连仍从100%重算', () => {
  const storage = memoryStorage();
  const battery = create({ storage });
  battery.update(sample(0));
  for (let t = 1000; t <= 31000; t += 1000) battery.update(offline(t));
  assert.equal(create({ storage }).update(sample(32000)).percent, 100);
});

test('页面挂起期间没有持续失联证据，恢复时不因时间间隔误清零', () => {
  const battery = create({ storage: memoryStorage() });
  battery.update(sample(0));
  battery.update(offline(1000));
  battery.update(offline(HOUR));
  closeTo(battery.update(sample(HOUR + 1000)).percent, 100 - (HOUR + 1000) / DURATION_MS * 100);
});

test('网关重启uptime回退即时重算，缺失uptime不误作0', () => {
  const battery = create({ storage: memoryStorage() });
  battery.update(sample(0));
  assert.equal(battery.update(sample(HOUR, { uptimeS: null })).percent, 75);
  assert.equal(battery.update(sample(HOUR + 1000, { uptimeS: 2 })).percent, 100);
});

test('所有页面关闭时网关重启，即使新uptime超过旧值仍能识别', () => {
  const storage = memoryStorage();
  create({ storage }).update(sample(0));
  assert.equal(create({ storage }).update(sample(HOUR, { uptimeS: 2000 })).percent, 100);
});

test('相同快照反复渲染不会刷新uptime基准或取消已确认断联', () => {
  const battery = create({ storage: memoryStorage() });
  battery.update(sample(0));
  for (let t = 1000; t <= 31000; t += 1000) battery.update(offline(t));
  battery.update(sample(0, { nowMs: EPOCH + 32000 }));
  assert.equal(battery.update(sample(33000)).percent, 100);
});

test('本地时钟回拨不会使估算电量上升，刷新后仍然保持', () => {
  const storage = memoryStorage();
  const battery = create({ storage });
  battery.update(sample(0));
  assert.equal(battery.update(sample(HOUR)).percent, 75);
  assert.equal(battery.update(sample(HOUR / 2)).percent, 75);
  assert.equal(create({ storage }).update(sample(HOUR / 2 + 1000)).percent, 75);
});

test('localStorage损坏、不可用或异常数据均不影响内存估算', () => {
  let saved = '{invalid JSON';
  const battery = create({ storage: { getItem: () => saved, setItem: (key, value) => { saved = value; } } });
  assert.equal(battery.update(sample(0)).percent, 100);
  saved = '{"version":1,"startedAtMs":-1}';
  assert.equal(battery.update(sample(HOUR)).percent, 75);
  const unavailable = create({ storage: { getItem() { throw Error('denied'); }, setItem() { throw Error('quota'); } } });
  assert.equal(unavailable.update(sample(0)).percent, 100);
  assert.equal(unavailable.update(sample(HOUR)).percent, 75);
  assert.equal(unavailable.update(sample(HOUR, { nowMs: NaN })).percent, null);
  assert.equal(create({ storage: null }).update(sample(0, { sampleAtMs: null })).percent, null);
});
