// Isolated local verification fixture. Never used by the production startup script.
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { createUpstreamIntegrations } from '../src/upstream.js';
import { RecordStore } from '../src/store.js';

const media = process.env.ATOMORI_FIXTURE_MEDIA;
if (!media) throw new Error('Set ATOMORI_FIXTURE_MEDIA to an isolated test-image directory.');
const images = Object.fromEntries(await Promise.all(['front.jpg','rear.jpg','top.jpg','map.png'].map(async name => [name, await readFile(join(media,name))])));
let profile = 'fresh';
const age = () => profile === 'stale' ? 20 : 0.01;
const json = (res, data) => { res.setHeader('content-type','application/json'); res.end(JSON.stringify(data)); };
async function listen(handler, port=0) {
  const server = createServer(handler);
  await new Promise(done => server.listen(port,'127.0.0.1',done));
  return `http://127.0.0.1:${server.address().port}`;
}
function device(kind) { return (req,res) => {
  if (profile === 'offline') { res.writeHead(503); return res.end(); }
  if (req.url === '/api/status') {
    if (kind === 'car') return json(res, {
      server_time_ms:Date.now(), odom:{pose:[1,2,0],speed_mps:0.27},topic_ages_s:{odom:age()},
      camera:{ready:true,age_s:age()},camera_rear:{ready:true,age_s:age()},camera_top:{ready:true},
      map:{age_s:age()},localization:{age_s:age(),pose:[1,2,0],localized:true},
      environment:{available:true,stale:false,age_s:age(),temperature_c:21.6,humidity_percent:47.2,
        digital:Object.fromEntries(['sound','flame','mq2'].map(key=>[key,{available:true,stale:false,age_s:age(),triggered:false}]))}
    });
    if (kind === 'vision') return json(res, {sensor:'ov9281',mode:'apriltag',frame_age_ms:age()*1000,capture_age_ms:age()*1000,capture_fps:30,found:true,tag_id:1,quality_passed:true,
      orientation:{valid:true,frame:'BODY_FRD',source:'PNP_TAG_TO_PAD_TO_BODY',position_body_frd_m:[0.1,0.05,1.8],pad_heading_body_deg:0.6}});
    const values={roll_deg:[0.2,'deg'],pitch_deg:[-0.8,'deg'],battery_voltage_v:[23.9,'V'],battery_remaining_pct:[73,'%'],rangefinder_m:[1.23,'m']};
    return json(res,{flight_controller_connected:true,vehicle_state_age_s:age(),mode:'GUIDED',armed:false,
      telemetry:Object.fromEntries(Object.entries(values).map(([key,[value]])=>[key,value])),
      telemetry_meta:Object.fromEntries(Object.entries(values).map(([key,[,unit]])=>[key,{valid:true,age_s:age(),unit}]))});
  }
  const camera = {'/api/camera.jpg':'front.jpg','/api/camera_rear.jpg':'rear.jpg','/api/top_camera.jpg':'top.jpg'}[req.url];
  if(camera){res.setHeader('content-type','image/jpeg');return res.end(images[camera]);}
  if(req.url==='/api/map.png'){res.setHeader('content-type','image/png');return res.end(images['map.png']);}
  if(req.url==='/api/scan.json')return json(res,{age_s:age(),points:[[0,2],[45,1],[90,1.5]],range_max:10});
  if(req.url==='/api/maps')return json(res,{maps:[]});
  if(req.url.endsWith('/status'))return json(res,{});
  res.writeHead(503);res.end();
};}
const [carUrl,uavVisionUrl,uavFlightUrl] = await Promise.all(['car','vision','flight'].map(kind=>listen(device(kind))));
const directory=await mkdtemp(join(tmpdir(),'atomori-live-fixture-'));
const store=new RecordStore(join(directory,'records.json'));await store.init();
const integrations=createUpstreamIntegrations({carUrl,uavVisionUrl,uavFlightUrl,liveOnly:true});
const webRoot=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const app=createApp({store,webRoot,integrations});
await listen((req,res)=>{
  if(req.method==='POST' && req.url.startsWith('/__fixture/')){
    const next=req.url.slice('/__fixture/'.length);
    if(!['fresh','stale','offline'].includes(next)){res.writeHead(400);return res.end();}
    profile=next;return json(res,{profile});
  }
  app(req,res);
},3100);
console.log('Isolated fixture: http://127.0.0.1:3100/ (not real hardware)');
