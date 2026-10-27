'use strict';

// Display-only runtime estimate. This never changes the vehicle's battery telemetry.
window.AtomoriUgvBattery = (() => {
  const DURATION_MS = 4 * 60 * 60 * 1000;
  const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const nullableNumber = value => value === null || finite(value);
  const validState = value => value && value.version === 1
    && ['startedAtMs', 'elapsedMs', 'lastClockMs', 'lastCheckMs', 'lastSampleAtMs'].every(key => finite(value[key]))
    && typeof value.lastSampleId === 'string'
    && nullableNumber(value.offlineSinceMs) && typeof value.offlineConfirmed === 'boolean'
    && nullableNumber(value.lastUptimeS) && nullableNumber(value.lastUptimeAtMs);

  function create(options = {}) {
    const durationMs = finite(options.durationMs) && options.durationMs > 0 ? options.durationMs : DURATION_MS;
    const disconnectGraceMs = finite(options.disconnectGraceMs) && options.disconnectGraceMs > 0 ? options.disconnectGraceMs : 30000;
    // A suspended/closed tab cannot establish that the vehicle was continuously offline.
    const observationGapMs = Math.min(5000, disconnectGraceMs);
    const key = options.key || 'atomori:ugv-battery:UGV-01';
    let storage = options.storage;
    if (storage === undefined) {
      try { storage = window.localStorage; } catch { storage = null; }
    }
    let memory = null;

    const read = () => {
      try {
        const saved = JSON.parse(storage?.getItem(key) || 'null');
        if (validState(saved)) memory = saved;
      } catch { /* Keep the current in-memory session if storage is unavailable/corrupt. */ }
      return memory ? { ...memory } : null;
    };
    const save = state => {
      memory = state;
      try { storage?.setItem(key, JSON.stringify(state)); } catch { /* Private mode/quota: memory still works. */ }
    };
    const begin = (nowMs, sampleId, sampleAtMs, uptimeS) => ({
      version: 1, startedAtMs: nowMs, elapsedMs: 0, lastClockMs: nowMs, lastCheckMs: nowMs,
      lastSampleId: sampleId, lastSampleAtMs: sampleAtMs, offlineSinceMs: null, offlineConfirmed: false,
      lastUptimeS: uptimeS, lastUptimeAtMs: uptimeS === null ? null : sampleAtMs
    });

    function update({ fresh = false, sampleId = null, sampleAtMs = null, uptimeS = null, nowMs = Date.now() } = {}) {
      const validClock = finite(nowMs);
      const connected = validClock && fresh === true && typeof sampleId === 'string' && sampleId.length > 0
        && finite(sampleAtMs) && sampleAtMs <= nowMs + 5000;
      const uptime = finite(uptimeS) ? uptimeS : null;
      let state = read();
      if (connected && !state) state = begin(nowMs, sampleId, sampleAtMs, uptime);
      else if (state && validClock) {
        const clock = Math.max(nowMs, state.lastClockMs);
        state.elapsedMs = Math.max(state.elapsedMs, clock - state.startedAtMs);
        // Rendering the same snapshot must not refresh the connection or reboot evidence.
        const newSample = connected && sampleId !== state.lastSampleId && sampleAtMs > state.lastSampleAtMs;
        if (newSample) {
          const uptimeGapMs = state.lastUptimeAtMs === null ? 0 : sampleAtMs - state.lastUptimeAtMs;
          const uptimeDropped = uptime !== null && state.lastUptimeS !== null && uptime + 2 < state.lastUptimeS;
          // Detect a reboot while every dashboard was closed, even if the new uptime
          // has already exceeded the last uptime. Continuous uptime preserves refresh/reopen.
          const bootChanged = uptime !== null && state.lastUptimeS !== null && uptimeGapMs > disconnectGraceMs
            && state.lastUptimeS + uptimeGapMs / 1000 - uptime > 5;
          if (state.offlineConfirmed || uptimeDropped || bootChanged) state = begin(nowMs, sampleId, sampleAtMs, uptime);
          else {
            state.lastSampleId = sampleId;
            state.lastSampleAtMs = sampleAtMs;
            state.offlineSinceMs = null;
            if (uptime !== null) {
              state.lastUptimeS = uptime;
              state.lastUptimeAtMs = sampleAtMs;
            }
          }
        } else if (!connected) {
          if (state.offlineSinceMs === null || clock - state.lastCheckMs > observationGapMs) state.offlineSinceMs = clock;
          if (clock - state.offlineSinceMs >= disconnectGraceMs) state.offlineConfirmed = true;
        }
        state.lastClockMs = Math.max(nowMs, state.lastClockMs);
        state.lastCheckMs = state.lastClockMs;
      }
      if (state && validClock) save(state);
      const elapsedMs = state?.elapsedMs ?? 0;
      const remainingMs = Math.max(0, durationMs - elapsedMs);
      const title = `按 ${durationMs / 3600000} 小时续航线性估算，非电池实测；`
        + (connected ? `已运行 ${Math.floor(elapsedMs / 60000)} 分钟，预计剩余 ${Math.ceil(remainingMs / 60000)} 分钟。` : '车端未连接或状态过期。')
        + `刷新页面继续计时；连续断开 ${disconnectGraceMs / 1000} 秒后重连或网关重启，从 100% 重新计时。`;
      return { estimated: true, source: 'connection-duration-estimate', connected,
        percent: connected ? Math.max(0, 100 * remainingMs / durationMs) : null,
        remainingMs: connected ? remainingMs : null, elapsedMs, title };
    }

    return { update };
  }

  return { create, DURATION_MS };
})();
