import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeUgvStatus } from '../src/ugv.js';

let view;
beforeEach(() => {
  const context = { window: {} };
  vm.runInNewContext(readFileSync(new URL('../../marp/ugv-view.js', import.meta.url), 'utf8'), context);
  view = context.window.AtomoriUgvView;
});
const fixture = () => ({
  environment: {
    available: false, stale: true, age_s: 30,
    digital: Object.fromEntries(['sound', 'alcohol', 'mq2', 'flame'].map((key, index) => [key, {
      gpio: [6, 13, 19, 26][index], available: true, stale: false, age_s: 0.1, triggered: key === 'alcohol'
    }])),
    analog: { available: true, age_s: 0.2, reference_v: 5, channels: {
      sound: { channel: 2, raw: 10, adc_voltage_v: 0.195, reference_estimate: {
        ppm: 25.257, status: 'reference_only', calibrated: false, r0_assumed: true, heating_verified: false,
        method: 'mqsensorslib_mq7_assumed_r0', parameters: { r0_ohm: 10000 }
      } },
      mq2: { channel: 0, raw: 120, adc_voltage_v: 2.344, reference_estimate: {
        ppm: 38486.886, status: 'reference_only', calibrated: false, method: 'csdn_162309276_default_baseline'
      } },
      flame: { channel: 3, raw: 138, adc_voltage_v: 2.695, relative_intensity: {
        percent: 46.1, status: 'relative_only', calibrated: false, method: 'inverse_voltage_normalization'
      } }
    } }
  },
  ultrasonic: { range: null, age_s: null }, ultrasonic_left: { range: 0, age_s: 0.1 }, ultrasonic_right: { range: 2.456, age_s: 0.2 }
});

test('H100 已核验旧字段映射：sound 是 MQ7，alcohol 才是声音，MQ2 独立', () => {
  const data = normalizeUgvStatus(fixture(), 0.1);
  const { sensors } = data.environment;
  assert.equal(sensors.carbonMonoxide.digital.gpio, 6);
  assert.equal(sensors.carbonMonoxide.analog.source, 'environment.analog.channels.sound');
  assert.equal(sensors.sound.digital.gpio, 13);
  assert.equal(sensors.sound.digital.triggered, true);
  assert.equal(sensors.smoke.digital.gpio, 19);
  assert.equal(sensors.smoke.digital.triggered, false);
  assert.equal(view.smokeState(data, 0).text, '38487 ppm · 3.849%', '烟雾沿用车端换算和精度，不加参考前缀');
  assert.equal(view.smokeState(data, 0).triggered, false, '不能把声音触发改名成烟雾');
  assert.equal(view.soundState(data, 0).text, '检测到声音');
  assert.equal(data.metrics.temperature.valid, false, 'DHT 故障不能污染独立 ADC 和 GPIO');
  assert.equal(data.metrics.ultrasonicLeft.value, 0);
  assert.equal(data.metrics.ultrasonicRight.value, 2.456);
  assert.equal(data.metrics.ultrasonic.value, null, '缺失后方回波不伪造零距离');
});

test('ADC 与气体估算保留真实来源、有效期和未标定标识，参考值不能展示为可靠浓度', () => {
  const data = normalizeUgvStatus(fixture(), 0.1), co = data.environment.sensors.carbonMonoxide.analog;
  assert.ok(Math.abs(co.ageS - 0.3) < 1e-10);
  assert.equal(co.voltageV, 0.195);
  assert.equal(co.referenceEstimate.ppm, 25.257);
  assert.equal(co.referenceEstimate.calibrated, false);
  assert.equal(co.referenceEstimate.r0Assumed, true);
  assert.equal(co.referenceEstimate.heatingVerified, false);
  assert.equal(view.coState(data, 0).text, '25.3 ppm · 0.00253%');
  assert.equal(view.coState(data, 0).color, view.smokeState(data, 0).color);
  assert.match(view.coState(data, 0).title, /未标定.*加热条件未验证.*不作为实测浓度/);
  assert.match(view.smokeState(data, 0).title, /模型参考约 38487 ppm/);
  assert.equal(data.environment.sensors.flame.analog.relativeIntensity.percent, 46.1);
  assert.equal(data.metrics.carbonMonoxidePpm, undefined, '参考值不能混进真实测量指标');
});

test('ADC 缺失、过期、越界或状态不可信时移除估算，数字开关保持独立', () => {
  for (const change of [{ available: false }, { stale: true }, { age_s: null }, { age_s: -1 }, { age_s: '0.1' }, { age_s: 2.01 }]) {
    const raw = fixture(); Object.assign(raw.environment.analog, change);
    const data = normalizeUgvStatus(raw);
    assert.equal(data.environment.sensors.carbonMonoxide.analog.referenceEstimate.ppm, null);
    assert.equal(view.coState(data, 0).text, '未触发');
    assert.equal(view.smokeState(data, 0).text, '未触发');
  }
  for (const change of [{ raw: null }, { raw: -1 }, { raw: 1.2 }, { adc_voltage_v: '0.2' }, { adc_voltage_v: -0.1 }, { adc_voltage_v: 5.1 }]) {
    const raw = fixture(); Object.assign(raw.environment.analog.channels.sound, change);
    const data = normalizeUgvStatus(raw);
    assert.equal(data.environment.sensors.carbonMonoxide.analog.referenceEstimate.ppm, null);
    assert.equal(data.environment.sensors.smoke.analog.valid, true, '模拟通道独立失效');
  }
  for (const change of [{ status: 'below_model_range' }, { ppm: -1 }, { ppm: '25' }, { ppm: null }]) {
    const raw = fixture(); Object.assign(raw.environment.analog.channels.sound.reference_estimate, change);
    assert.equal(normalizeUgvStatus(raw).environment.sensors.carbonMonoxide.analog.referenceEstimate.ppm, null);
  }
});

test('浏览器继续累计 ADC/开关年龄，断线后只读保留参考值并取消实时报警色', () => {
  const data = normalizeUgvStatus(fixture());
  assert.equal(view.coState(data, 1.9, 1900).text, '25.3 ppm · 0.00253%', 'ADC 年龄先过期时显示 lastValid 模型值');
  const held = view.coState(data, 2.1, 2100);
  assert.equal(held.retained, true);
  assert.equal(held.color, 'var(--muted)');
  assert.equal(held.valid, false);
  assert.equal(held.triggered, null);
  assert.equal(view.smokeState(data, 2.1, 2100).text, '38487 ppm · 3.849%');
  assert.equal(view.coState(data, 4, 4000).text, '25.3 ppm · 0.00253%');
  assert.equal(view.coState({}, 0, 60000).ageS, 60.2);
  assert.equal(view.smokeState({}, 0, 60000).text, '38487 ppm · 3.849%');
  const delayed = normalizeUgvStatus(fixture(), 2.1);
  assert.equal(delayed.environment.sensors.carbonMonoxide.analog.valid, false);
  assert.equal(delayed.metrics.ultrasonicLeft.valid, false);
  assert.equal(delayed.metrics.ultrasonicRight.valid, false);
});

test('传感器详情区同时呈现真实开关和明确标注的模型参考值', () => {
  const container = { innerHTML: '', querySelectorAll: () => [], closest: () => null };
  view.renderDetails(container, normalizeUgvStatus(fixture()), {}, 0, 0);
  assert.match(container.innerHTML, /烟雾 MQ-2/);
  assert.match(container.innerHTML, /25\.3 ppm · 0\.00253%/);
  assert.match(container.innerHTML, /38487 ppm · 3\.849%/);
  assert.match(container.innerHTML, /ADC 电压/);
  assert.match(container.innerHTML, /气体 ppm 为车端未标定模型参考值/);
  assert.match(container.innerHTML, /左侧 \/ 右侧超声距离/);
});
