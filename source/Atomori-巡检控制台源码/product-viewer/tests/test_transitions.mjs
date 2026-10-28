import assert from 'node:assert/strict';
import {GestureGate,GestureTransitions,SingleHandGestures} from '../gesture/gesture-gate.js';
const t=new GestureTransitions();
assert.equal(t.update(1,0,1),null,'first open palm must not expand');
for(let n=1;n<=10;n++)assert.equal(t.update(1,n*100,1),null,'holding is not a transition');
assert.equal(t.update(0,1100,1),0,'palm to fist restores');
assert.equal(t.update(0,1200,1),null,'holding fist repeats no commands');
assert.equal(t.update(1,1300,1),1,'fist to palm expands');
assert.equal(t.update(1,1400,1),null);
assert.equal(t.update(null,1500,1),null,'brief ambiguous pose retains previous state');
assert.equal(t.update(0,1700,1),0);
t.reset();assert.equal(t.update(0,0,1),null,'first fist establishes baseline');assert.equal(t.update(1,300,1),1);
t.reset();t.update(0,0,1);t.update(null,700,0);assert.equal(t.update(1,800,1),null,'re-entry after loss establishes new baseline');
t.reset();t.update(0,0,1);t.update(null,100,2);assert.equal(t.update(1,200,1),null,'two hands clear baseline');
t.reset();t.update(0,0,1);for(let n=1;n<=16;n++)t.update(null,n*100,1);assert.equal(t.update(1,1700,1),null,'long ambiguous gesture clears baseline');
console.log('PASS: initial pose ignored, bidirectional edges, held pose, brief ambiguity, loss, two hands and long ambiguity.');

const slow=new GestureGate();
assert.equal(slow.update('Closed_Fist',.95,1,0),null);
assert.equal(slow.update('Closed_Fist',.95,1,400),0,'two slow matching frames can confirm a fist');
assert.equal(slow.update('Closed_Fist',.95,1,800),0,'CPU inference at 2.5 fps can establish a stable pose');
const jitter=new GestureGate();
jitter.update('Open_Palm',.95,1,0);jitter.update('Open_Palm',.95,1,100);
assert.equal(jitter.update('Open_Palm',.40,1,200),null,'weak frames never trigger a command');
assert.equal(jitter.update('Open_Palm',.95,1,350),1,'a brief confidence dip retains good evidence');
const weak=new GestureGate();
for(let now=0;now<2000;now+=100)assert.equal(weak.update('Open_Palm',.44,1,now),null,'below-threshold confidence alone never stabilizes');
for(const score of [NaN,Infinity,undefined,'0.9'])assert.equal(new GestureGate().update('Open_Palm',score,1,0),null,'invalid scores never contribute evidence');
const lost=new GestureGate();
lost.update('Open_Palm',.95,1,0);lost.update('Open_Palm',.95,1,100);
assert.equal(lost.update('Open_Palm',.95,1,900),null,'stale samples do not complete an old pose');
function sequence(samples){
  const single=new SingleHandGestures(),actions=[];let now=0;
  for(const [name,upright=true,count=1,repetitions=7] of samples){
    for(let i=0;i<repetitions;i++){
      now+=70;const result=single.update(name,.99,count,upright,now);
      if(result.change!==null)actions.push(result.change);
    }
  }
  return actions;
}
assert.deepEqual(sequence([['Closed_Fist'],['Open_Palm',false,1,1],['Open_Palm']]),[1],'a brief orientation rejection during opening keeps the prior fist');
assert.deepEqual(sequence([['Open_Palm'],['Closed_Fist',false,1,1],['Closed_Fist']]),[0],'a brief orientation rejection during closing keeps the prior palm');
assert.deepEqual(sequence([['Closed_Fist'],['Open_Palm',false,1,10],['Open_Palm']]),[],'a sustained rejected pose clears the prior baseline');
assert.deepEqual(sequence([['Closed_Fist'],['Open_Palm',true,2,1],['Open_Palm']]),[],'two hands cannot complete a single-hand command');
assert.deepEqual(sequence([['Open_Palm',true,1,30]]),[],'initial and held poses still do not issue repeated commands');
console.log('PASS: slow CPU frames, short confidence dips, confidence threshold, stale evidence and orientation gaps.');

const easier=new SingleHandGestures();
assert.equal(easier.update('Closed_Fist',.45,1,true,0).change,null);
assert.equal(easier.update('Closed_Fist',.45,1,true,120).stable,0);
assert.equal(easier.update('Open_Palm',.45,1,true,180).change,null,'one palm frame cannot trigger');
assert.equal(easier.update('Open_Palm',.45,1,true,300).change,1,'45% fist then palm expands after 120ms confirmation');
assert.equal(easier.update('Open_Palm',.45,1,true,420).change,null,'held palm never repeats');
assert.equal(easier.update('Closed_Fist',.45,1,true,480).change,null);
assert.equal(easier.update('Closed_Fist',.45,1,true,600).change,0,'same threshold restores');
const spike=new SingleHandGestures();
spike.update('Closed_Fist',.9,1,true,0);spike.update('Closed_Fist',.9,1,true,120);
assert.equal(spike.update('Open_Palm',.99,1,true,180).change,null);
assert.equal(spike.update('Closed_Fist',.9,1,true,240).change,null,'one misclassified open frame cannot explode the model');
console.log('PASS: lower confidence, faster confirmation, one-frame rejection and bidirectional transition.');
