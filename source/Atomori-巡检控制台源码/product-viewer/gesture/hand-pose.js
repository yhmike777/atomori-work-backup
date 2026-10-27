// Geometry is measured in the recognizer's raw video coordinates. The mirrored
// preview is CSS only; do not mirror landmarks or swap categories in this gate.
// x and z use image-width units, y uses image-height units (MediaPipe Tasks).
const OPEN = 'Open_Palm';
const first = categories => Array.isArray(categories) ? categories[0] : categories;
const nameOf = category => category?.categoryName ?? category?.category_name ?? '';
const SINGLE_HAND_POSE = Object.freeze({palmLength:.015,upCos:.65,fingerRise:.18,thumbRise:.08,facingScore:.45,widthRatio:.35});
// The easier two-hand mode uses half the original minimums. Positive up/front
// signs and the requirement for one Left plus one Right remain mandatory.
const TWO_HAND_POSE = Object.freeze({palmLength:.0075,upCos:.325,fingerRise:.09,thumbRise:.04,facingScore:.225,widthRatio:.175});

export function inspectHand(landmarks, handedness, gestureName, aspectRatio = 1, limits = SINGLE_HAND_POSE) {
  const category = first(handedness);
  const label = nameOf(category);
  const base = { upright:false, palmFacing:false, label, handednessScore:category?.score ?? 0, upCos:0, facingScore:0 };
  if (!Array.isArray(landmarks) || landmarks.length !== 21 || !Number.isFinite(aspectRatio) || aspectRatio <= 0 ||
      landmarks.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z))) return base;
  const point = index => ({ x:landmarks[index].x*aspectRatio, y:landmarks[index].y, z:landmarks[index].z*aspectRatio });
  const wrist=point(0), middle=point(9), index=point(5), pinky=point(17);
  const axisX=middle.x-wrist.x, axisY=middle.y-wrist.y;
  const palmLength=Math.hypot(axisX,axisY);
  if (palmLength < limits.palmLength) return base;
  const palmWidth=Math.hypot(index.x-pinky.x,index.y-pinky.y);
  const upCos=-axisY/palmLength;
  // A fist's fingertips curl below its knuckles: its wrist-to-knuckle axis is
  // the orientation reference. Open palms also require each long finger up.
  const fingersUp = [8,12,16,20].every((tip,i) => point([5,9,13,17][i]).y-point(tip).y > palmLength*limits.fingerRise);
  const thumbUp = wrist.y-point(4).y > palmLength*limits.thumbRise;
  // Intermediate closing/opening frames may be labelled None. Preserve their
  // upright orientation; the separate gesture gate decides pose eligibility.
  const upright = upCos >= limits.upCos && (gestureName===OPEN ? fingersUp && thumbUp : true);
  const a={x:index.x-wrist.x,y:index.y-wrist.y,z:index.z-wrist.z};
  const b={x:pinky.x-wrist.x,y:pinky.y-wrist.y,z:pinky.z-wrist.z};
  const normal={x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x};
  const normalLength=Math.hypot(normal.x,normal.y,normal.z);
  const facingScore=normalLength>1e-8 ? normal.z/normalLength*(label==='Left' ? 1 : label==='Right' ? -1 : 0) : 0;
  // Calibrated against this project's raw Tasks recognizer output: back-facing
  // Left has negative triangle z; back-facing Right has positive triangle z.
  // Require a broad palm surface, rejecting the back and near-edge-on poses.
  return { ...base, upright, palmFacing:facingScore>=limits.facingScore && palmWidth/palmLength>=limits.widthRatio, upCos, facingScore, palmLength };
}

export function inspectTwoHands(result, aspectRatio = 1) {
  const landmarks=result?.landmarks;
  if (!Array.isArray(landmarks) || landmarks.length!==2) return { eligible:false, reason:'请同时举起左手和右手' };
  const categories=result.handedness ?? result.handednesses;
  const hands=landmarks.map((points,i) => inspectHand(points,categories?.[i],nameOf(first(result.gestures?.[i])),aspectRatio,TWO_HAND_POSE));
  const fail=reason=>({eligible:false,reason,hands});
  if (hands.some(hand=>!['Left','Right'].includes(hand.label) || !Number.isFinite(hand.handednessScore) || hand.handednessScore<.375)) return fail('请让左右手完整、清晰地进入画面');
  if (hands[0].label===hands[1].label) return fail('需要一只左手和一只右手');
  if (hands.some(hand=>!hand.upright)) return fail('请保持双手五指朝上');
  if (hands.some(hand=>!hand.palmFacing)) return fail('请将双手掌心朝向镜头');
  if (result.gestures?.some(categories => nameOf(first(categories))!==OPEN || !Number.isFinite(first(categories)?.score) || first(categories).score<.325) || result.gestures?.length!==2) return fail('请将双手五指张开');
  return { eligible:true, reason:'双手向外放大，向内缩小', hands };
}
