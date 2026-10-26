import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeUgvStatus } from '../src/ugv.js';

const context = { window: {} };
vm.runInNewContext(readFileSync(new URL('../../marp/ugv-view.js', import.meta.url), 'utf8'), context);
const view = context.window.AtomoriUgvView;
const sample = (change = {}, elapsed = 0) => normalizeUgvStatus({ environment: { digital: {
  sound: { available: true, stale: false, age_s: 0.1, triggered: null, level: 1, ...change },
  flame: { available: true, stale: false, age_s: 0.1, triggered: false },
  mq2: { available: true, stale: false, age_s: 0.1, triggered: true }
} } }, elapsed);

test('声音在线时按用户要求默认正常，缺失判定仍保留 null，明确触发才显示异常', () => {
  for (const level of [0, 1]) {
    const data = sample({ level });
    assert.equal(data.environment.digital.sound.available, true);
    assert.equal(data.environment.digital.sound.valid, false);
    assert.equal(data.environment.digital.sound.triggered, null);
    assert.equal(view.soundState(data, 0).text, '正常');
    assert.match(view.soundState(data, 0).title, /默认正常/);
  }
  const normal = view.soundState(sample({ triggered: false }), 0);
  assert.equal(normal.text, '正常');
  assert.doesNotMatch(normal.title, /默认/);
  const abnormal = view.soundState(sample({ triggered: true }), 0);
  assert.equal(abnormal.text, '异常');
  assert.equal(abnormal.color, 'var(--red)');
});

test('声音断连、缺失、过期和页面缓存失效不回退正常，其他数字传感器独立保持', () => {
  for (const change of [{ available: false }, { stale: true }, { age_s: 3 }, { age_s: null }, { age_s: -1 }, { age_s: '0.1' }]) {
    const data = sample(change);
    assert.equal(view.soundState(data, 0).text, '—');
    assert.equal(data.environment.digital.flame.triggered, false);
    assert.equal(data.environment.digital.mq2.triggered, true);
  }
  assert.equal(view.soundState(normalizeUgvStatus({}), 0).text, '—');
  assert.equal(view.soundState({}, 0).text, '—');
  assert.equal(view.soundState(sample({}, 2.1), 0).text, '—');
  assert.equal(view.soundState(sample(), 2).text, '—');
  assert.equal(view.soundState(sample({ triggered: true }), 2).text, '—');
  assert.equal(view.soundState(sample({ age_s: 0 }), 2).text, '正常');
});

test('车辆详情采用与主面板一致的声音状态并保留默认说明', () => {
  for (const change of [{}, { triggered: true }, { available: false }]) {
    const data = sample(change);
    const container = { innerHTML: '', querySelectorAll: () => [], closest: () => null };
    view.renderDetails(container, data, {}, 0, 0);
    assert.ok(container.innerHTML.includes(`<span>声音状态</span><b>${view.soundState(data, 0).text}</b>`));
    if (!Object.keys(change).length) assert.match(container.innerHTML, /默认正常/);
  }
});
