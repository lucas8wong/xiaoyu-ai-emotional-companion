// Actual Blender GLB with packed materials and an Idle clip.
import * as T from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';
import { MeshoptDecoder } from './vendor/meshopt_decoder.module.js';
const canvas=document.querySelector('#pet'),stage=document.querySelector('#stage');
const loading=document.querySelector('#loading'),bubble=document.querySelector('#bubble'),retry=document.querySelector('#retry');
const controls=[...document.querySelectorAll('.actions button,.wardrobe button,#pause,#reset')];
controls.forEach(b=>b.disabled=true);
let renderer,failed=false;
function fail(message){failed=true;canvas.dataset.ready='false';loading.hidden=false;loading.textContent=message;retry.hidden=false;controls.forEach(b=>b.disabled=true);}
retry.onclick=()=>location.reload();
try{renderer=new T.WebGLRenderer({canvas,antialias:true,alpha:true,preserveDrawingBuffer:true});await start();}
catch(error){console.error('Petal elf failed to load',error);fail('小花暂时没能出来，请重试。若仍无法显示，请使用支持 WebGL 的浏览器。');}
async function start(){
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=.95;
 const scene=new T.Scene(),camera=new T.PerspectiveCamera(32,1,.1,50);
 const pmrem=new T.PMREMGenerator(renderer),room=new RoomEnvironment(),environment=pmrem.fromScene(room,.025);scene.environment=environment.texture;room.dispose();pmrem.dispose();
 scene.add(new T.HemisphereLight(0xfff4df,0x747d62,1.3));
 const key=new T.DirectionalLight(0xffedda,2.2);key.position.set(-3,5,4);scene.add(key);
 const fill=new T.DirectionalLight(0xffe1df,.8);fill.position.set(3,3,-2);scene.add(fill);
 const gltf=await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync('./models/petal-elf-v1.glb',e=>{loading.textContent=e.total?`正在唤醒小花… ${Math.round(e.loaded/e.total*100)}%`:'正在唤醒小花…';});
 const pet=new T.Group();pet.add(gltf.scene);scene.add(pet);
 const bounds=new T.Box3().setFromObject(gltf.scene),height=bounds.max.y-bounds.min.y,centre=bounds.getCenter(new T.Vector3());gltf.scene.position.x-=centre.x;gltf.scene.position.y-=bounds.min.y;
 const head=gltf.scene.getObjectByName('HeadPivot'),left=gltf.scene.getObjectByName('ArmLeft'),right=gltf.scene.getObjectByName('ArmRight');
 const headRest=head?.quaternion.clone(),leftRest=left?.quaternion.clone(),rightRest=right?.quaternion.clone();
 const mixer=new T.AnimationMixer(gltf.scene);gltf.animations.forEach(clip=>mixer.clipAction(clip).play());
 gltf.scene.traverse(o=>{if(o.isMesh&&o.material)for(const m of Array.isArray(o.material)?o.material:[o.material]){m.envMapIntensity=.7;if(/fibres/.test(m.name))m.side=T.DoubleSide;}});
 const bow=new T.Group();bow.position.set(.43,1.37,.38);pet.add(bow);bow.visible=false;
 const bowMat=new T.MeshStandardMaterial({color:'#bb526f',roughness:.55});
 for(const sign of [-1,1]){const part=new T.Mesh(new T.SphereGeometry(1,20,12),bowMat);part.position.x=sign*.10;part.scale.set(.13,.085,.06);part.rotation.z=sign*.35;bow.add(part);}
 const knot=new T.Mesh(new T.SphereGeometry(.055,16,12),bowMat);knot.position.z=.025;bow.add(knot);
 const shadowImage=document.createElement('canvas');shadowImage.width=shadowImage.height=128;
 const c=shadowImage.getContext('2d'),gradient=c.createRadialGradient(64,64,0,64,64,64);gradient.addColorStop(0,'rgba(62,55,33,.23)');gradient.addColorStop(1,'rgba(62,55,33,0)');c.fillStyle=gradient;c.fillRect(0,0,128,128);
 const shadow=new T.Mesh(new T.PlaneGeometry(2.2,1.4),new T.MeshBasicMaterial({map:new T.CanvasTexture(shadowImage),transparent:true,depthWrite:false}));shadow.rotation.x=-Math.PI/2;shadow.position.y=-.015;scene.add(shadow);
 const motionPreference=matchMedia('(prefers-reduced-motion: reduce)');
 let paused=motionPreference.matches,sleeping=false,action='',elapsed=0,yaw=0,drag=null,previous=performance.now(),accumulator=0;
 const pause=document.querySelector('#pause'),sleep=document.querySelector('[data-action=sleep]'),say=message=>{bubble.textContent=message;};
 function syncPause(){pause.textContent=paused?'继续动态':'暂停动态';pause.setAttribute('aria-pressed',String(paused));}
 function draw(dt=0){
  if(failed)return;elapsed+=dt;if(!sleeping)mixer.update(dt);
  if(head){if(sleeping)head.quaternion.copy(headRest);if(sleeping||action==='pet')head.rotateY(sleeping?.14:Math.sin(elapsed*5)*.055*Math.max(0,1-elapsed/2.6));}
  const lift=action==='lift'&&elapsed<2.6?Math.sin(elapsed/2.6*Math.PI)*.35:0;pet.position.y=lift;pet.rotation.y=yaw+(action==='spin'&&elapsed<3?elapsed/3*Math.PI*2:0);
  if(left){left.quaternion.copy(leftRest);left.rotateY(-lift*1.4);}if(right){right.quaternion.copy(rightRest);right.rotateY(lift*1.4);}shadow.scale.setScalar(1-lift*.25);renderer.render(scene,camera);
 }
 function act(name){
  if(name==='sleep'){sleeping=!sleeping;say(sleeping?'借一片花瓣，做一个软软的梦。':'睡醒啦，今天也想陪你。');}
  else{sleeping=false;say(({pet:'唔…花瓣都被你摸开啦。',lift:'抱稳咯，我有一点点怕痒。',spin:'看！背后也有小花瓣。'})[name]);}
  sleep.setAttribute('aria-pressed',String(sleeping));action=name;elapsed=0;draw();
 }
 pause.onclick=()=>{paused=!paused;syncPause();draw();};motionPreference.addEventListener('change',e=>{if(e.matches){paused=true;syncPause();draw();}});
 document.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>act(button.dataset.action));
 document.querySelector('#reset').onclick=()=>{yaw=0;action='';sleeping=false;sleep.setAttribute('aria-pressed','false');mixer.setTime(0);if(head)head.quaternion.copy(headRest);draw();};
 document.querySelectorAll('[data-color]').forEach(button=>button.onclick=()=>{bow.visible=button.dataset.color!=='none';if(bow.visible)bowMat.color.set(button.dataset.color);document.querySelectorAll('[data-color]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));say(bow.visible?'新蝴蝶结！帮我看看好不好看？':'轻轻松松，也很好看。');draw();});
 canvas.addEventListener('pointerdown',e=>{drag={x:e.clientX,yaw,moved:false};canvas.setPointerCapture(e.pointerId);});
 canvas.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x;drag.moved||=Math.abs(dx)>6;yaw=drag.yaw+dx*.012;action='';draw();});
 canvas.addEventListener('pointerup',()=>{if(drag&&!drag.moved)act('pet');drag=null;});canvas.addEventListener('pointercancel',()=>{drag=null;});
 canvas.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();yaw+=e.key==='ArrowLeft'?-.2:.2;action='';draw();}});
 canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();fail('3D 显示暂时中断，请重新加载。');});
 document.querySelector('#photo').onclick=()=>{draw();const out=document.createElement('canvas');out.width=900;out.height=1000;const ctx=out.getContext('2d');ctx.fillStyle='#FBF6EE';ctx.fillRect(0,0,900,1000);const scale=Math.min(850/canvas.width,850/canvas.height);ctx.drawImage(canvas,(900-canvas.width*scale)/2,20,canvas.width*scale,canvas.height*scale);ctx.textAlign='center';ctx.fillStyle='#243B2E';ctx.font='28px sans-serif';ctx.fillText('一朵小花，一点陪伴',450,925);out.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='xiaoyu-petal-elf.png';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);},'image/png');say('把这一刻，装进口袋里。');};
 function resize(){const width=stage.clientWidth,h=stage.clientHeight;renderer.setSize(width,h,false);camera.aspect=width/h;const distance=Math.max(height*.57/Math.tan(T.MathUtils.degToRad(16)),1.7/(camera.aspect*Math.tan(T.MathUtils.degToRad(16))));camera.position.set(0,height*.52+.3,distance);camera.lookAt(0,height*.52,0);camera.updateProjectionMatrix();draw();}
 new ResizeObserver(resize).observe(stage);syncPause();resize();controls.forEach(b=>b.disabled=false);loading.hidden=true;canvas.dataset.ready='true';
 // Read-only evidence; this standalone page makes no analytics or business API requests.
 canvas.dataset.model='blender-petal-elf-v1';canvas.dataset.triangles=String(renderer.info.render.triangles);canvas.dataset.clips=String(gltf.animations.length);
 function frame(now){requestAnimationFrame(frame);const dt=Math.min((now-previous)/1000,.1);previous=now;if(document.hidden||paused||failed){accumulator=0;return;}accumulator+=dt;if(accumulator<1/30)return;draw(accumulator);accumulator=0;}
 requestAnimationFrame(frame);
}
