import assert from 'node:assert/strict';
import {PalmMotion} from '../gesture/palm-motion.js';
const hand=(x=.5,y=.5)=>Array.from({length:21},()=>({x,y,z:0}));
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name);}
test('initial anchor and idle jitter never turn',()=>{
 const p=new PalmMotion();assert.equal(p.update(hand(),0).dx,0);
 for(let i=1;i<200;i++){const d=p.update(hand(.5+.001*Math.sin(i),.5+.001*Math.cos(i)),i*70);assert.equal(d.dx,0);assert.equal(d.dy,0);}
});
test('four mirrored preview directions',()=>{
 for(const [x,y,sx,sy]of [[.45,.5,1,0],[.55,.5,-1,0],[.5,.45,0,-1],[.5,.55,0,1]]){
  const p=new PalmMotion();p.update(hand(),0);const d=p.update(hand(x,y),70);
  assert.equal(Math.sign(d.dx),sx);assert.equal(Math.sign(d.dy),sy);
 }
});
test('slow movement accumulates through deadzone',()=>{
 const p=new PalmMotion();p.update(hand(),0);let sum=0;
 for(let i=1;i<=50;i++)sum+=p.update(hand(.5-i*.001,.5),70*i).dx;
 assert(sum>.04&&sum<.051);
});
test('finger tips do not drive translation',()=>{
 const p=new PalmMotion();p.update(hand(),0);const h=hand();for(const i of [4,8,12,16,20]){h[i].x=.8;h[i].y=.2;}
 const d=p.update(h,70);assert.equal(d.dx,0);assert.equal(d.dy,0);
});
test('loss, fists, double hands, invalid coordinates and gaps re-anchor',()=>{
 const p=new PalmMotion();p.update(hand(),0);p.update(hand(.45),70);
 assert.equal(p.update(hand(.1),140).dx,0); // implausible jump
 assert.equal(p.update(hand(.2),500).dx,0); // gap
 assert.equal(p.update(hand(.3),400).dx,0); // backwards time
 p.update(hand(.4),470,false);assert.equal(p.update(hand(.6),540).dx,0);
 p.update(null,610);assert.equal(p.update(hand(.2),680).dx,0);
 const h=hand();h[5].x=NaN;assert.equal(p.update(h,750).tracking,false);
 assert.equal(p.update(hand(.8),820).dx,0);
});
test('settles at fixed palm position with no drift',()=>{
 const p=new PalmMotion();p.update(hand(),0);let outputs=[];
 for(let i=1;i<40;i++)outputs.push(p.update(hand(.45,.47),i*70));
 assert(outputs.slice(-10).every(d=>d.dx===0&&d.dy===0));
});
console.log(`${passed} palm movement tests passed`);
