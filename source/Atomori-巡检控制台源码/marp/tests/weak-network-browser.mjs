import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const [base, modules, screenshot] = process.argv.slice(2);
const require = createRequire(import.meta.url), { chromium } = require(join(modules, 'playwright'));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1560, height: 1080 } });
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
let outage = false, recovered = false, bytes = 0;
const m = value => ({ value, valid: true, ageS: .02, maxAgeS: .5, unit: 'deg', source: 'fixture' });
const digital = () => ({ valid: true, available: true, triggered: false, ageS: .02, maxAgeS: 2 });
const analog = ppm => ({ valid: true, ageS: .02, maxAgeS: 2, voltageV: 1, referenceEstimate: { valid: true, ppm } });
try {
  const jpeg = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width=64;c.height=36;const x=c.getContext('2d');x.fillStyle='#286880';x.fillRect(0,0,64,36);return c.toDataURL('image/jpeg').split(',')[1]; }), 'base64');
  await page.route('**/assets/product-viewer/**', route => route.fulfill({ contentType: 'text/html', body: '<p>三维模型（隔离测试）</p>' }));
  await page.route('**/api/v1/integrations', route => route.fulfill({ json: { data: { mode:'upstream-readonly', carConfigured:true, uavFlightConfigured:true, uavVideoConfigured:true, uavFlightSource:'raspberry-pi', liveOnly:true } } }));
  await page.route('**/api/v1/devices/**', async route => {
    const url = new URL(route.request().url());
    if (outage) return route.abort('connectionfailed');
    if (url.pathname.includes('/cameras/')) return route.fulfill({ contentType:'image/jpeg',body:jpeg });
    if (url.pathname.endsWith('/streams')) {
      const ids = await page.locator('#main-camera,#ground-camera').evaluateAll(images => images.map(x=>x.getAttribute('src')).filter(Boolean));
      return route.fulfill({ json:{data:{streamHealth:ids.map(src=>({clientId:new URL(src,'http://test').searchParams.get('clientId'),cameraId:src.includes('UAV')?'a8.mjpg':'front.mjpg',active:true,idleAgeMs:0,lastDataAt:new Date().toISOString(),receivedBytes:++bytes*100,frameReceivedAtMs:Date.now()}))}} });
    }
    if (url.pathname.includes('UAV-01/telemetry')) return route.fulfill({json:{data:{deviceId:'UAV-01',sourceIdentity:'fixture-pi',source:'uav-rpi-deploy',normalizedAt:new Date().toISOString(),flight:{connected:true,stateAgeS:.02,mode:'STABILIZE',armed:false,metrics:{roll:m(recovered?8:4),pitch:m(2),batteryPercent:m(recovered?70:75),batteryVoltage:m(12.1)},rollDeg:recovered?8:4,pitchDeg:2,batteryPercent:75,batteryVoltage:12.1}}}});
    if (url.pathname.includes('UGV-01/telemetry')) return route.fulfill({json:{data:{deviceId:'UGV-01',sourceIdentity:'fixture-car',receivedAt:new Date().toISOString(),snapshotAgeS:0,snapshotMaxAgeS:3,gateway:{uptime_s:100},metrics:{speed:m(0),temperature:m(25),humidity:m(48)},odom:{pose:[0,0,0],ageS:.02},camera:{ready:true,age_s:.02},environment:{digital:{flame:digital()},sensors:{smoke:{digital:digital(),analog:analog(38487)},carbonMonoxide:{digital:digital(),analog:analog(21.4)},flame:{digital:digital()},sound:{digital:digital()}}}}}});
    return route.fulfill({json:{data:{}}});
  });
  await page.goto(base+'/marp/'+encodeURIComponent('巡检控制台')+'.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('#uav-roll').textContent==='4.0°' && [...document.querySelectorAll('.retained-video')].every(c=>!c.hidden));
  const read = () => page.evaluate(()=>({ values:[...document.querySelectorAll('.metric-grid strong')].map(x=>x.textContent),roll:document.querySelector('#uav-roll').textContent,sensors:[...document.querySelectorAll('.environment-grid b')].map(x=>x.textContent), frames:[...document.querySelectorAll('.retained-video')].map(x=>({hidden:x.hidden,pixels:x.toDataURL()})),online:document.querySelector('#uav-connection').textContent }));
  const before=await read(); outage=true;
  await page.waitForTimeout(10000);
  const frozen=await read();
  assert.deepEqual(frozen.values,before.values,'all received numeric values survive network loss');
  assert.equal(frozen.roll,before.roll);assert.deepEqual(frozen.sensors,before.sensors,'sensor summaries retain values');
  assert.deepEqual(frozen.frames,before.frames,'both complete frame buffers remain visible and unchanged');
  assert.notEqual(frozen.online,'在线','retained data must not claim online');
  if(screenshot) await page.screenshot({path:screenshot});
  outage=false; recovered=true;
  await page.waitForFunction(()=>document.querySelector('#uav-roll').textContent==='8.0°',null,{timeout:15000});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS: both devices retain numbers, sensors and complete frames through 10s outage; recover automatically',before:{...before,frames:before.frames.map(x=>({hidden:x.hidden}))},frozen:{...frozen,frames:frozen.frames.map(x=>({hidden:x.hidden}))},errors}));
} finally { await browser.close(); }
