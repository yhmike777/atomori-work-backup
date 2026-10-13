'use strict';
const $ = id => document.getElementById(id);
const mapNetwork={
 A:[[[6.3,21],[15.8,21.4],[15.8,34.5],[23.3,34.8],[23.5,45.4],[34.7,45.4]],[[4.7,75.4],[5.2,61.3],[17.8,60.4],[18.4,51.6],[23.3,51.6],[23.5,45.4]]],
 B:[[[34.7,45.4],[47.4,45.3],[66,45.4]],[[47.5,10.7],[47.6,33.3],[47.4,45.3],[47.9,59.1]],[[31.2,21.2],[34.9,21.4],[34.9,33.3],[47.6,33.3],[52.8,35.1]],[[47.9,59.1],[40.8,59.2],[40.4,72.6],[55,72.6],[55,59.3],[47.9,59.1]],[[47.4,45.3],[66,45.4],[66,69.9],[55,69.9],[55,59.3]],[[47.3,72.6],[47.2,85]]],
 C:[[[66,45.4],[70.1,44.4],[70.1,21.2],[81.6,21.3],[81.8,31.3],[94.6,31.3],[94.7,22]],[[70.1,44.4],[88.3,44.8],[88.3,31.7],[81.8,31.3],[81.8,21.3],[70.1,21.2],[70.1,44.4]],[[81.6,21.3],[87.2,21.2],[87.1,11.8]]],
 D:[[[66,65.1],[73.6,65.1],[79,66],[79.9,80]]]
};
const taskRoute=[[34.7,45.4],[40,45.4],[47.4,45.3],[54.9,45.4],[62.2,45.4],[47.4,45.3],[47.6,33.3],[52.8,35.1],[47.6,33.3],[47.4,45.3],[47.9,59.1],[40.8,59.2],[40.4,72.6],[55,72.6],[55,69.9],[66,69.9]];
const taskStops={8:1,9:3,10:4,11:7,12:15};
const mapPath=points=>'M'+points.map(([x,y])=>`${x*10} ${y*5}`).join('L');
document.querySelectorAll('[data-zone-line]').forEach(p=>p.setAttribute('d',mapNetwork[p.dataset.zoneLine].map(mapPath).join(' ')));
const state = {camera:'uav',device:'uav',paused:false,manual:false,stopped:false,phase:'inspect',point:8,completed:7,pitch:-12,pan:0,business:null,cameraPoint:'B-08 阀组',readOnly:true};
const cameras = {
  uav:{name:'UAV-01 · 空中云台',image:'uav-camera.png',hardware:'A8 Mini',quality:'1080P / 25 FPS'},
  ugv:{name:'UGV-01 · 地面云台',image:'ugv-camera.png',hardware:'A2 Mini',quality:'1080P / 25 FPS'},
  dock:{name:'UAV-01 · 着陆俯视',image:'docking-camera.png',hardware:'IMX296',quality:'1440 × 1080 / 30 FPS'},
  thermal:{name:'扩展载荷 · 热成像',image:'thermal-camera.png',hardware:'IR · 热像样本',quality:'最高 48.6°C'}
};
let recoveryTimer,transitTimer,toastTimer;
const pointNames={8:'阀组',9:'压力表',10:'管线接口',11:'通风机',12:'防火门'};
const pointName = () => `B-${String(state.point).padStart(2,'0')} ${pointNames[state.point]}`;
const escapeText = text => String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(text){ $('toast').textContent=text; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').classList.remove('show'),2800); }
function openDialog(title,body,actions=[]){
 if(recordState.submitting)return;recordState.view=null;
 $('dialog-title').textContent=title;$('dialog-body').innerHTML=body;$('dialog-actions').replaceChildren();
 actions.forEach(({label,run,primary})=>{const button=document.createElement('button');button.textContent=label;if(primary)button.className='confirm';button.onclick=run;$('dialog-actions').append(button);});
 if(!$('action-dialog').open)$('action-dialog').showModal();
}
function closeDialog(){ if(!recordState.submitting){recordState.view=null;$('action-dialog').close();} }
$('action-dialog').addEventListener('close',()=>document.querySelectorAll('[data-business]').forEach(b=>b.setAttribute('aria-expanded','false')));
$('close-dialog').onclick=closeDialog;
$('action-dialog').addEventListener('cancel',event=>{if(recordState.submitting)event.preventDefault();});
$('action-dialog').addEventListener('close',()=>{recordState.view=null;});
$('dialog-body').addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button||button.disabled)return;
 if(button.dataset.ack)void updateFinding(button.dataset.ack,'acknowledged');
 if(button.dataset.resolve)void updateFinding(button.dataset.resolve,'reviewed');
 if(button.dataset.recheck){const finding=recordState.findings.find(item=>item.id===button.dataset.recheck);if(finding)void addRecheck(finding.pointId,finding.assetId);}
 if(button.dataset.cancelRecheck)void cancelRecheck(button.dataset.cancelRecheck);
});
$('action-dialog').addEventListener('click',e=>{if(e.target===$('action-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeDialog();}});
function confirmAction(title,description,run){
 if(state.readOnly){toast('只读模式，设备控制未开放');return;}
 openDialog(title,`<p>${description}</p><p class="dialog-muted">本地演示操作，仅更新界面和模拟回执，不发送设备控制指令。</p>`,[{label:'取消',run:closeDialog},{label:'确认演示',primary:true,run:()=>{closeDialog();run();}}]);
}
function switchCamera(key,point=key==='thermal'?'C-06 电缆接头':pointName()){
 document.querySelectorAll('[data-camera-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.cameraTab===key)));
 state.camera=key;state.cameraPoint=point;const camera=cameras[key];$('main-camera').src='../assets/generated/console/'+camera.image;$('main-camera').alt=camera.name+'图传演示';$('camera-name').textContent=camera.name;$('camera-quality').textContent=camera.quality;
 $('camera-meta').textContent=camera.hardware+(key==='dock'?'　视觉目标 PAD-01':key==='thermal'?'　最高温区域':`　俯仰 ${state.pitch.toFixed(1)}°`);
 $('target-bracket').style.display=key==='ugv'?'none':'';$('target-label').textContent=key==='dock'?'PAD-01 / 视觉跟踪':key==='thermal'?'C-06 / 48.6°C':state.cameraPoint;
}
document.querySelectorAll('[data-camera]').forEach(button=>button.onclick=()=>switchCamera(button.dataset.camera));
$('restore-camera').onclick=()=>switchCamera('uav');
$('expand-camera').onclick=()=>openDialog(cameras[state.camera].name,`<img src="../assets/generated/console/${cameras[state.camera].image}" alt="当前相机完整画面"><p class="dialog-muted">${cameras[state.camera].hardware} · ${state.cameraPoint} · 图像样本</p>`);
$('toggle-route').onclick=()=>{const button=$('toggle-route'),visible=button.getAttribute('aria-pressed')!=='true';button.setAttribute('aria-pressed',String(visible));$('map-route').style.display=visible?'':'none';document.querySelector('.twin-route').style.display=visible?'':'none';button.textContent=visible?'隐藏路径':'显示路径';};
$('toggle-map').onclick=()=>{const flat=document.querySelector('.map-area').classList.toggle('is-2d');$('toggle-map').textContent=flat?'2.5D':'二维';$('toggle-map').setAttribute('aria-pressed',String(flat));$('map-view-label').textContent=flat?'四区线路索引':'2.5D 空间档案';};
$('thermal-view').onclick=()=>switchCamera('thermal');
function lockDeviceControls(){
 document.querySelectorAll('.command-panel button:not([data-device])').forEach(button=>{if(state.readOnly){button.disabled=true;button.title='只读模式，设备控制未开放';}});
}
function setReadOnlyMode(readOnly){state.readOnly=readOnly;controls();if(!readOnly){$('pause-task').disabled=false;$('takeover').disabled=false;$('protective-stop').disabled=false;}lockDeviceControls();}
function controls(){
 const blocked=state.stopped||state.manual||state.paused||state.completed===12;
 const wait=state.phase==='recover';
 if(state.device==='uav'){
  $('device-controls').innerHTML=`<button class="main-command" id="primary-command" ${blocked||state.phase==='transit'||state.phase==='charging'?'disabled':''}>${wait?'中止回收':state.phase==='landed'?'启动空中巡检':'请求回收'}</button><div class="command-subrow"><span>云台微调 · 每次 5°</span><div class="gimbal-control"><button data-gimbal="up" aria-label="云台向上" ${blocked?'disabled':''}>↑</button><button data-gimbal="down" aria-label="云台向下" ${blocked?'disabled':''}>↓</button><button data-gimbal="left" aria-label="云台向左" ${blocked?'disabled':''}>←</button><button data-gimbal="right" aria-label="云台向右" ${blocked?'disabled':''}>→</button></div></div>`;
  $('primary-command').onclick=()=>state.phase==='landed'?confirmAction('启动空中巡检','演示从车载平台出发，进入当前点位的空中观察任务。',()=>{state.phase='inspect';state.paused=false;update();switchCamera('uav');addEvent('空中巡检已启动','演示回执 · '+pointName());}):wait?confirmAction('中止回收','停止本次回收演示，切回定点观察。',()=>{clearInterval(recoveryTimer);state.phase='inspect';update();addEvent('回收已中止','演示回执 · 返回定点观察');}):confirmAction('请求无人机回收','车辆保持驻停，依次演示视觉接近、下降、接触与落位确认。补能需要单独请求。',startRecovery);
  document.querySelectorAll('[data-gimbal]').forEach(b=>b.onclick=()=>{const d=b.dataset.gimbal;if(d==='up'||d==='down')state.pitch=Math.max(-90,Math.min(30,state.pitch+(d==='up'?5:-5)));else state.pan=Math.max(-160,Math.min(160,state.pan+(d==='left'?-5:5)));switchCamera('uav');addEvent('云台微调已接受',`演示回执 · 俯仰 ${state.pitch}° / 偏航 ${state.pan}°`);toast('云台角度已更新（演示）');});
 }else if(state.device==='ugv'){
  const allowed=state.phase==='landed'&&!blocked;
  $('device-controls').innerHTML=`<button class="main-command" id="primary-command" ${allowed?'':'disabled'}>${state.completed===12?'全部点位已完成':state.point===12?'完成任务并归档':'前往下一点位'}</button><p class="command-caption">${allowed?'无人机已回收 · 充电回路断开':state.phase==='transit'?'载机转场中 · 前往下一点位':state.phase==='charging'?'补能进行中，停止补能后可转场。':'车辆保持驻停，等待回收或控制权确认。'}</p>`;
  $('primary-command').onclick=()=>state.point===12?confirmAction('完成任务并归档','保存本次演示任务状态与巡检记录，结束当前巡检任务。',()=>{state.completed=12;update();addEvent('本次任务已完成','12 / 12 点位 · 演示成果已归档');toast('任务完成，可导出巡检记录');}):confirmAction('载机转场','演示载机转运至下一个任务点位，充电主回路保持断开。',()=>{
   state.phase='transit';update();addEvent('下一点位请求已接受','演示回执 · 载机转场');
   transitTimer=setInterval(()=>{if(state.paused||state.manual)return;clearInterval(transitTimer);state.phase='landed';state.point++;state.completed++;update();addEvent('下一任务点已到达','演示回执 · '+pointName());toast('已到达下一点位，可启动空中巡检');},2200);
  });
 }else{
  const charging=state.phase==='charging';
  $('device-controls').innerHTML=`<button class="main-command" id="primary-command" ${blocked||(!charging&&state.phase!=='landed')?'disabled':''}>${charging?'请求停止补能':'申请补能'}</button><p class="command-caption">${charging?'CC 阶段 · 24.1 V / 4.2 A（演示）':state.phase==='landed'?'落位确认 · 桨叶停止 · 等待补能授权':'等待落位确认 · 主回路保持断开'}</p>`;
  $('primary-command').onclick=()=>confirmAction(charging?'请求停止补能':'申请补能',charging?'断开充电演示，保留落位状态。':'演示控制器完成落位、桨叶停止、极性、电压及温度联锁检查后，进入恒流补能。',()=>{state.phase=charging?'landed':'charging';update();addEvent(charging?'停止补能已确认':'补能请求已接受',charging?'演示回执 · 主回路断开':'演示回执 · 联锁通过 / CC 阶段');toast(charging?'补能演示已停止':'正在演示受控补能');});
 }
 lockDeviceControls();
}
function update(){
 $('control-owner').textContent=state.stopped?'保护停止':state.manual?'人工控制':state.paused?'任务暂停':'任务控制';
 $('pause-task').textContent=state.paused?'继续任务':'暂停任务';$('pause-task').disabled=state.stopped||state.manual||state.completed===12;
 $('takeover').textContent=state.manual?'交还控制':'人工接管';$('takeover').disabled=state.stopped;
 $('protective-stop').innerHTML=state.stopped?'恢复演示':'<span>■</span> 保护停止';
 const docked=['landed','charging','transit'].includes(state.phase);
 $('rover-state').textContent=state.stopped?'保护停止':state.phase==='transit'&&!state.paused&&!state.manual?'载机转场':'驻停保持';
 $('rover-speed').innerHTML=(state.phase==='transit'&&!state.stopped&&!state.paused&&!state.manual?'0.35':'0.00')+' <small>m/s</small>';
 $('uav-height').innerHTML=(docked?'0.00':'1.85')+' <small>m</small>';
 $('uav-voltage').innerHTML=(state.phase==='charging'?'24.1':'22.8')+' <small>V</small>';
 const stop=taskStops[state.point],[x,y]=taskRoute[stop],mx=x*10,my=y*5;
 const rover=document.querySelector('.rover-marker'),drone=document.querySelector('.drone-marker');
 rover.style.left=x+'%';rover.style.top=y+'%';drone.style.left=(docked?x:x+6.2)+'%';drone.style.top=(docked?y-7:y-10)+'%';drone.classList.toggle('docked',docked);
 $('inspect-point').style.left=(x-7)+'%';$('inspect-point').style.top=(y+9)+'%';
 $('map-rover').setAttribute('transform',`translate(${mx} ${my})`);$('map-drone').setAttribute('transform',`translate(${mx+33} ${my-25})`);
 $('map-ground-fov').setAttribute('transform',`translate(${mx} ${my})`);$('map-air-fov').setAttribute('transform',`translate(${mx+33} ${my-25})`);$('map-air-fov').style.display=docked?'none':'';
 $('map-uav-label').setAttribute('x',mx+52);$('map-uav-label').setAttribute('y',my-25);$('map-point-label').setAttribute('x',mx-14);$('map-point-label').setAttribute('y',my+29);
 document.querySelectorAll('#map-route path:first-child,.twin-route .planned').forEach(p=>p.setAttribute('d',mapPath(taskRoute)));
 document.querySelectorAll('#map-route path:nth-child(2),.twin-route .travelled').forEach(p=>p.setAttribute('d',mapPath(taskRoute.slice(0,stop+1))));
 const currentPoint=document.querySelector('#map-route>circle');currentPoint.setAttribute('cx',mx);currentPoint.setAttribute('cy',my);

 document.querySelector('.dock-status').classList.toggle('charging',state.phase==='charging');
 $('mission-location').textContent='综合舱 · '+pointName();
 $('twin-drone-state').textContent=docked?'已回收':state.phase==='recover'?'回收中':'高位观察';
 $('inspect-point').innerHTML='<i></i>'+pointName().split(' ')[0]+' <small>设施档案</small>';
 document.querySelector('.running-label').textContent=state.stopped?'已停止':state.completed===12?'已完成':state.paused?'暂停中':'执行中';
 $('map-point-label').textContent=pointName().split(' ')[0];
 $('progress-count').textContent=String(state.completed).padStart(2,'0');$('progress-bar').style.width=(state.completed/12*100)+'%';
 document.querySelector('.tunnel-map').setAttribute('aria-label',docked?'任务地图：无人机已回收到车载平台':'任务地图：无人车驻停，无人机在附近巡检');$('map-drone').style.display=docked?'none':'';$('map-uav-label').textContent=docked?'UAV 已回收':'UAV-01';
 $('relative-drone').setAttribute('cx',docked?'43':'58');$('relative-drone').setAttribute('cy',docked?'40':'44');
 $('relative-vector').setAttribute('d',docked?'M43 40 43 40':'M43 40 58 44');
 $('drone-state').textContent=state.stopped?'保持停止':state.manual?'人工控制':state.paused?'任务暂停':docked?'已回收':state.phase==='recover'?'回收中':'定点观察';
 $('dock-state').textContent=state.phase==='charging'?'受控补能':docked?'落位确认':'待回收';
 $('dock-subline').textContent=state.phase==='charging'?'CC 阶段 · 24.1 V / 4.2 A':'主回路断开 · 充电电流 0 A';
 $('stage-inspect').className=docked||state.phase==='recover'?'done':'current';$('stage-recover').className=state.phase==='transit'?'done':docked||state.phase==='recover'?'current':'';
 $('stage-transit').className=state.phase==='transit'?'current':state.point>8?'done':'';
 $('stage-archive').className=state.completed===12?'done':'';if(state.completed===12)$('stage-recover').className='done';
 if(docked){$('relative-x').innerHTML='+0.02 <small>m</small>';$('relative-y').innerHTML='−0.01 <small>m</small>';$('relative-z').innerHTML='0.00 <small>m</small>';$('relative-yaw').innerHTML='+0.3 <small>°</small>';$('vision-state').textContent='落位确认';$('range-value').innerHTML='0.14 <small>m</small>';}
 else{$('relative-x').innerHTML='+1.20 <small>m</small>';$('relative-y').innerHTML='−0.35 <small>m</small>';$('relative-z').innerHTML='1.85 <small>m</small>';$('relative-yaw').innerHTML='+2.4 <small>°</small>';$('vision-state').textContent='视觉跟踪';$('range-value').innerHTML='2.61 <small>m</small>';}
 controls();
}
function startRecovery(){
 state.phase='recover';state.paused=false;update();switchCamera('dock');addEvent('回收请求已接受','演示回执 · 地面平台驻停确认');let step=0;
 const stages=['视觉接近参考目标','下降与落位检查','接触确认与机械对中','落位确认，等待补能'];clearInterval(recoveryTimer);
 recoveryTimer=setInterval(()=>{if(state.paused||state.manual)return;if(state.stopped){clearInterval(recoveryTimer);return;}addEvent(stages[step],'回收演示 · '+(step+1)+' / 4');step++;if(step===stages.length){clearInterval(recoveryTimer);state.phase='landed';update();toast('回收演示完成，可在补能平台中申请补能');}},1600);
}
$('pause-task').onclick=()=>{if(state.readOnly)return;state.paused=!state.paused;update();addEvent(state.paused?'任务暂停已确认':'继续任务已接受','演示回执 · 当前任务 '+(recordState.mission?.id||'未加载'));toast(state.paused?'巡检演示已暂停':'巡检演示已继续');};
$('takeover').onclick=()=>confirmAction(state.manual?'交还任务控制':'人工接管',state.manual?'交还控制后，可继续任务演示。':'切换为人工控制演示，暂停自动任务。真实设备仍需独立遥控链路与控制权确认。',()=>{state.manual=!state.manual;state.paused=true;update();addEvent(state.manual?'人工接管已确认':'控制权已交还','演示回执 · 自动任务保持暂停');});
$('protective-stop').onclick=()=>confirmAction(state.stopped?'恢复本地演示':'请求保护停止',state.stopped?'恢复至最初的空中观察演示状态。':'演示暂停任务并请求设备保护停止。网络请求不能替代独立遥控器或物理急停。',()=>{clearInterval(recoveryTimer);clearTimeout(transitTimer);if(state.stopped){Object.assign(state,{stopped:false,paused:false,manual:false,phase:'inspect',point:8,completed:7});$('rover-state').textContent='驻停保持';$('progress-count').textContent='07';$('progress-bar').style.width='58.3%';switchCamera('uav');}else{state.stopped=true;state.paused=true;if(['charging','transit'].includes(state.phase))state.phase='landed';else if(state.phase==='recover')state.phase='inspect';}update();addEvent(state.stopped?'保护停止请求已接受':'本地演示已恢复','演示回执 · 不发送真实设备指令');});
document.querySelectorAll('[data-device]').forEach(button=>button.onclick=()=>{state.device=button.dataset.device;document.querySelectorAll('[data-device]').forEach(b=>b.setAttribute('aria-selected',String(b===button)));controls();});
$('mark-anomaly').onclick=()=>markAnomaly();
$('mark-ground').onclick=()=>markAnomaly('ugv',pointName());
$('expand-ground').onclick=()=>openDialog('UGV-01 · 地面云台',`<img src="../assets/generated/console/ugv-camera.png" alt="无人车地面云台完整画面"><p class="dialog-muted">A2 Mini · ${pointName()} · 图像样本</p>`);
$('ground-view').onclick=$('expand-ground').onclick;

$('acknowledge').onclick=()=>{const notice=currentNotice();if(notice)void updateFinding(notice.id,'acknowledged');};

$('all-records').onclick=showRecords;
document.querySelectorAll('[data-nav]').forEach(button=>button.onclick=()=>{
 if(button.dataset.nav==='work'){document.querySelector('.camera-panel').scrollIntoView({block:'nearest'});return;}
 if(button.dataset.nav==='records'){showRecords();return;}
 if(button.dataset.nav==='tasks'){showTasks();return;}
 openDialog('设备与传感器连接',`<p class="dialog-warning">当前使用本地演示数据，尚未连接真实设备。</p><table><thead><tr><th>设备</th><th>感知与数据</th><th>当前接入</th></tr></thead><tbody><tr><td>UGV-01</td><td>A2 Mini / N10P / 里程计</td><td>演示</td></tr><tr><td>UAV-01</td><td>A8 Mini / IMX296 / MTF-01P / 飞控</td><td>演示</td></tr><tr><td>DOCK-01</td><td>落位 / 充电控制 / 电压电流温度</td><td>待设备接入</td></tr><tr><td>H100</td><td>车端 AP / 机端 STA / 操作端 STA</td><td>演示</td></tr><tr><td>扩展传感器</td><td>热成像 / 温湿度 / 气体</td><td>未配置</td></tr></tbody></table><p class="dialog-muted" style="margin-top:14px">设备接口按现有 MAVLink、ROS 2、串口与 CAN 方案接入，浏览器视频流和控制接口需后端适配。</p>`);
});
controls();

const businessViews={
 mapping:{title:'空间测绘与建档',point:'全域管廊',image:'tunnel-overview.png',tag:'空间档案',description:'按分区管理管廊空间、设施点位和巡检记录。空间档案用于查询与复查，车机相对定位独立显示。',metrics:[['建档区段','1.28','km'],['设施档案','38','处'],['巡检点位','12','处'],['分区数量','04','区']],rows:[['B-08 阀组','综合舱 · K0+286'],['C-06 电缆接头','电力支路 · K0+241'],['B-12 防火门','区段末端 · K0+420']]},
 surface:{title:'外观结构检查',point:'B-08 阀组',image:'defect-camera.png',tag:'可见光',description:'法兰下缘出现局部锈蚀与湿痕，关联本次观察点位。可添加人工备注，安排同点复查。',metrics:[['本次发现','02','处疑点'],['关联影像','06','帧'],['观察部位','法兰','下缘接缝'],['处理状态','待复核','人工确认']],rows:[['检查对象','法兰接缝 / 螺栓 / 涂层'],['观察来源','可见光云台 · 近距检查'],['历史记录','09-24 已归档 / 10-01 待复核']]},
 thermal:{title:'温度环境监测',point:'C-06 电缆接头',image:'thermal-camera.png',tag:'扩展热像 · 样本',description:'对局部温升记录最高温、区域均温和历史参考值。画面为独立生成的热像样本，数值为演示遥测。',metrics:[['最高温度','48.6','°C'],['区域均温','32.4','°C'],['历史参考','31.8','°C'],['峰值变化','+16.8','°C']],rows:[['巡检部位','电缆接头 · 局部温升'],['环境温湿度','22.8°C / 64% RH · 演示'],['低洼水位','3 mm · 演示']]},
 gas:{title:'气体安全泄漏检测',point:'D-10 泵房接口',tag:'扩展载荷 · 样本',description:'区分氧气、可燃气和有毒气体的测量单位，记录沿线浓度变化。激光甲烷遥测使用独立的路径积分单位 ppm·m。',metrics:[['氧气 O₂','20.8','%Vol'],['可燃气','0.2','%LEL'],['一氧化碳','1.1','ppm'],['硫化氢','0.0','ppm']],rows:[['当前采样点','D-10 · 给排水支路'],['采样模式','定点采样 / 沿线趋势'],['激光甲烷遥测','未配置 · 独立选配载荷']]},
 instrument:{title:'仪表设施状态检查',point:'B-09 压力表',image:'instrument-camera.png',tag:'设施观察 · 样本',description:'保留仪表原图、读数、单位与人工确认记录；阀门、照明、防火门使用各自的预期状态进行检查。',metrics:[['演示读数','0.50','MPa'],['历史读数','0.40','MPa'],['指示灯','点亮','观察状态'],['防火门','闭合','观察状态']],rows:[['压力表 P-09','待人工核读'],['管线阀门 V-04','开位 · 待确认'],['照明回路 L-03','点亮 · 待确认']]},
 acoustic:{title:'声学异常检测',point:'B-11 通风机',image:'acoustic-camera.png',tag:'扩展声学 · 样本',description:'关联声源位置、频谱和采样点，辅助复核机械异响与带压泄漏声。局部放电使用独立专项配置。',metrics:[['主频','2.4','kHz'],['声压级','63.2','dB SPL'],['采样时长','10','s'],['历史变化','+5.6','dB']],rows:[['疑似声源','通风机 · 轴承侧'],['专项局放','未配置'],['检查建议','同点复测，结合维护记录复核']]}
};
function trendGraphic(acoustic=false){return `<svg class="trend-chart" viewBox="0 0 400 230" role="img" aria-label="${acoustic?'声学频谱演示':'气体采样趋势演示'}"><defs><linearGradient id="trend-fill" x2="0" y2="1"><stop stop-color="#39c5f2" stop-opacity=".3"/><stop offset="1" stop-color="#39c5f2" stop-opacity="0"/></linearGradient></defs><path d="M42 30V188H382M42 70H382M42 110H382M42 150H382" stroke="#28445a" stroke-width="1"/><text x="18" y="192">0</text><text x="8" y="113">${acoustic?'40':'0.2'}</text><text x="8" y="34">${acoustic?'80':'0.4'}</text><text x="45" y="213">${acoustic?'0':'14:20'}</text><text x="190" y="213">${acoustic?'2.4 kHz':'14:26'}</text><text x="335" y="213">${acoustic?'5 kHz':'14:32'}</text><path d="${acoustic?'M42 173 65 155 77 169 100 147 118 168 137 139 150 151 172 118 183 147 199 65 207 49 218 107 230 161 248 132 265 162 281 146 300 164 322 153 342 177 377 169':'M42 154 64 157 82 151 104 146 121 151 145 139 167 149 189 139 210 134 231 141 253 125 276 130 300 119 326 105 350 111 377 109'} L377 188H42Z" fill="url(#trend-fill)" stroke="none"/><path id="trend-line" d="${acoustic?'M42 173 65 155 77 169 100 147 118 168 137 139 150 151 172 118 183 147 199 65 207 49 218 107 230 161 248 132 265 162 281 146 300 164 322 153 342 177 377 169':'M42 154 64 157 82 151 104 146 121 151 145 139 167 149 189 139 210 134 231 141 253 125 276 130 300 119 326 105 350 111 377 109'}" fill="none" stroke="#49c8eb" stroke-width="2"/><text id="trend-name" x="44" y="17">${acoustic?'频谱幅值 / dB · 演示样本':'可燃气 / %LEL · 演示样本'}</text>${acoustic?'<path d="M207 35V188" stroke="#e6b767" stroke-dasharray="4 4"/><text x="218" y="43">2.4 kHz</text>':''}</svg>`;}
function openBusiness(key){
 state.business=key;const b=businessViews[key];
 if(key==='surface'){b.metrics[3][1]=ready('findings')?(surfaceRecord()?statusLabel(surfaceRecord().status):'暂无记录'):'未加载';}
 const visual=b.image?`<img src="../assets/generated/console/${b.image}" alt="${b.title}独立生成样本">${key==='thermal'?'<span class="heat-scale"></span>':''}`:trendGraphic();
 openDialog(b.title,`<div class="business-summary"><div class="business-visual">${visual}</div><div class="business-metrics">${b.metrics.map(([label,value,unit])=>`<div><span>${label}</span><strong>${value}</strong><small>${unit}</small></div>`).join('')}</div></div><p class="business-description">${b.description}</p><div class="business-list">${b.rows.map(([name,value])=>`<div><span>${name}</span><b>${value}</b></div>`).join('')}</div><div class="business-toolbar" id="business-toolbar"></div><p class="dialog-muted">${b.point} · ${b.tag} · 本地演示数据</p>`,[{label:'加入复查队列',run:()=>addRecheck(b.point)},{label:'查看任务队列',run:showTasks}]);
 document.querySelectorAll('[data-business]').forEach(button=>button.setAttribute('aria-expanded',String(button.dataset.business===key)));
 if(key==='mapping'){$('business-toolbar').innerHTML='<button id="business-map-switch">切换至二维任务地图</button><button id="asset-details">查看 B-08 设施档案</button>';$('business-map-switch').onclick=()=>{closeDialog();if(!document.querySelector('.map-area').classList.contains('is-2d'))$('toggle-map').click();};$('asset-details').onclick=()=>showAsset('B-08 阀组');}
 if(key==='surface'){$('business-toolbar').innerHTML='<button id="business-observe">打开高位图传</button><button id="business-note">添加观察备注</button>';$('business-observe').onclick=()=>{closeDialog();switchCamera('uav',b.point);};$('business-note').onclick=()=>{closeDialog();switchCamera('uav',b.point);$('mark-anomaly').click();};}
 if(key==='thermal'){$('business-toolbar').innerHTML='<button id="business-ir">在主画面观察热像</button><button id="business-history">查看温度历史</button>';$('business-ir').onclick=()=>{closeDialog();switchCamera('thermal');};$('business-history').onclick=()=>openDialog('C-06 · 温度历史',`<table><thead><tr><th>采样日期</th><th>最高温度</th><th>环境温度</th><th>处理状态</th></tr></thead><tbody><tr><td>2026-09-17</td><td>31.2°C</td><td>22.4°C</td><td>已归档</td></tr><tr><td>2026-09-24</td><td>31.8°C</td><td>22.6°C</td><td>已归档</td></tr><tr><td>2026-10-01</td><td>48.6°C</td><td>22.8°C</td><td>待复核</td></tr></tbody></table><p class="dialog-muted">历史数据为演示样本，不是设备实测结果。</p>`,[{label:'返回温度工作台',run:()=>openBusiness('thermal')}]);}
 if(key==='gas'){$('business-toolbar').innerHTML='<button id="gas-confirm" disabled title="气体传感器尚未接入">保存采样记录 · 未接入</button><button id="gas-point">加入复查队列</button>';$('gas-point').onclick=()=>addRecheck(b.point);}
 if(key==='instrument'){$('business-toolbar').innerHTML='<p class="dialog-muted">人工核读与测量存储尚未接入；0.50 MPa 为样本，不写入实测结果。</p><button id="instrument-note">添加观察备注</button>';$('instrument-note').onclick=()=>markAnomaly('instrument',b.point);}
 if(key==='acoustic'){$('business-toolbar').innerHTML='<button id="acoustic-spectrum">查看声学频谱</button><button id="acoustic-save">添加观察备注</button>';$('acoustic-spectrum').onclick=()=>openDialog('B-11 · 声学频谱',trendGraphic(true)+'<p class="dialog-muted">声学阵列未接入 · 当前展示频谱样本。</p>',[{label:'返回声学工作台',run:()=>openBusiness('acoustic')}]);$('acoustic-save').onclick=()=>markAnomaly('acoustic',b.point);}

}
function showAsset(point=pointName()){
 const region=point.slice(0,1),number=point.slice(2,4),regions={A:'入口保障区',B:'综合巡检区',C:'电力设备区',D:'给排水区'},images={'06':'thermal-camera.png','08':'defect-camera.png','09':'instrument-camera.png','11':'acoustic-camera.png'};
 const asset=assetForPoint(point),record=recordState.findings.findLast(a=>a.pointId===pointIdOf(point));
 openDialog(point+' · 设施档案',`<div class="business-summary">${images[number]?`<img src="../assets/generated/console/${images[number]}" alt="${escapeText(point)}观察样本">`:'<div class="business-visual"><img src="../assets/generated/console/tunnel-overview.png" alt="管廊空间档案"></div>'}<div class="business-list"><div><span>设施编号</span><b>${escapeText(asset?.id||'未匹配后端目录')}</b></div><div><span>所属分区</span><b>${escapeText(region)} 区 · ${regions[region]||'综合舱'}</b></div><div><span>巡检点位</span><b>${escapeText(point)}</b></div><div><span>观察状态</span><b>${ready('findings')?(record?escapeText(statusLabel(record.status)):'暂无记录'):escapeText(recordStateMessage('findings'))}</b></div><div><span>最近记录</span><b>${ready('findings')?(record?escapeText(record.note):'暂无记录'):'尚未加载'}</b></div></div></div><p class="dialog-muted">设施目录与影像为演示样本；业务记录保存至本机后端，目录缺失时禁止绑定其他设施。</p>`,[{label:'加入复查队列',run:()=>addRecheck(point)},{label:'查看巡检记录',primary:true,run:showRecords}]);
}
document.querySelectorAll('[data-business]').forEach(b=>b.onclick=()=>openBusiness(b.dataset.business));
$('site-details').onclick=()=>openDialog('B 区 · 综合舱运行概况','<div class="business-metrics"><div><span>当前作业编组</span><strong>01</strong><small>无人车 / 无人机 / 车载补能</small></div><div><span>任务点位</span><strong>12</strong><small>本次例行巡检</small></div><div><span>空间档案</span><strong>1.28</strong><small>km · 演示区段</small></div><div><span>通信结构</span><strong>AP / STA</strong><small>H100 车端中继</small></div></div><p class="dialog-muted">平台使用样本图像与演示遥测，目前未连接真实设备。</p>');
$('inspect-point').onclick=()=>showAsset(pointName());
document.querySelectorAll('[data-site-point]').forEach(b=>b.onclick=()=>showAsset(b.dataset.sitePoint));
document.querySelectorAll('[data-map-object]').forEach(b=>b.onclick=()=>{const key=b.dataset.mapObject==='rover'?'ugv':'uav';if(key==='uav')switchCamera('uav');document.querySelector(`[data-device="${key}"]`).click();document.querySelectorAll('.device-panel').forEach(p=>p.classList.toggle('selected',p.classList.contains(key+'-panel')));toast('已选择'+(key==='ugv'?'无人车':'无人机')+'操作');});
$('surface-finding').onclick=()=>openBusiness('surface');$('instrument-finding').onclick=()=>openBusiness('instrument');$('review-all').onclick=showRecords;$('export-records').onclick=exportRecords;
update();
renderEvents();
void loadRecords();
