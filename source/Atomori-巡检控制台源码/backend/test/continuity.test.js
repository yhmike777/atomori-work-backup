import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../../marp/continuity.js', import.meta.url), 'utf8');

test('display cache retains zero, ages through outages, accepts recovery and isolates sources', () => {
  const context = { window: {} }; vm.runInNewContext(source, context);
  const read = context.window.AtomoriContinuity.createReadings();
  assert.equal(read('pi:roll', null, 0, 0).value, null);
  assert.equal(read('pi:roll', { value: 0, valid: true, ageS: .1, maxAgeS: .5 }, 0, 100).value, 0);
  const retained = read('pi:roll', { value: null, valid: false }, 0, 60100);
  assert.equal(retained.value, 0); assert.equal(retained.retained, true); assert.equal(retained.ageS, 60.1);
  assert.equal(read('pi:roll', { value: 3, valid: false, ageS: 0, maxAgeS: .5 }, 0, 60200).value, 0, 'invalid values cannot overwrite');
  assert.equal(read('mp:roll', null, 0, 60200).value, null, 'different source cannot reuse cached data');
  assert.equal(read('pi:roll', { value: 2, valid: true, ageS: .1, maxAgeS: .5 }, 0, 60300).retained, false);
  assert.equal(read('pi:roll', { lastValid: { value: 1, ageS: 100 } }, 0, 60400).value, 2, 'late older sample cannot regress');
  const delayed = read('pi:gyro', { valid: false, lastValid: { value: .2, ageS: 3, unit: 'rad/s' } }, .5, 60400);
  assert.equal(delayed.value, .2); assert.equal(delayed.ageS, 3.5); assert.equal(delayed.valid, false);
});

test('complete video frame survives errors and reconnect, source change clears it, timer is disposed', () => {
  let tick, cleared = false;
  const createCanvas = () => {
    const canvas = { width: 300, height: 150, hidden: false, frame: null, setAttribute() {}, remove() {} };
    canvas.getContext = () => ({ drawImage(image) { if (image.bad) throw Error('decode failure'); canvas.frame = image.frame; } });
    return canvas;
  };
  const context = { window: {}, document: { hidden: false, createElement: createCanvas, getElementById: () => null },
    setInterval: fn => { tick = fn; return 1; }, clearInterval: () => { cleared = true; } };
  vm.runInNewContext(source, context);
  let output;
  const listeners = {};
  const image = { src: 'http://test/a8', currentSrc: 'http://test/a8', addEventListener(name, fn) { listeners[name] = fn; }, removeEventListener(name) { delete listeners[name]; }, style: {}, naturalWidth: 640, naturalHeight: 360, frame: 'first', after(canvas) { output = canvas; } };
  const video = context.window.AtomoriContinuity.video(image);
  video.start('a8'); listeners.load(); tick(); assert.equal(output.frame, 'first'); assert.equal(video.hasFrame, true);
  image.bad = true; image.naturalWidth = 800; tick();
  assert.equal(output.width, 640); assert.equal(output.frame, 'first', 'failed resize must not blank the last frame');
  video.hold(); image.bad = false; image.frame = 'late'; tick(); assert.equal(output.frame, 'first');
  video.start('a8'); listeners.load(); image.frame = 'recovered'; tick(); assert.equal(output.frame, 'recovered');
  image.src = 'http://test/down'; video.start('down');
  tick(); listeners.load(); tick();
  assert.equal(output.hidden, true); assert.equal(video.hasFrame, false, 'old decoded resource cannot cross the camera boundary');
  image.currentSrc = image.src; image.frame = 'down'; listeners.load(); tick(); assert.equal(output.frame, 'down');
  video.dispose(); assert.equal(cleared, true);
});
