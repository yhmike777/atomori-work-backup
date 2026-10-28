'use strict';

// Presentation only. Never feed these retained readings into a control/online gate.
window.AtomoriContinuity = {
  createReadings() {
    const samples = new Map();
    return (key, item, elapsed = 0, now = performance.now()) => {
      const age = value => Number.isFinite(value) && value >= 0 ? value + Math.max(0, elapsed) : null;
      const liveAge = age(item?.ageS);
      const live = item?.valid === true && Number.isFinite(item.value) && liveAge !== null && liveAge <= item.maxAgeS;
      const candidate = live ? item : item?.lastValid;
      const candidateAge = age(candidate?.ageS);
      if (candidate && Number.isFinite(candidate.value) && candidateAge !== null) {
        const sampledAt = now - candidateAge * 1000, previous = samples.get(key);
        if (!previous || sampledAt >= previous.sampledAt) samples.set(key, { ...candidate, sampledAt });
      }
      const previous = samples.get(key);
      return previous ? { ...previous, ageS: Math.max(0, (now - previous.sampledAt) / 1000), retained: !live, valid: live }
        : { value: null, ageS: null, retained: false, valid: false };
    };
  },
  video(image, mirrorId) {
    const canvas = document.createElement('canvas');
    canvas.className = 'retained-video'; canvas.hidden = true;
    canvas.setAttribute('aria-label', '最近完整视频画面');
    image.after(canvas);
    const context = canvas.getContext('2d');
    let source = null, active = false, hasFrame = false, ready = false, expectedSrc = null;
    // Chromium emits load for the first decoded MJPEG frame. A new request
    // must produce that event before pixels can cross a source/session boundary.
    const loaded = () => { if (active && image.currentSrc === expectedSrc) ready = true; };
    const failed = () => { ready = false; };
    image.addEventListener('load', loaded); image.addEventListener('error', failed);
    function copy() {
      if (active && ready && image.currentSrc === expectedSrc && !document.hidden && image.naturalWidth > 0 && image.naturalHeight > 0) {
        // Draw only the browser's successfully decoded frame; an incomplete JPEG
        // never replaces the last complete image. Network health is tracked separately.
        try {
          if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
            // Resize a temporary canvas first so a failed draw cannot erase the retained frame.
            const next = document.createElement('canvas'); next.width = image.naturalWidth; next.height = image.naturalHeight;
            next.getContext('2d').drawImage(image, 0, 0);
            canvas.width = next.width; canvas.height = next.height; context.drawImage(next, 0, 0);
          } else context.drawImage(image, 0, 0);
          hasFrame = true; canvas.hidden = false;
        } catch { /* Keep the previous complete frame through decode errors. */ }
      }
      const mirror = mirrorId && document.getElementById(mirrorId);
      if (hasFrame && mirror?.tagName === 'CANVAS') {
        if (mirror.width !== canvas.width) mirror.width = canvas.width;
        if (mirror.height !== canvas.height) mirror.height = canvas.height;
        mirror.getContext('2d').drawImage(canvas, 0, 0);
      }
    }
    const timer = setInterval(copy, 125);
    return {
      get hasFrame() { return hasFrame; },
      start(identity) {
        if (identity !== source) { hasFrame = false; canvas.hidden = true; }
        source = identity; active = true; ready = false; expectedSrc = image.src; image.style.opacity = '0';
      },
      hold() { copy(); active = false; },
      clear() { active = false; ready = false; source = null; hasFrame = false; canvas.hidden = true; image.style.opacity = ''; },
      dispose() { clearInterval(timer); image.removeEventListener('load', loaded); image.removeEventListener('error', failed); canvas.remove(); }
    };
  }
};
