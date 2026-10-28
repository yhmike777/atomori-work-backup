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
assert.equal(slow.update('Closed_Fist',.95,1,400),null);
assert.equal(slow.update('Closed_Fist',.95,1,800),0,'CPU inference at 2.5 fps can establish a stable pose');
const jitter=new GestureGate();
jitter.update('Open_Palm',.95,1,0);jitter.update('Open_Palm',.95,1,100);
assert.equal(jitter.update('Open_Palm',.60,1,200),null,'weak frames never trigger a command');
assert.equal(jitter.update('Open_Palm',.95,1,350),1,'a brief confidence dip retains good evidence');
const weak=new GestureGate();
for(let now=0;now<2000;now+=100)assert.equal(weak.update('Open_Palm',.60,1,now),null,'low confidence alone never stabilizes');
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
