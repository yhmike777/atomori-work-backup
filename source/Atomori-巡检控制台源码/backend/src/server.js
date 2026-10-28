import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createApp } from './app.js';
import { RecordStore } from './store.js';
import { createUpstreamIntegrations } from './upstream.js';

const directory = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(directory, '../..');
const dataFile = resolve(process.env.ATOMORI_DATA_FILE || resolve(directory, '../data/records.json'));
const port = Number(process.env.PORT || 3000);
const host = process.env.ATOMORI_LISTEN_ADDRESS || '127.0.0.1';
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 必须为 0–65535 的整数');

const store = new RecordStore(dataFile);
await store.init();
const integrations = createUpstreamIntegrations({ carUrl: process.env.ATOMORI_CAR_URL, uavVideoUrl: process.env.ATOMORI_UAV_VIDEO_URL, uavVisionUrl: process.env.ATOMORI_UAV_VISION_URL, uavFlightUrl: process.env.ATOMORI_UAV_FLIGHT_URL, missionPlannerUrl: process.env.ATOMORI_MISSION_PLANNER_URL, liveOnly: process.env.ATOMORI_LIVE_ONLY === 'true' });
const server = createServer(createApp({ store, webRoot, integrations }));
server.listen(port, host, () => {
  console.log(`Atomori API: http://${host}:${server.address().port}/`);
});
