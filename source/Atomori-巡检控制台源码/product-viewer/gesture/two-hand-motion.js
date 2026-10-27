// Relative two-palm separation, independent of camera mirroring and hand order.
// The caller must validate one Left + one Right, open palms facing the camera,
// and fingers pointing upward before setting eligible=true.
// update([leftLandmarks, rightLandmarks], timeMs, eligible, imageWidth/imageHeight)
// returns { logScale, tracking, armed }. Positive logScale means zoom IN.
export class TwoHandMotion {
  constructor({ deadzone = .0075, smoothingMs = 100, maxGapMs = 320,
    maxJump = .24, maxLogJump = .45, maxStep = .07, minSeparation = .04,
    armMs = 125, armFrames = 2 } = {}) {
    Object.assign(this, { deadzone, smoothingMs, maxGapMs, maxJump,
      maxLogJump, maxStep, minSeparation, armMs, armFrames });
    this.reset();
  }

  reset() {
    this.centers = null;
    this.raw = this.filtered = this.consumed = null;
    this.lastTime = this.startTime = this.aspectRatio = null;
    this.frames = 0;
    this.armed = false;
  }

  anchor(centers, raw, now, aspectRatio) {
    this.centers = centers;
    this.raw = this.filtered = this.consumed = raw;
    this.lastTime = this.startTime = now;
    this.aspectRatio = aspectRatio;
    this.frames = 1;
    this.armed = false;
  }

  update(hands, now, eligible = true, aspectRatio = 4 / 3) {
    const zero = { logScale:0, tracking:false, armed:false };
    if (!eligible || !Array.isArray(hands) || hands.length !== 2 ||
      !Number.isFinite(now) || !Number.isFinite(aspectRatio) || aspectRatio <= 0) {
      this.reset(); return zero;
    }
    const centers = hands.map(landmarks => {
      if (!landmarks || landmarks.length < 21) return null;
      const points = [0,5,9,13,17].map(i => landmarks[i]);
      if (points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
      // x and y use the same physical image scale, so diagonal motion is correct.
      return { x:points.reduce((n,p) => n+p.x,0) / 5 * aspectRatio,
        y:points.reduce((n,p) => n+p.y,0) / 5 };
    });
    if (centers.some(p => !p)) { this.reset(); return zero; }
    const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
    const separation = distance(centers[0],centers[1]);
    if (separation < this.minSeparation) { this.reset(); return zero; }
    const raw = Math.log(separation);
    const dt = this.lastTime === null ? Infinity : now-this.lastTime;
    // MediaPipe may reorder detections. Compare both assignments before deciding
    // that one of the tracked palms jumped to a different location.
    const jump = this.centers ? Math.min(
      Math.max(distance(centers[0],this.centers[0]),distance(centers[1],this.centers[1])),
      Math.max(distance(centers[0],this.centers[1]),distance(centers[1],this.centers[0]))) : Infinity;
    if (!this.centers || dt <= 0 || dt > this.maxGapMs ||
      aspectRatio !== this.aspectRatio || jump > this.maxJump || Math.abs(raw-this.raw) > this.maxLogJump) {
      this.anchor(centers,raw,now,aspectRatio); return zero;
    }
    this.centers = centers;
    this.raw = raw;
    this.lastTime = now;
    this.frames++;
    if (!this.armed) {
      // Warm-up movement never becomes a delayed zoom when the pair is armed.
      this.filtered = this.consumed = raw;
      this.armed = now-this.startTime >= this.armMs && this.frames >= this.armFrames;
      return { ...zero, tracking:this.armed, armed:this.armed };
    }
    this.filtered += (raw-this.filtered) * (1-Math.exp(-dt/this.smoothingMs));
    const delta = this.filtered-this.consumed;
    if (Math.abs(delta) < this.deadzone) return { ...zero, tracking:true, armed:true };
    // Retaining the residual lets deliberately slow motion cross the deadzone.
    const logScale = Math.max(-this.maxStep,Math.min(this.maxStep,delta));
    this.consumed += logScale;
    return { logScale, tracking:true, armed:true };
  }
}
