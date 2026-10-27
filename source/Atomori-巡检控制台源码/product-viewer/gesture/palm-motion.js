// Palm translation in mirrored preview coordinates. No gesture classification here.
export class PalmMotion {
  constructor({ deadzone = .006, smoothingMs = 85, maxGapMs = 320, maxJump = .22 } = {}) {
    Object.assign(this, { deadzone, smoothingMs, maxGapMs, maxJump });
    this.reset();
  }
  reset() { this.raw = this.filtered = this.consumed = null; this.lastTime = null; }
  update(landmarks, now, enabled = true) {
    const zero = { dx:0, dy:0, tracking:false };
    if (!enabled || !landmarks || landmarks.length < 21 || !Number.isFinite(now)) { this.reset(); return zero; }
    const points = [0,5,9,13,17].map(i=>landmarks[i]);
    if(points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y))) { this.reset(); return zero; }
    const raw = {x:1-points.reduce((n,p)=>n+p.x,0)/5, y:points.reduce((n,p)=>n+p.y,0)/5};
    const dt = this.lastTime === null ? Infinity : now-this.lastTime;
    if(!this.raw || dt<=0 || dt>this.maxGapMs || Math.hypot(raw.x-this.raw.x,raw.y-this.raw.y)>this.maxJump) {
      this.raw={...raw};this.filtered={...raw};this.consumed={...raw};this.lastTime=now;
      return { ...zero, tracking:true };
    }
    const alpha = 1-Math.exp(-dt/this.smoothingMs);
    this.filtered.x += (raw.x-this.filtered.x)*alpha;
    this.filtered.y += (raw.y-this.filtered.y)*alpha;
    this.raw=raw;this.lastTime=now;
    const dx=this.filtered.x-this.consumed.x,dy=this.filtered.y-this.consumed.y;
    // Retain unconsumed movement, so slow deliberate gestures cross the deadzone.
    if(Math.hypot(dx,dy)<this.deadzone)return { ...zero, tracking:true };
    const distance=Math.hypot(dx,dy),scale=Math.min(1,.06/distance);
    const result={dx:dx*scale,dy:dy*scale,tracking:true};
    this.consumed.x+=result.dx;this.consumed.y+=result.dy;
    return result;
  }
}
