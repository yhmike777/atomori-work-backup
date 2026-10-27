import { GestureGate, GestureTransitions } from './gesture-gate.js';
import { PalmMotion } from './palm-motion.js';
import { TwoHandMotion } from './two-hand-motion.js';
import { inspectHand, inspectTwoHands } from './hand-pose.js';

export function setupGestures({ expand, rotate, zoom, ready }) {
  const video=document.getElementById('camera-video'), button=document.getElementById('camera-toggle'), status=document.getElementById('camera-status');
  const gate=new GestureGate(), transitions=new GestureTransitions(), palm=new PalmMotion(), pair=new TwoHandMotion();
  let stream, recognizer, frame, generation=0, busy=false, lastTime=-1, lastInference=0, suppressed=0, interacting=false;
  const reset=()=>{gate.reset();transitions.reset();palm.reset();pair.reset();};
  function manual(active=false){interacting=active;suppressed=performance.now()+1400;reset();}
  function stop(){generation++;cancelAnimationFrame(frame);stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;video.hidden=true;button.textContent='启用摄像头';button.setAttribute('aria-pressed','false');status.textContent='摄像头已关闭';reset();}
  function infer(){
    if(!stream)return;
    const now=performance.now();
    if(!document.hidden&&video.readyState>=2&&video.currentTime!==lastTime&&now-lastInference>65){
      lastTime=video.currentTime;lastInference=now;
      try {
        const result=recognizer.recognizeForVideo(video,now), count=result.landmarks.length, aspect=video.videoWidth/video.videoHeight;
        if(!ready()||interacting||now<suppressed){reset();status.textContent='手动操作优先 · 手势暂候';}
        else if(count===2){
          gate.reset();transitions.reset();palm.reset();
          const pose=inspectTwoHands(result,aspect), motion=pair.update(result.landmarks,now,pose.eligible,aspect);
          status.textContent=pose.eligible?'双掌外扩放大，内合缩小':pose.reason;
          if(motion.logScale)zoom(Math.exp(-motion.logScale*1.7));
        }else{
          pair.reset();const cat=result.gestures?.[0]?.[0],name=cat?.categoryName,score=cat?.score||0;
          const valid=count===1&&inspectHand(result.landmarks[0],result.handedness?.[0],name,aspect).upright;
          if(count===1&&!valid){gate.reset();transitions.reset();}
          const stable=gate.update(name,score,valid?1:0,now), change=transitions.update(stable,now,valid?1:0);
          const motion=palm.update(result.landmarks[0],now,stable===1);
          if(motion.dx||motion.dy)rotate(-motion.dx*5,-motion.dy*4);
          if(change!==null)expand(change);
          status.textContent=!count?'等待手势':!valid?'请保持手指朝上':stable===1?'张掌移动旋转 · 握拳还原':stable===0?'握拳就绪 · 张掌展开':'保持姿势片刻';
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
      stream=acquired;video.srcObject=stream;await video.play();video.hidden=false;status.textContent='正在加载本地识别模型…';
      if(!recognizer){
        const moduleUrl=new URL('./gesture/vision_bundle.mjs',document.baseURI).href;
        const vision=await import(/* @vite-ignore */ moduleUrl);
        const files=await vision.FilesetResolver.forVisionTasks(new URL('./gesture/wasm',document.baseURI).href);
        recognizer=await vision.GestureRecognizer.createFromOptions(files,{baseOptions:{modelAssetPath:new URL('./gesture/gesture_recognizer.task',document.baseURI).href,delegate:'CPU'},runningMode:'VIDEO',numHands:2,minHandDetectionConfidence:.55,minHandPresenceConfidence:.55,minTrackingConfidence:.55});
      }
      if(token!==generation)return;
      stream.getVideoTracks()[0].addEventListener('ended',stop,{once:true});
      button.textContent='关闭摄像头';button.setAttribute('aria-pressed','true');lastTime=-1;reset();infer();
    }catch(error){stop();status.textContent=({NotAllowedError:'未获得摄像头权限，请在地址栏允许后重试。',NotFoundError:'没有可用摄像头。',NotReadableError:'摄像头被占用，请关闭其他视频程序。'})[error.name]||'启动失败：'+error.message;}
    finally{busy=false;button.disabled=false;}
  }
  button.addEventListener('click',()=>stream?stop():start());
  window.addEventListener('pagehide',stop);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();});
  return { manual, stop };
}
