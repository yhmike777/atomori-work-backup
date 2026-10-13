import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpstreamIntegrations } from '../src/upstream.js';

test('Mission Planner 使用专用来源，未收到数据时不回退到树莓派或演示值', async () => {
  const waiting = { deviceId: 'UAV-01', source: 'mission-planner-mavlink', flight: { connected: false, metrics: {} } };
  const integrations = createUpstreamIntegrations({ missionPlannerUrl: 'http://mirror', fetchImpl: async () => Response.json(waiting) });
  assert.equal(integrations.status().missionPlannerConfigured, true);
  assert.equal(integrations.status().commandsEnabled, false);
  assert.deepEqual(await integrations.missionPlanner(), waiting);
  await assert.rejects(createUpstreamIntegrations({ uavFlightUrl: 'http://pi' }).missionPlanner(), /尚未配置/);
  const invalid = createUpstreamIntegrations({ missionPlannerUrl: 'http://mirror', fetchImpl: async () => Response.json({ ...waiting, source: 'uav-rpi-deploy' }) });
  await assert.rejects(invalid.missionPlanner(), /响应无效/);
});
