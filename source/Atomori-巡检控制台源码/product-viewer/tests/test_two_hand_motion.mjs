import assert from 'node:assert/strict';
import { TwoHandMotion } from '../gesture/two-hand-motion.js';

const hand = (x,y=.5) => Array.from({length:21},() => ({x,y,z:0}));
const pair = (separation=.4,cx=.5,cy=.5) => [hand(cx-separation/2,cy),hand(cx+separation/2,cy)];
function arm(p,hands=pair(),start=0) {
  for (let i=0;i<=4;i++) {
    const r=p.update(hands,start+i*70);
    assert.equal(r.logScale,0);
    assert.equal(r.armed,i*70>=p.armMs&&i+1>=p.armFrames);
  }
  return start+280;
}
let passed=0;
function test(name,fn) { fn();passed++;console.log('PASS '+name); }

test('static initial palms only arm; stationary noise never zooms',() => {
  const p=new TwoHandMotion();const t=arm(p);
  for(let i=1;i<=200;i++) {
    const r=p.update(pair(.4+.001*Math.sin(i),.5+.001*Math.cos(i)),t+i*70);
    assert.equal(r.logScale,0);assert.equal(r.tracking,true);
  }
});
test('arming requires elapsed time and enough consecutive valid frames',() => {
  const p=new TwoHandMotion();p.update(pair(),0);
  assert.equal(p.update(pair(),124).armed,false);
  assert.equal(p.update(pair(),125).armed,true);
  const twoFrames=new TwoHandMotion();twoFrames.update(pair(),0);
  assert.equal(twoFrames.update(pair(),125).armed,true);
  const quick=new TwoHandMotion();
  for(let i=0;i<13;i++)assert.equal(quick.update(pair(),i*10).armed,false);
  assert.equal(quick.update(pair(),125).armed,true);
});
test('half threshold responds to 1% outward/inward movement ignored by the old threshold',() => {
  for(const sign of [1,-1]){
    const easy=new TwoHandMotion(),old=new TwoHandMotion({deadzone:.015,armMs:250,armFrames:4,minSeparation:.08});
    arm(easy);arm(old);let easySum=0,oldSum=0;
    for(let i=1;i<=20;i++){
      easySum+=easy.update(pair(.4*(1+sign*.01)),280+i*70).logScale;
      oldSum+=old.update(pair(.4*(1+sign*.01)),280+i*70).logScale;
    }
    assert(easySum*sign>.0075);assert.equal(oldSum,0);
  }
});
test('outward and inward motion produce signed log zoom with bounded steps',() => {
  for(const direction of [1,-1]) {
    const p=new TwoHandMotion();const t=arm(p);let sum=0;
    for(let i=1;i<=20;i++) {
      const r=p.update(pair(.4+direction*.004*i),t+70*i);
      assert(Math.abs(r.logScale)<=.07);assert(r.logScale*direction>=0);sum+=r.logScale;
    }
    assert(sum*direction>.14);
  }
});
test('translating both palms and swapping detector order do not zoom',() => {
  const p=new TwoHandMotion();const t=arm(p);
  for(let i=1;i<=30;i++) {
    const hands=pair(.4,.5+i*.005,.5-i*.002);
    if(i%2)hands.reverse();
    assert.equal(p.update(hands,t+i*70).logScale,0);
  }
});
test('slow deliberate separation accumulates through the deadzone',() => {
  const p=new TwoHandMotion();const t=arm(p);let sum=0;
  for(let i=1;i<=100;i++)sum+=p.update(pair(.4+i*.0005),t+i*70).logScale;
  assert(sum>.095&&sum<Math.log(.45/.4));
});
test('distance uses image aspect ratio, including diagonal separation',() => {
  const p=new TwoHandMotion();const hands=[hand(.3,.35),hand(.6,.65)];
  for(let i=0;i<5;i++)p.update(hands,i*70,true,2);
  // Same geometric separation: horizontal .3*2=.6, vertical .3.
  // Rotate the separation vector to horizontal while preserving its length.
  const span=Math.hypot(.6,.3)/2;
  const rotated=[hand(.45-span/2,.5),hand(.45+span/2,.5)];
  assert.equal(p.update(rotated,350,true,2).logScale,0);
});
test('invalid eligibility, missing palms, downward caller gate and gaps rearm',() => {
  for(const action of [
    p=>p.update(pair(),350,false), // Includes downward/back-facing palm rejection.
    p=>p.update([hand(.4)],350),
    p=>p.update(null,350),
    p=>p.update(pair(),700),
    p=>p.update(pair(),250),
    p=>{const h=pair();h[1][9].x=NaN;return p.update(h,350);},
    p=>p.update(pair(),350,true,0),
    p=>p.update(pair(),350,true,16/9),
  ]) {
    const p=new TwoHandMotion();arm(p);
    const r=action(p);assert.equal(r.logScale,0);assert.equal(r.armed,false);
    const next=p.update(pair(.45),770);assert.equal(next.logScale,0);assert.equal(next.armed,false);
  }
});
test('implausible position/separation jumps and very close hands do not zoom',() => {
  for(const hands of [pair(.4,.8),pair(.8),pair(.01)]) {
    const p=new TwoHandMotion();arm(p);
    const r=p.update(hands,350);assert.equal(r.logScale,0);assert.equal(r.armed,false);
  }
});
test('warm-up movement is discarded and held final pose settles',() => {
  const p=new TwoHandMotion();
  for(let i=0;i<=2;i++)assert.equal(p.update(pair(.3+i*.01),i*70).logScale,0);
  for(let i=3;i<=10;i++)assert.equal(p.update(pair(.32),i*70).logScale,0);
  const results=[];
  for(let i=11;i<=50;i++)results.push(p.update(pair(.4),i*70));
  assert(results.some(r=>r.logScale>0));
  assert(results.slice(-15).every(r=>r.logScale===0));
});
test('fingertip movement does not change palm-center separation',() => {
  const p=new TwoHandMotion();arm(p);const hands=pair();
  for(const h of hands)for(const index of [4,8,12,16,20]){h[index].x=.8;h[index].y=.2;}
  assert.equal(p.update(hands,350).logScale,0);
});
console.log(`${passed} two-hand movement tests passed`);
