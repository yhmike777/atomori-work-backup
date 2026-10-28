export class GestureGate {
  constructor() { this.reset(); this.lastTime = -Infinity; }
  reset() { this.candidate = null; this.since = 0; this.frames = 0; this.lastEvidence = -Infinity; }
  update(name, score, count, now) {
    // CPU inference can take longer than 320 ms while the 3D scene is rendering.
    if (now - this.lastTime > 600) this.reset();
    this.lastTime = now;
    const value = count === 1 && score >= 0.65 ? ({ Open_Palm: 1, Closed_Fist: 0 })[name] : undefined;
    if (value === undefined) {
      // Brief confidence dips do not discard every preceding good frame.
      if (count !== 1 || now - this.lastEvidence > 250) this.reset();
      return null;
    }
    if (value !== this.candidate) { this.candidate = value; this.since = now; this.frames = 1; }
    else this.frames++;
    this.lastEvidence = now;
    return now - this.since >= 350 && this.frames >= 3 ? value : null;
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

// Keep the pose transition baseline across brief orientation/tracking gaps.
// GestureTransitions still clears it after a real loss, two hands or a long gap.
export class SingleHandGestures {
  constructor(){this.gate=new GestureGate();this.transitions=new GestureTransitions();}
  reset(){this.gate.reset();this.transitions.reset();}
  update(name,score,count,upright,now){
    if(count>1){this.reset();return {stable:null,change:null};}
    const eligible=count===1&&upright;
    const stable=this.gate.update(name,score,eligible?1:0,now);
    return {stable,change:this.transitions.update(stable,now,eligible?1:0)};
  }
}
