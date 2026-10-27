export class GestureGate {
  constructor() { this.reset(); this.lastTime = -Infinity; }
  reset() { this.candidate = null; this.since = 0; this.frames = 0; }
  update(name, score, count, now) {
    if (now - this.lastTime > 320) this.reset();
    this.lastTime = now;
    const value = count === 1 && score >= 0.65 ? ({ Open_Palm: 1, Closed_Fist: 0 })[name] : undefined;
    if (value === undefined) { this.reset(); return null; }
    if (value !== this.candidate) { this.candidate = value; this.since = now; this.frames = 1; }
    else this.frames++;
    return now - this.since >= 350 && this.frames >= 5 ? value : null;
  }
}

// Emits only stable single-hand pose changes, never the first observed pose.
export class GestureTransitions {
  constructor(){this.reset();}
  reset(){this.previous=null;this.lastSingle=null;this.lastStable=null;}
  update(stableValue,now,handCount){
    if(handCount>1){this.reset();return null;}
    if(this.lastSingle!==null&&now-this.lastSingle>600)this.reset();
    if(handCount!==1)return null;
    this.lastSingle=now;
    if(this.lastStable!==null&&now-this.lastStable>1500){this.previous=null;this.lastStable=null;}
    if(stableValue!==0&&stableValue!==1)return null;
    this.lastStable=now;
    const prior=this.previous;this.previous=stableValue;
    return prior!==null&&prior!==stableValue?stableValue:null;
  }
}
