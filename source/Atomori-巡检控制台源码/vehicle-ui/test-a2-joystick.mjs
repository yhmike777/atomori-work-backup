import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Entirely simulated: no network, browser, or vehicle connection is used.
const source = await readFile(new URL('./a2-joystick.js', import.meta.url), 'utf8');
const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(data = { ok: true }, ok = true) {
  return { ok, json: async () => data };
}

class Element {
  constructor(parent = null) {
    this.parent = parent;
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.textContent = '';
    this.captures = new Set();
    const styles = new Map();
    this.style = {
      setProperty(name, value) { styles.set(name, value); },
      getPropertyValue(name) { return styles.get(name) ?? ''; },
    };
  }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  dispatch(type, values = {}) {
    const event = {
      type, target: this, button: 0, pointerId: 1, repeat: false,
      defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...values,
    };
    let current = this;
    do {
      event.currentTarget = current;
      for (const listener of current.listeners.get(type) || []) listener(event);
      current = event.propagationStopped || type === 'blur' ? null : current.parent;
    } while (current);
    return event;
  }
  getBoundingClientRect() { return { top: 100, height: 174 }; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  focus() {}
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) {
    this.captures.delete(id);
    this.dispatch('lostpointercapture', { pointerId: id });
  }
}

async function harness({ connected = true } = {}) {
  const window = new Element();
  const document = new Element(window);
  const stick = new Element(document);
  const hint = new Element(document);
  const state = new Element(document);
  const stop = new Element(document);
  const elements = { a2Joystick: stick, a2Hint: hint, a2State: state, a2Stop: stop };
  document.getElementById = id => elements[id];
  document.hidden = false;
  let now = 0, nextTimer = 0, nextToken = 0;
  const timers = new Map();
  const calls = [], beacons = [];
  let commandHandler = async () => response();
  let statusHandler = async () => response({ connected });
  function setTimer(callback, delay, repeat = false) {
    const id = ++nextTimer;
    timers.set(id, { callback, at: now + delay, delay, repeat });
    return id;
  }
  const fetch = (url, options = {}) => {
    let handle;
    if (url === '/api/a2/status') handle = statusHandler;
    else {
      assert.equal(url, '/api/a2/gimbal', 'Unexpected network endpoint');
      const command = JSON.parse(options.body);
      calls.push({ ...command, at: now });
      handle = () => commandHandler(command, options);
    }
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('Request aborted'));
      options.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(handle).then(resolve, reject)
        .finally(() => options.signal.removeEventListener('abort', abort));
    });
  };
  const context = vm.createContext({
    document, window, fetch, AbortController, Blob, Uint8Array,
    // Both control and status timeouts use the simulated clock, never wall time.
    AbortSignal: { timeout: delay => {
      const controller = new AbortController();
      setTimer(() => controller.abort(), delay);
      return controller.signal;
    } },
    crypto: { getRandomValues: bytes => { bytes.fill(++nextToken); return bytes; } },
    navigator: { sendBeacon: (url, body) => { beacons.push({ url, body }); return true; } },
    location: { reload() {} },
    setTimeout: (callback, delay) => setTimer(callback, delay),
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => setTimer(callback, delay, true),
    clearInterval: id => timers.delete(id),
  });
  vm.runInContext(source, context, { filename: 'a2-joystick.js' });
  await flush();
  async function advance(milliseconds) {
    const target = now + milliseconds;
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.at;
      if (timer.repeat) timer.at += timer.delay;
      else timers.delete(id);
      timer.callback();
      await flush();
    }
    now = target;
    await flush();
  }
  return {
    stick, hint, state, stop, document, window, calls, beacons, advance,
    actions: () => calls.map(call => call.action),
    position: () => stick.style.getPropertyValue('--stick-y'),
    setCommandHandler: handler => { commandHandler = handler; },
    setStatusHandler: handler => { statusHandler = handler; },
    async pointer(type, y, values = {}) {
      stick.dispatch(type, { clientY: y, ...values });
      await flush();
    },
    async drag(y, startY = 187) {
      stick.dispatch('pointerdown', { clientY: startY });
      stick.dispatch('pointermove', { clientY: y });
      await flush();
    },
  };
}

test('up/down dragging sends the selected direction and stops on release', async () => {
  for (const [y, direction] of [[132, 'up'], [242, 'down']]) {
    const h = await harness();
    await h.drag(y);
    assert.deepEqual(h.actions(), [direction]);
    const position = h.position();
    await h.advance(300);
    assert.deepEqual(h.actions(), [direction, direction, direction]);
    assert.ok(h.calls.every(call => call.press_id === h.calls[0].press_id));
    await h.pointer('pointerup', y);
    assert.equal(h.actions().at(-1), 'stop');
    assert.equal(h.calls.at(-1).press_id, h.calls[0].press_id);
    const stoppedAt = h.calls.length;
    await h.advance(600);
    assert.equal(h.calls.length, stoppedAt, 'Released joystick must not renew movement');
    assert.equal(h.stick.dataset.direction, 'stop');
    assert.equal(h.stick.hasPointerCapture(1), false);
    assert.equal(h.position(), position, 'Release must keep the dragged position');
  }
});

test('grabbing without dragging never moves and small deltas accumulate', async () => {
  const h = await harness();
  await h.pointer('pointerdown', 187);
  await h.pointer('pointermove', 186);
  await h.advance(2500);
  assert.deepEqual(h.actions(), []);
  const position = h.position();
  await h.pointer('pointermove', 185);
  await h.pointer('pointermove', 184);
  assert.equal(h.actions()[0], 'up', 'Slow 1 px movements must eventually start the drag');
  assert.notEqual(h.position(), position);
  await h.pointer('pointerup', 184);
  assert.equal(h.actions().at(-1), 'stop');
});

test('cancel, lost capture, focus loss and hidden document stop while keeping position', async () => {
  const releases = [
    h => h.stick.dispatch('pointercancel'),
    h => h.stick.dispatch('lostpointercapture'),
    h => h.stick.dispatch('blur'),
    h => h.window.dispatch('blur'),
    h => { h.document.hidden = true; h.document.dispatch('visibilitychange'); },
  ];
  for (const release of releases) {
    const h = await harness();
    await h.drag(132);
    const position = h.position();
    release(h);
    await flush();
    assert.deepEqual(h.actions(), ['up', 'stop']);
    assert.equal(h.stick.dataset.direction, 'stop');
    assert.equal(h.position(), position);
    await h.advance(300);
    assert.deepEqual(h.actions(), ['up', 'stop']);
  }
});

test('reversing direction waits for acknowledged stop and uses a new press token', async () => {
  const h = await harness();
  const stopping = deferred();
  await h.drag(132);
  h.setCommandHandler(command => command.action === 'stop' ? stopping.promise : response());
  await h.pointer('pointermove', 242);
  await h.advance(300);
  assert.deepEqual(h.actions(), ['up', 'stop'], 'Down must wait while stop is pending');
  stopping.resolve(response());
  await flush();
  await h.advance(150);
  assert.equal(h.actions().at(-1), 'down');
  assert.notEqual(h.calls[0].press_id, h.calls.at(-1).press_id);
});

test('release during a delayed movement response sends stop after it completes', async () => {
  const h = await harness();
  const movement = deferred();
  h.setCommandHandler(command => command.action === 'up' ? movement.promise : response());
  await h.drag(132);
  await h.pointer('pointerup', 132);
  await h.advance(300);
  assert.deepEqual(h.actions(), ['up']);
  movement.resolve(response());
  await flush();
  assert.deepEqual(h.actions(), ['up', 'stop']);
  await h.advance(300);
  assert.deepEqual(h.actions(), ['up', 'stop']);
});

test('failed stop during direction reversal never allows the new direction through', async () => {
  const h = await harness();
  await h.drag(132);
  h.setCommandHandler(() => { throw new Error('Stop unavailable'); });
  await h.pointer('pointermove', 242);
  await h.advance(1000);
  assert.equal(h.actions()[0], 'up');
  assert.ok(h.actions().slice(1).every(action => action === 'stop'));
  assert.equal(h.stick.dataset.direction, 'stop');
  assert.equal(h.stick.getAttribute('aria-disabled'), 'true');
  const attempts = h.calls.length;
  await h.advance(1000);
  assert.equal(h.calls.length, attempts, 'Failure recovery must not create an unbounded retry loop');
});

test('a release before the first queued request cancels movement before transmission', async () => {
  const h = await harness();
  h.stick.dispatch('pointerdown', { clientY: 187 });
  h.stick.dispatch('pointermove', { clientY: 132 });
  h.stick.dispatch('pointerup', { clientY: 132 });
  await flush();
  assert.deepEqual(h.actions(), ['stop']);
  await h.advance(300);
  assert.deepEqual(h.actions(), ['stop']);
});

test('movement failure or request timeout triggers stop without another movement', async () => {
  for (const failure of ['network', 'rejected', 'timeout']) {
    const h = await harness();
    h.setCommandHandler(command => {
      if (command.action === 'stop') return response();
      if (failure === 'network') throw new Error('Disconnected');
      if (failure === 'rejected') return response({ ok: false, error: 'Rejected' });
      return new Promise(() => {});
    });
    await h.drag(132);
    await h.advance(1500);
    assert.deepEqual(h.actions(), ['up', 'stop']);
    assert.equal(h.stick.dataset.direction, 'stop');
  }
});

test('offline status prevents movement and an explicit disconnection stops an active hold', async () => {
  const offline = await harness({ connected: false });
  await offline.drag(132);
  assert.deepEqual(offline.actions(), []);
  assert.equal(offline.stick.getAttribute('aria-disabled'), 'true');
  const h = await harness();
  await h.drag(132);
  const position = h.position();
  h.setStatusHandler(() => response({ connected: false }));
  await h.advance(1000);
  assert.equal(h.actions().at(-1), 'stop');
  assert.equal(h.stick.getAttribute('aria-disabled'), 'true');
  assert.equal(h.position(), position);
  const stoppedAt = h.calls.length;
  await h.advance(450);
  assert.equal(h.calls.length, stoppedAt);
});

test('failed stop is retried, blocks new movement and allows explicit stop recovery', async () => {
  const h = await harness();
  await h.drag(132);
  h.setCommandHandler(() => { throw new Error('No acknowledgement'); });
  await h.pointer('pointerup', 132);
  assert.deepEqual(h.actions(), ['up', 'stop', 'stop', 'stop']);
  await h.advance(1000);
  assert.equal(h.stick.getAttribute('aria-disabled'), 'true', 'Healthy status cannot clear an unacknowledged stop');
  await h.drag(242);
  assert.deepEqual(h.actions(), ['up', 'stop', 'stop', 'stop']);
  h.setCommandHandler(() => response());
  h.stop.onclick();
  await flush();
  assert.equal(h.stick.getAttribute('aria-disabled'), 'false');
  await h.drag(242);
  assert.equal(h.actions().at(-1), 'down');
});

test('joystick key controls cannot reach the vehicle keydown listener', async () => {
  const h = await harness();
  const vehicleKeys = [];
  h.document.addEventListener('keydown', event => vehicleKeys.push(event.key));
  h.stick.dispatch('keydown', { key: 'ArrowUp' });
  await flush();
  assert.deepEqual(h.actions(), ['up']);
  assert.equal(h.stick.getAttribute('aria-valuenow'), '12');
  h.stick.dispatch('keydown', { key: 'ArrowUp', repeat: true });
  h.stick.dispatch('keyup', { key: 'ArrowUp' });
  await flush();
  assert.deepEqual(h.actions(), ['up', 'stop']);
  assert.equal(h.stick.getAttribute('aria-valuenow'), '24');
  for (const key of ['w', 'a', 's', 'd', 'ArrowLeft', 'ArrowRight', 'Escape', ' ', 'Enter']) {
    h.stick.dispatch('keydown', { key });
  }
  await flush();
  assert.deepEqual(vehicleKeys, [], 'Focused joystick must not drive the vehicle');
  h.stick.dispatch('keydown', { key: 'ArrowDown' });
  await flush();
  h.stick.dispatch('keydown', { key: 'Escape' });
  await flush();
  assert.deepEqual(h.actions(), ['up', 'stop', 'down', 'stop']);
});

test('page exit sends an immediate stop beacon and prevents later movement renewals', async () => {
  const h = await harness();
  await h.drag(132);
  h.window.dispatch('pagehide');
  await flush();
  assert.equal(h.beacons.length, 1);
  assert.equal(h.beacons[0].url, '/api/a2/gimbal');
  const beacon = JSON.parse(await h.beacons[0].body.text());
  assert.equal(beacon.action, 'stop');
  assert.equal(beacon.press_id, h.calls[0].press_id);
  assert.deepEqual(h.actions(), ['up', 'stop']);
  await h.advance(2000);
  assert.deepEqual(h.actions(), ['up', 'stop']);
});

test('a healthy 12 second hold continuously renews without any automatic release', async () => {
  const h = await harness();
  await h.drag(160);
  const position = h.position();
  await h.advance(12000);
  assert.equal(h.calls.length, 81);
  assert.ok(h.calls.every(call => call.action === 'up'));
  assert.equal(new Set(h.calls.map(call => call.press_id)).size, 1);
  assert.equal(h.stick.hasPointerCapture(1), true);
  assert.equal(h.stick.dataset.direction, 'up');
  assert.equal(h.position(), position);
  await h.pointer('pointerup', 160);
  assert.equal(h.actions().at(-1), 'stop');
  assert.equal(h.position(), position);
});

test('one failed status request does not interrupt healthy movement and polling recovers', async () => {
  const h = await harness();
  await h.drag(160);
  let attempts = 0;
  h.setStatusHandler(() => {
    if (++attempts === 1) throw new Error('Temporary status failure');
    return response({ connected: true });
  });
  await h.advance(3000);
  assert.ok(attempts >= 2);
  assert.equal(h.calls.length, 21);
  assert.ok(h.calls.every(call => call.action === 'up'));
  assert.equal(h.stick.getAttribute('aria-disabled'), 'false');
  assert.match(h.state.textContent, /已连接/);
});

test('repeated status failures or 2 second timeouts do not interrupt healthy command renewals', async () => {
  for (const failure of ['network', 'timeout', 'http', 'missing-connected']) {
    const h = await harness();
    await h.drag(160);
    let attempts = 0;
    h.setStatusHandler(() => {
      attempts++;
      if (failure === 'network') throw new Error('Status unavailable');
      if (failure === 'http') return response({ error: 'Server error' }, false);
      if (failure === 'missing-connected') return response({});
      return new Promise(() => {});
    });
    await h.advance(12000);
    assert.ok(attempts >= 3, 'Status checks must continue after failures');
    assert.equal(h.calls.length, 81);
    assert.ok(h.calls.every(call => call.action === 'up'));
    assert.equal(h.stick.dataset.direction, 'up');
    assert.equal(h.stick.hasPointerCapture(1), true);
    assert.equal(h.stick.getAttribute('aria-disabled'), 'false');
    await h.pointer('pointerup', 160);
    assert.equal(h.actions().at(-1), 'stop');
  }
});

test('control failure still stops movement while status reads are failing', async () => {
  const h = await harness();
  await h.drag(160);
  h.setStatusHandler(() => { throw new Error('Status unavailable'); });
  await h.advance(1200);
  h.setCommandHandler(command => command.action === 'stop' ? response() : response({ ok: false }));
  await h.advance(150);
  assert.equal(h.actions().at(-1), 'stop');
  assert.equal(h.stick.dataset.direction, 'stop');
  const stoppedAt = h.calls.length;
  await h.advance(3000);
  assert.equal(h.calls.length, stoppedAt);
});

test('released position stays fixed when regrabbed and a downward drag above center moves down', async () => {
  const h = await harness();
  await h.drag(132);
  await h.pointer('pointerup', 132);
  const position = h.position();
  const stoppedAt = h.calls.length;
  assert.equal(h.stick.getAttribute('aria-valuenow'), '100');
  await h.pointer('pointerdown', 132);
  await h.advance(450);
  assert.equal(h.position(), position, 'Regrabbing must not jump the handle');
  assert.equal(h.calls.length, stoppedAt, 'Regrabbing alone must not move the camera');
  await h.pointer('pointermove', 143);
  assert.equal(h.actions().at(-1), 'down');
  assert.equal(h.stick.getAttribute('aria-valuenow'), '80');
  await h.pointer('pointerup', 143);
  assert.equal(h.stick.getAttribute('aria-valuenow'), '80');
  assert.equal(h.stick.dataset.direction, 'stop');
  assert.match(h.stick.getAttribute('aria-valuetext'), /已停止/);
});

test('reaching the rail endpoint does not end a hold and reversing has no overscroll dead distance', async () => {
  const h = await harness();
  await h.drag(50);
  assert.equal(h.stick.getAttribute('aria-valuenow'), '100');
  await h.advance(3000);
  assert.ok(h.calls.every(call => call.action === 'up'));
  await h.pointer('pointermove', 20);
  assert.equal(h.stick.getAttribute('aria-valuenow'), '100');
  await h.advance(150);
  assert.ok(h.calls.every(call => call.action === 'up'));
  await h.pointer('pointermove', 23);
  assert.equal(h.actions().at(-2), 'stop');
  assert.equal(h.actions().at(-1), 'down');
  assert.ok(Number(h.stick.getAttribute('aria-valuenow')) < 100);
});

test('an idle status failure disables new gestures until a healthy status is received', async () => {
  const h = await harness();
  h.setStatusHandler(() => { throw new Error('Status unavailable'); });
  await h.advance(1000);
  await h.drag(132);
  assert.deepEqual(h.actions(), []);
  assert.equal(h.stick.getAttribute('aria-disabled'), 'true');
  h.setStatusHandler(() => response({ connected: true }));
  await h.advance(1000);
  await h.drag(132);
  assert.deepEqual(h.actions(), ['up']);
});
