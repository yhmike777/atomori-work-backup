(function () {
  'use strict';
  const stick = document.getElementById('a2Joystick');
  const hint = document.getElementById('a2Hint');
  const state = document.getElementById('a2State');
  const stopButton = document.getElementById('a2Stop');
  let held = null, timer = null, pointer = null, key = null;
  let position = 0, pointerY = 0;
  let live = false, blocked = false, busy = false, closed = false;
  let queue = Promise.resolve(), statusTimer = null;
  const idleHint = '上下拖动 · 松手停转，滑块保留位置';

  async function post(action, token) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch('/api/a2/gimbal', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action, press_id:token, speed:20}),
        signal:controller.signal, keepalive:action === 'stop'
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw Error(result.error || '云台未确认指令');
    } finally { clearTimeout(timeout); }
  }
  function visual(value = position) {
    position = Math.max(-1, Math.min(1, value));
    const travel = Math.max(1, (stick.getBoundingClientRect().height - 64) / 2);
    stick.style.setProperty('--stick-y', `${-position * travel}px`);
    stick.style.setProperty('--travel-size', `${Math.abs(position * travel)}px`);
    stick.style.setProperty('--travel-start', `calc(50% - ${Math.max(0, position * travel)}px)`);
    stick.setAttribute('aria-valuenow', String(Math.round(position * 100)));
    const action = held ? (held.dir === 'up' ? '向上转动' : '向下转动') : '已停止';
    stick.setAttribute('aria-valuetext', `${action}，滑块位置 ${Math.round(position * 100)}%`);
    stick.dataset.direction = held?.dir || 'stop';
  }
  function enqueueStop(token) {
    queue = queue.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await post('stop', token);
          blocked = false;
          stick.setAttribute('aria-disabled', String(!live));
          if (!held) hint.textContent = '已停止 · ' + idleHint;
          return;
        } catch (_) {
          blocked = true;
          stick.setAttribute('aria-disabled', 'true');
          hint.textContent = attempt < 2 ? '停止未确认，正在重试…' : '停止未确认，请检查连接后点击停止云台';
        }
      }
      release();
    });
  }
  function releaseHold() {
    clearInterval(timer); timer = null;
    if (!held) return;
    const current = held; held = null;
    hint.textContent = '正在停止云台…';
    enqueueStop(current.id);
  }
  function release() {
    const previousPointer = pointer;
    pointer = null; key = null;
    releaseHold(); visual();
    if (previousPointer !== null && stick.hasPointerCapture(previousPointer)) stick.releasePointerCapture(previousPointer);
  }
  function tick() {
    if (!held || busy || blocked || closed) return;
    const current = held; busy = true;
    queue = queue.then(async () => {
      if (held !== current || !live || blocked || closed) return;
      try {
        await post(current.dir, current.id);
        if (held === current) hint.textContent = (current.dir === 'up' ? '向上转动' : '向下转动') + ' · 松手即停';
      } catch (error) {
        blocked = true; stick.setAttribute('aria-disabled', 'true'); release();
        hint.textContent = (error.name === 'AbortError' ? '控制请求超时' : '转动未确认') + '，正在发送停止…';
      }
    }).finally(() => { busy = false; });
  }
  function move(direction, value) {
    if (!live || blocked || closed) return;
    visual(value);
    if (held?.dir === direction) return;
    releaseHold();
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2,'0')).join('');
    held = {id, dir:direction};
    visual();
    tick(); timer = setInterval(tick, 150);
  }
  function movePointer(event) {
    const delta = pointerY - event.clientY;
    if (!Number.isFinite(delta) || Math.abs(delta) < 2) return;
    pointerY = event.clientY;
    const rect = stick.getBoundingClientRect();
    move(delta > 0 ? 'up' : 'down', position + delta / Math.max(1, (rect.height - 64) / 2));
  }
  stick.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointer !== null || key !== null || !live || blocked) return;
    event.preventDefault(); stick.focus(); pointer = event.pointerId;
    pointerY = event.clientY;
    stick.setPointerCapture(pointer);
  });
  stick.addEventListener('pointermove', event => {
    if (event.pointerId === pointer) { event.preventDefault(); movePointer(event); }
  });
  ['pointerup','pointercancel','lostpointercapture'].forEach(name => stick.addEventListener(name, event => {
    if (event.pointerId === pointer) release();
  }));
  stick.addEventListener('keydown', event => {
    // Do not let rover WASD/arrow shortcuts receive presses while the camera stick owns focus.
    event.stopPropagation();
    if (!['ArrowUp','ArrowDown','Escape',' ','Enter'].includes(event.key)) return;
    event.preventDefault();
    if (['Escape',' ','Enter'].includes(event.key)) { release(); return; }
    if (pointer !== null || !live || blocked) return;
    key = event.key;
    move(key === 'ArrowUp' ? 'up' : 'down', position + (key === 'ArrowUp' ? .12 : -.12));
  });
  stick.addEventListener('keyup', event => {
    if (!['ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === key) release();
  });
  stick.addEventListener('blur', release);
  stick.addEventListener('contextmenu', event => event.preventDefault());
  stopButton.onclick = () => { release(); enqueueStop(''); };
  async function status() {
    try {
      const response = await fetch('/api/a2/status', {signal:AbortSignal.timeout(2000)});
      if (!response.ok) throw Error('状态读取失败');
      const data = await response.json();
      if (typeof data?.connected !== 'boolean') throw Error('状态数据不完整');
      if (closed) return;
      live = data.connected;
      state.textContent = live ? '云台已连接 · 上下俯仰' : data.error || '云台未连接';
    } catch (_) {
      if (closed) return;
      // A slow status GET must not cancel a healthy, continuously renewed drag.
      // Command failures and the server's renewable lease still stop motion.
      if (held) state.textContent = '状态读取延迟 · 正在续发控制指令';
      else { live = false; state.textContent = '云台连接暂不可用'; }
    }
    stick.setAttribute('aria-disabled', String(!live || blocked));
    if (!live) release();
    if (!closed) statusTimer = setTimeout(status, 1000);
  }
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
  window.addEventListener('pagehide', () => {
    closed = true; clearTimeout(statusTimer);
    if (held) navigator.sendBeacon('/api/a2/gimbal', new Blob([
      JSON.stringify({action:'stop', press_id:held.id, speed:20})
    ], {type:'application/json'}));
    release();
  });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  status();
})();
