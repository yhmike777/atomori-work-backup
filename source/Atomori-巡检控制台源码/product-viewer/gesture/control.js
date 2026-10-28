import { SingleHandGestures, SINGLE_GESTURE_MIN_SCORE } from './gesture-gate.js';
import { PalmMotion } from './palm-motion.js';
import { TwoHandMotion } from './two-hand-motion.js';
import { inspectHand, inspectTwoHands } from './hand-pose.js';

export function setupGestures({ expand, rotate, zoom, ready }) {
  const video=document.getElementById('camera-video'), button=document.getElementById('camera-toggle'), status=document.getElementById('camera-status');
  const panel=document.getElementById('gesture-panel');
  const single=new SingleHandGestures(), palm=new PalmMotion(), pair=new TwoHandMotion();
  let stream, recognizer, frame, generation=0, busy=false, lastTime=-1, lastInference=0, suppressed=0, interacting=false;
  const reset=()=>{single.reset();palm.reset();pair.reset();};
  function manual(active=false){interacting=active;suppressed=performance.now()+1400;reset();}
  function stop(message='摄像头已关闭'){generation++;cancelAnimationFrame(frame);stream?.getTracks().forEach(t=>t.stop());stream=null;video.pause();video.srcObject=null;video.hidden=true;button.textContent='启用摄像头';button.setAttribute('aria-pressed','false');status.textContent=message;reset();}
  function infer(){
    if(!stream)return;
    const now=performance.now();
    if(!document.hidden&&video.readyState>=2&&video.currentTime!==lastTime&&now-lastInference>65){
      lastTime=video.currentTime;lastInference=now;
      try {
        const result=recognizer.recognizeForVideo(video,now), count=result.landmarks.length, aspect=video.videoWidth/Math.max(1,video.videoHeight);
        if(!ready()){reset();status.textContent='模型载入中 · 手势暂候';}
        else if(interacting||now<suppressed){reset();status.textContent='手动操作优先 · 手势暂候';}
        else if(count===2){
          single.reset();palm.reset();
          const pose=inspectTwoHands(result,aspect), motion=pair.update(result.landmarks,now,pose.eligible,aspect);
          status.textContent=pose.eligible?'双掌外扩放大，内合缩小':pose.reason;
          if(motion.logScale)zoom(Math.exp(-motion.logScale*1.7));
        }else{
          pair.reset();const cat=result.gestures?.[0]?.[0],name=cat?.categoryName,score=cat?.score||0;
          const pose=count===1?inspectHand(result.landmarks[0],result.handedness?.[0],name,aspect):null;
          // Expansion needs a recognized fist/palm, not a particular wrist angle.
          // Palm rotation retains its orientation gate; two-hand zoom is unchanged.
          const valid=pose?.tracked===true;
          const {stable,change}=single.update(name,score,count,valid,now);
          const motion=palm.update(result.landmarks[0],now,stable===1&&pose?.upright===true);
          if(motion.dx||motion.dy)rotate(-motion.dx*5,-motion.dy*4);
          if(change!==null)expand(change);
          const label=({Open_Palm:'张掌',Closed_Fist:'握拳'})[name]||'其他手势';
          const reading=`识别：${label} ${Math.round(score*100)}% · `;
          const hint=!valid?'请让整只手清晰入镜':change===1?'已展开 · 握拳还原':change===0?'已还原 · 再张掌展开':score<SINGLE_GESTURE_MIN_SCORE?'置信度不足，请让整只手清晰入镜':stable===1?'张掌已稳定，握拳还原；手指朝上可旋转':stable===0?'握拳已识别，再张掌展开':'请握拳再张掌 · 稍停片刻即可';
          status.textContent=count?reading+hint:'未检测到手，请让整只手进入画面';
        }
      }catch(error){stop();status.textContent='识别中断：'+error.message;return;}
    }
    frame=requestAnimationFrame(infer);
  }
  async function start(){
    if(busy||stream)return;
    if(!navigator.mediaDevices?.getUserMedia){status.textContent='摄像头需要 HTTPS 或本机 localhost 地址。';return;}
    busy=true;button.disabled=true;const token=++generation;status.textContent='等待摄像头授权…';
    try {
      const acquired=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:'user'},audio:false});
      if(token!==generation){acquired.getTracks().forEach(t=>t.stop());return;}
      stream=acquired;
      acquired.getVideoTracks()[0].addEventListener('ended',()=>{if(token===generation)stop('摄像头连接已结束，可重新启用。');},{once:true});
      video.srcObject=stream;await video.play();
      if(token!==generation)return;
      video.hidden=false;status.textContent='正在加载本地识别模型…';
      if(!recognizer){
        const moduleUrl=new URL('./gesture/vision_bundle.mjs',document.baseURI).href;
        const vision=await import(/* @vite-ignore */ moduleUrl);
        if(token!==generation)return;
        const files=await vision.FilesetResolver.forVisionTasks(new URL('./gesture/wasm',document.baseURI).href);
        if(token!==generation)return;
        const loaded=await vision.GestureRecognizer.createFromOptions(files,{baseOptions:{modelAssetPath:new URL('./gesture/gesture_recognizer.task',document.baseURI).href,delegate:'CPU'},runningMode:'VIDEO',numHands:2,minHandDetectionConfidence:.35,minHandPresenceConfidence:.35,minTrackingConfidence:.35});
        if(token!==generation){loaded.close();return;}
        recognizer=loaded;
      }
      if(token!==generation)return;
      button.textContent='关闭摄像头';button.setAttribute('aria-pressed','true');lastTime=-1;lastInference=0;reset();infer();
    }catch(error){if(token===generation){stop();status.textContent=({NotAllowedError:'未获得摄像头权限，请在地址栏允许后重试。',NotFoundError:'没有可用摄像头。',NotReadableError:'摄像头被占用，请关闭其他视频程序。',OverconstrainedError:'摄像头不支持当前模式，请换用其他摄像头。'})[error.name]||'启动失败：'+error.message;}}
    finally{busy=false;button.disabled=false;}
  }
  button.addEventListener('click',()=>stream?stop():start());
  document.getElementById('gesture-focus')?.addEventListener('click',()=>{panel.open=true;panel.scrollIntoView({block:'nearest',behavior:'smooth'});button.focus({preventScroll:true});});
  panel?.addEventListener('toggle',()=>{if(!panel.open&&(stream||busy))stop();});
  window.addEventListener('pagehide',()=>{stop();recognizer?.close();recognizer=null;});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();});
  return { manual, stop };
}
