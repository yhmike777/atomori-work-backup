import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpstreamIntegrations } from '../src/upstream.js';

const sample = () => ({
  sensor: 'ov9281', found: true, tag_id: 1, quality_passed: true,
  capture_age_ms: 100, frame_age_ms: 20,
  x_m: 99, y_m: 98, z_m: 97,
  orientation: { frame: 'BODY_FRD', source: 'PNP_TAG_TO_PAD_TO_BODY', valid: true,
    position_body_frd_m: [0, -0.25, 1.2], pad_heading_body_deg: -30 }
});
const read = async raw => (await createUpstreamIntegrations({ uavVisionUrl: 'http://vision.local',
  fetchImpl: async () => new Response(JSON.stringify(raw)) }).telemetry('UAV-01')).vision.relativePose;

test('相对位置使用机载 BODY_FRD 位姿，保留零值和航向符号，不混用光学坐标', async () => {
  const p = await read(sample());
  assert.equal(p.valid, true);
  assert.deepEqual([p.xM, p.yM, p.zM, p.yawDeg], [0, -0.25, 1.2, -30]);
  assert.equal(p.tagId, 1);
  assert.equal(p.ageBasis, 'capture');
  assert.ok(p.ageS >= 0.1);
});

test('未识别、质量拒绝、无效坐标系与旧帧清空相对位置', async () => {
  for (const [mutate, reason] of [
    [s => { s.found = false; }, 'TAG_NOT_DETECTED'],
    [s => { s.quality_passed = false; }, 'QUALITY_REJECTED'],
    [s => { s.orientation.valid = false; }, 'QUALITY_REJECTED'],
    [s => { s.orientation.frame = 'CAMERA_OPTICAL'; }, 'INVALID_POSE'],
    [s => { s.orientation.position_body_frd_m = [0, null, 1]; }, 'INVALID_POSE'],
    [s => { s.orientation.position_body_frd_m[2] = -1; }, 'INVALID_POSE'],
    [s => { s.capture_age_ms = 2100; }, 'STALE_OR_UNKNOWN_AGE'],
    [s => { s.capture_age_ms = -1; }, 'STALE_OR_UNKNOWN_AGE'],
    [s => { s.capture_age_ms = null; }, 'STALE_OR_UNKNOWN_AGE']
  ]) {
    const s = sample(); mutate(s);
    const p = await read(s);
    assert.equal(p.valid, false);
    assert.equal(p.reason, reason);
    assert.deepEqual([p.xM, p.yM, p.zM, p.yawDeg], [null, null, null, null]);
  }
});

test('航向缺失仅清空航向；旧服务可用分析帧龄，但不能用光学坐标冒充机体系', async () => {
  const s = sample(); delete s.capture_age_ms; delete s.orientation.pad_heading_body_deg;
  const p = await read(s);
  assert.equal(p.valid, true);
  assert.equal(p.yawDeg, null);
  assert.equal(p.ageBasis, 'analysis_completion');
  delete s.orientation;
  assert.equal((await read(s)).valid, false);
});
