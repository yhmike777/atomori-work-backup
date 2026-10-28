import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SingleHandGestures, SINGLE_GESTURE_MIN_SCORE } from '../gesture/gesture-gate.js';
import { PalmMotion } from '../gesture/palm-motion.js';
import { TwoHandMotion } from '../gesture/two-hand-motion.js';
import { inspectHand, inspectTwoHands } from '../gesture/hand-pose.js';

// Exercise the production controller; only the browser and model-loading boundary are faked.
const source = readFileSync(new URL('../gesture/control.js', import.meta.url), 'utf8')
  .replace(/^import .+;\r?\n/gm, '').replace('export function setupGestures', 'function setupGestures')
  .replace('import(/* @vite-ignore */ moduleUrl)', 'loadVision(moduleUrl)');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function target(extra = {}) {
  const listeners = new Map();
  return { ...extra, addEventListener(name, callback) { const list = listeners.get(name) || []; list.push(callback); listeners.set(name, list); },
    async emit(name) { for (const callback of listeners.get(name) || []) await callback(); },
    setAttribute(name, value) { this[name] = value; } };
}
function harness({ media, play, create } = {}) {
  const track = target({ stops: 0, stop() { this.stops++; } });
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  let result = {landmarks:[]}, now = 1000, nextFrame;
  const expansions=[], rotations=[];
  const recognizer = { closes: 0, close() { this.closes++; }, recognizeForVideo() { return result; } };
  const video = target({ hidden: true, readyState: 0, play: play || (() => Promise.resolve()), pause() {} });
  const button = target(), status = target(), panel = target({ open: true, scrollIntoView() {} });
  const document = target({ baseURI: 'http://localhost:3003/assets/product-viewer/index.html', hidden: false,
    getElementById: id => ({ 'camera-video': video, 'camera-toggle': button, 'camera-status': status, 'gesture-panel': panel })[id] });
  const window = target();
  let loads = 0, frames = 0;
  const context = { SingleHandGestures, SINGLE_GESTURE_MIN_SCORE, PalmMotion, TwoHandMotion, inspectHand, inspectTwoHands, URL,
    document, window, navigator: { mediaDevices: { getUserMedia: media || (() => Promise.resolve(stream)) } },
    performance: { now: () => now }, requestAnimationFrame: callback => {nextFrame=callback;return ++frames;}, cancelAnimationFrame() {},
    expand: value=>expansions.push(value), rotate: (...args)=>rotations.push(args),
    loadVision: async () => { loads++; return { FilesetResolver: { forVisionTasks: async () => ({}) }, GestureRecognizer: { createFromOptions: create || (() => Promise.resolve(recognizer)) } }; } };
  vm.runInNewContext(source + '\nsetupGestures({ expand, rotate, zoom() {}, ready: () => true });', context);
  return { track, stream, recognizer, video, button, status, panel, window, context, expansions, rotations,
    tick(time, sample) { now=time;result=sample;Object.assign(video,{readyState:4,videoWidth:640,videoHeight:480,currentTime:time/1000});nextFrame(); },
    get loads() { return loads; }, get frames() { return frames; } };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

{
  const h = harness();
  await h.button.emit('click');
  assert.equal(h.button['aria-pressed'], 'true');
  assert.equal(h.video.hidden, false);
  assert.equal(h.frames, 1);
  await h.button.emit('click');
  assert.equal(h.track.stops, 1);
  assert.equal(h.video.srcObject, null);
  assert.equal(h.recognizer.closes, 0, 'normal close retains the locally loaded recognizer for reuse');
  await h.window.emit('pagehide');
  assert.equal(h.recognizer.closes, 1, 'leaving the page releases the recognizer too');
}
{
  const permission = deferred();
  const h = harness({ media: () => permission.promise });
  const starting = h.button.emit('click');
  await h.window.emit('pagehide');
  permission.resolve(h.stream); await starting;
  assert.equal(h.track.stops, 1, 'late permission cannot keep a camera active after navigation');
  assert.equal(h.loads, 0);
  assert.equal(h.video.hidden, true);
}
{
  const playing = deferred();
  const h = harness({ play: () => playing.promise });
  const starting = h.button.emit('click'); await flush();
  h.panel.open = false; await h.panel.emit('toggle');
  playing.resolve(); await starting;
  assert.equal(h.track.stops, 1);
  assert.equal(h.loads, 0, 'closing the panel during video startup must not start model loading');
  assert.equal(h.video.hidden, true);
}
{
  const loading = deferred();
  const h = harness({ create: () => loading.promise });
  const starting = h.button.emit('click'); await flush();
  assert.equal(h.loads, 1);
  await h.window.emit('pagehide');
  loading.resolve(h.recognizer); await starting;
  assert.equal(h.recognizer.closes, 1, 'a recognizer resolving after exit must be released');
  assert.equal(h.frames, 0);
  assert.equal(h.video.hidden, true);
}
{
  const h = harness(); await h.button.emit('click');
  await h.track.emit('ended');
  assert.equal(h.video.hidden, true);
  assert.match(h.status.textContent, /连接已结束/);
}
{
  const h = harness({ media: async () => { const error = new Error(); error.name = 'NotAllowedError'; throw error; } });
  await h.button.emit('click');
  assert.match(h.status.textContent, /未获得摄像头权限/);
  assert.equal(h.button.disabled, false);
  assert.equal(h.loads, 0);
}
console.log('PASS: camera start/stop, permission cancellation, video startup cancellation, late model disposal, unplug and denied permission.');
{
  const h=harness();await h.button.emit('click');
  function sample(name, offset=0) {
    const points=Array.from({length:21},()=>({x:.4+offset,y:.5,z:0}));
    points[0]={x:.2+offset,y:.5,z:0};points[5].y=.4;points[17].y=.6;
    return {landmarks:[points],handedness:[[{categoryName:'Left',score:.9}]],gestures:[[{categoryName:name,score:.45}]]};
  }
  h.tick(1100,sample('Closed_Fist'));h.tick(1220,sample('Closed_Fist'));
  assert.deepEqual(h.expansions,[],'initial fist is only a baseline');
  h.tick(1300,sample('Open_Palm'));h.tick(1420,sample('Open_Palm'));
  assert.deepEqual(h.expansions,[1],'runtime uses tracked landmarks, not upright, for expansion');
  assert.match(h.status.textContent,/已展开/);
  h.tick(1540,sample('Open_Palm',.05));h.tick(1660,sample('Open_Palm',.1));
  assert.deepEqual(h.rotations,[],'sideways palm expansion cannot accidentally rotate the model');
  assert.deepEqual(h.expansions,[1],'held palm does not repeat expansion');
  h.tick(1800,sample('Closed_Fist'));h.tick(1920,sample('Closed_Fist'));
  assert.deepEqual(h.expansions,[1,0]);
  await h.button.emit('click');
}
console.log('PASS: runtime sideways fist/palm at 45% expands/restores without rotation or repeat triggers.');
