import assert from 'node:assert/strict';
import { inspectHand, inspectTwoHands } from '../gesture/hand-pose.js';

const category=(name,score=.99)=>[{categoryName:name,score}];
function hand(label='Left', {back=false,down=false,fist=false,aspect=4/3}={}) {
  const points=Array.from({length:21},()=>({x:.5,y:.55,z:0}));
  points[0]={x:.5,y:.8,z:0};
  const sign=(label==='Left' ? 1 : -1)*(back ? -1 : 1);
  [5,9,13,17].forEach((m,i)=>{
    const x=.5+sign*(i-1.5)*.055/aspect;
    points[m]={x,y:.56,z:0};
    [1,2,3].forEach(j=>points[m+j]={x,y:fist ? .56+j*.025 : .56-j*.09,z:0});
  });
  points[4]={x:.5-sign*.16/aspect,y:.6,z:0};
  if(down)points.forEach(point=>point.y=1-point.y);
  return points;
}
function result(options={}) {
  return {landmarks:[hand('Left',options),hand('Right',options)],handedness:[category('Left'),category('Right')],gestures:[category('Open_Palm'),category('Open_Palm')]};
}

for(const label of ['Left','Right']) {
  const front=inspectHand(hand(label),category(label),'Open_Palm',4/3);
  assert.equal(front.upright,true);assert.equal(front.palmFacing,true);
  const back=inspectHand(hand(label,{back:true}),category(label),'Open_Palm',4/3);
  assert.equal(back.upright,true);assert.equal(back.palmFacing,false);
  assert.equal(inspectHand(hand(label,{down:true}),category(label),'Open_Palm',4/3).upright,false);
  assert.equal(inspectHand(hand(label,{fist:true}),category(label),'Closed_Fist',4/3).upright,true);
  assert.equal(inspectHand(hand(label,{fist:true,down:true}),category(label),'Closed_Fist',4/3).upright,false);
  assert.equal(inspectHand(hand(label,{fist:true}),category(label),'None',4/3).upright,true);
  assert.equal(inspectHand(hand(label,{fist:true,down:true}),category(label),'None',4/3).upright,false);
}
assert.equal(inspectTwoHands(result(),4/3).eligible,true);
assert.equal(inspectTwoHands(result({back:true}),4/3).eligible,false);
assert.equal(inspectTwoHands(result({down:true}),4/3).eligible,false);
const same=result();same.handedness[1]=category('Left');assert.equal(inspectTwoHands(same,4/3).eligible,false);
const low=result();low.handedness[1]=category('Right',.3749);assert.equal(inspectTwoHands(low,4/3).eligible,false);
const closed=result();closed.gestures[1]=category('Closed_Fist');assert.equal(inspectTwoHands(closed,4/3).eligible,false);
const uncertain=result();uncertain.gestures[0]=category('Open_Palm',.3249);assert.equal(inspectTwoHands(uncertain,4/3).eligible,false);
const easy=result();easy.handedness=[category('Left',.375),category('Right',.375)];easy.gestures=[category('Open_Palm',.325),category('Open_Palm',.325)];
assert.equal(inspectTwoHands(easy,4/3).eligible,true);
const partlyOpen=result();
for(const points of partlyOpen.landmarks)for(const [tip,mcp]of [[8,5],[12,9],[16,13],[20,17]])points[tip].y=points[mcp].y-.24*.12;
assert.equal(inspectTwoHands(partlyOpen,4/3).eligible,true);
assert.equal(inspectHand(partlyOpen.landmarks[0],category('Left'),'Open_Palm',4/3).upright,false,'single-hand thresholds stay unchanged');
const folded=result();folded.landmarks[0][8].y=.7;assert.equal(inspectTwoHands(folded,4/3).eligible,false);
const sideways=hand();sideways.forEach(point=>{const x=point.x;point.x=point.y;point.y=x;});assert.equal(inspectHand(sideways,category('Left'),'Open_Palm',4/3).upright,false);
const edge=hand();edge[5].z=-1;edge[17].z=1;assert.equal(inspectHand(edge,category('Left'),'Open_Palm',4/3).palmFacing,false);
const narrow=hand();narrow.forEach(point=>point.x=.5+(point.x-.5)*.1);assert.equal(inspectHand(narrow,category('Left'),'Open_Palm',4/3).palmFacing,false);
const badScore=result();badScore.gestures[1]=category('Open_Palm',NaN);assert.equal(inspectTwoHands(badScore,4/3).eligible,false);
assert.equal(inspectHand(null,[],'Open_Palm').upright,false);
const invalid=hand();invalid[8].x=NaN;assert.equal(inspectHand(invalid,category('Left'),'Open_Palm').upright,false);
assert.equal(inspectTwoHands({landmarks:[hand()]},4/3).eligible,false);
assert.equal(inspectTwoHands({landmarks:[hand(),hand()]},4/3).eligible,false);
console.log('PASS hand pose: left/right front/back, upright/downward palms and fists, edge-on, confidence, pair identity and invalid input');
