import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Vector3, Matrix } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { rotationFromPointer, translationFromPointer } from './layout-drag';
import { Manipulation } from './layout-manipulation';
import type { OperationMode, OperationSource } from './layout-manipulation';
import { GestureInput } from './layout-gesture';
import type { GesturePointer } from './layout-gesture';
import { connectGestureBridge } from './layout-gesture-bridge';
import { CameraObservation } from './layout-observe';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import '@babylonjs/core/Culling/ray';
import '@babylonjs/loaders/glTF/2.0/glTFLoader';
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_unlit';
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_texture_transform';
import './layout.css';

type Base={source_key:string; bounds:{min:number[];max:number[]};transform:number[];lengths:Record<string,number>};
type Asset={viewer_url?:string;run_id:string;base:Base;calibration:null|{axis:string;scale:number;dimensions_m:Record<string,number>}};
type Item={id:string;run_id:string;source_key:string;calibration:{axis:string;meters:number};metric_scale:number;user_scale:number;elevation:number;x:number;z:number;yaw:number;size:number[];base:Base};
type Room={id:string;label:string;url:string;structure:{floor_z:number;wall_height:number;walls:Record<string,{length:number}>;floor:Record<string,{polygon_xz:number[][];area_m2:number}>}};
type Layout={room_id:string;room_calibration:null|{wall:string;meters:number};room_scale:number;items:Item[];warnings?:string[];placement?:{item_id:string;support_id:string|null}};
type Visual={root:TransformNode;container?:AssetContainer;conversion?:TransformNode;state:string;dead:boolean};
const $=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const input=(id:string)=>$<HTMLInputElement>(id);
const select=(id:string)=>$<HTMLSelectElement>(id);
const num=(id:string)=>{const v=Number(input(id).value);if(!input(id).value.trim()||!Number.isFinite(v))throw Error('请输入有效数值');return v;};
const api='/viewforge/layouts/';
async function request(path:string,body?:unknown){const r=await fetch(api+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||`HTTP ${r.status}`);return d;}
function message(text:string,error=false){$('status').textContent=text;$('status').className=error?'error':'';}
function options(id:string,rows:[string,string][],value?:string){const el=select(id);el.replaceChildren(...rows.map(([v,t])=>new Option(t,v)));if(value&&rows.some(r=>r[0]===value))el.value=value;}
const canvas=$<HTMLCanvasElement>('canvas');
const engine=new Engine(canvas,true);const scene=new Scene(engine);scene.useRightHandedSystem=true;scene.clearColor=new Color4(.91,.94,.98,1);
const camera=new ArcRotateCamera('camera',-Math.PI/2,Math.PI/5,10,Vector3.Zero(),scene);camera.attachControl(canvas,true);camera.lowerRadiusLimit=.15;camera.wheelPrecision=30;camera.minZ=.01;
new HemisphericLight('light',new Vector3(0,1,0),scene);
const placementMarker=CreateSphere('placement-point',{diameter:.09,segments:12},scene);placementMarker.isPickable=false;placementMarker.setEnabled(false);const markerMaterial=new StandardMaterial('placement-point',scene);markerMaterial.emissiveColor=new Color3(1,.35,.02);placementMarker.material=markerMaterial;
camera.upperBetaLimit=Math.PI/2-.02;
engine.runRenderLoop(()=>scene.render());new ResizeObserver(()=>engine.resize()).observe(canvas);
canvas.addEventListener('wheel',e=>e.preventDefault(),{passive:false});
let rooms:Room[]=[];let layout:Layout|null=null;let asset:Asset|null=null;let roomVisual:AssetContainer|undefined;let roomRoot:TransformNode|undefined;
const rotationRing=CreateTorus('rotation-handle',{diameter:2,thickness:.035,tessellation:64},scene);const ringMaterial=new StandardMaterial('rotation-handle',scene);ringMaterial.disableLighting=true;ringMaterial.emissiveColor=new Color3(.12,.5,.95);rotationRing.material=ringMaterial;rotationRing.metadata={rotationHandle:true};rotationRing.setEnabled(false);
const visuals=new Map<string,Visual>();let generation=0;let busy=false;let dirty=false;let assetReadSequence=0;let pendingAssetRefresh=false;let choosingPlacement=false;let placementTarget:{support_id:string|null}|null=null;
function statusLoading(){ $('loading').textContent=[...visuals].filter(([,v])=>!v.dead&&!v.container).map(([id,v])=>`${layout?.items.find(i=>i.id===id)?.run_id||id}: ${v.state.startsWith('模型加载失败')?'模型加载失败，请重新打开布局重试':'正在载入物体…'}`).join('\n'); }
function controls(){for(const e of document.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input,select'))e.disabled=busy;for(const e of document.querySelectorAll<HTMLButtonElement>('button'))e.disabled=busy;select('room').disabled=busy||!!layout;select('wall').disabled=busy||!!layout;input('wall-length').disabled=busy||!!layout;$<HTMLButtonElement>('lock-room').disabled=busy||!!layout;$('lock-room').hidden=!!layout;$('new').hidden=!layout;if(!busy&&pendingAssetRefresh){pendingAssetRefresh=false;void refreshAsset();}}
async function action(fn:()=>Promise<void>){if(busy)return;busy=true;controls();message('正在处理…');try{await fn();if($('status').textContent==='正在处理…')message('操作完成');}catch(e){message(e instanceof Error?e.message:String(e),true);}finally{busy=false;controls();}}
function selected(){return layout?.items.find(i=>i.id===select('instances').value);}
function form(){updateHandle();const item=selected();if(!item)return;input('x').value=item.x.toFixed(3);input('y').value=(-item.z).toFixed(3);input('angle').value=(item.yaw*180/Math.PI).toFixed(1);input('scale').value=String(item.user_scale);input('elevation').value=String(item.elevation||0);$('sizes').textContent=`当前 X / Y / Z：${[item.size[0],item.size[2],item.size[1]].map(x=>x.toFixed(3)).join(' / ')} 米`;}
function updateItems(id?:string){options('instances',[['','未选中物体'],...(layout?.items||[]).map((i,n):[string,string]=>[i.id,`${n+1}. ${i.run_id}`])],id);form();}
function position(v:Visual,item:Item){v.root.position.set(item.x,rooms.find(r=>r.id===layout!.room_id)!.structure.floor_z*layout!.room_scale+(item.elevation||0),item.z);v.root.rotation.y=item.yaw;v.root.scaling.setAll(item.metric_scale*item.user_scale);}
async function loadGlb(url:string){const response=await fetch(url);if(!response.ok)throw Error(`模型加载失败 (${response.status})`);return LoadAssetContainerAsync(new Uint8Array(await response.arrayBuffer()),scene,{pluginExtension:'.glb'});}
async function showItem(item:Item){
 const root=new TransformNode(item.id,scene),v:Visual={root,state:'正在加载轻量预览',dead:false};visuals.set(item.id,v);position(v,item);statusLoading();
 const base=item.base,center=base.bounds.min.map((n,j)=>j===1?n:(n+base.bounds.max[j])/2);
 async function install(file:string){const container=await loadGlb(`${api}assets/${encodeURIComponent(item.run_id)}/${file}`);if(v.dead){container.dispose();return;}
  const conversion=new TransformNode('native-to-display',scene);conversion.parent=root;
  const matrix=Matrix.FromArray(base.transform).multiply(Matrix.Translation(-center[0],-center[1],-center[2]));conversion.setPreTransformMatrix(matrix);
  for(const node of container.rootNodes)node.parent=conversion;
  for(const m of container.meshes)m.metadata={instanceId:item.id};
  for(const m of container.materials)if(m instanceof PBRMaterial&&m.albedoTexture)m.unlit=true;
  container.addAllToScene();v.container?.dispose();v.conversion?.dispose();v.container=container;v.conversion=conversion;updateHandle();
 }
 try{await install('preview.glb');v.state='轻量预览已显示，全量模型加载中';}catch{v.state='轻量预览不可用，加载全量模型';}statusLoading();
 try{await install('result.glb');v.state='全量 GLB 已显示';}catch{v.state=v.container?'全量加载失败，保留轻量预览（重新打开布局可重试）':'模型加载失败（重新打开布局可重试）';}statusLoading();
}
function clear(){observation.finish();manipulation.cancel();choosingPlacement=false;placementTarget=null;rotationRing.setEnabled(false);generation++;placementMarker.setEnabled(false);for(const v of visuals.values()){v.dead=true;v.container?.dispose();v.root.dispose();}visuals.clear();roomVisual?.dispose();roomVisual=undefined;roomRoot?.dispose();roomRoot=undefined;statusLoading();}
async function displayRoom(){const g=generation;const r=rooms.find(r=>r.id===(layout?.room_id||select('room').value))!;if(!r)return;const roomScale=layout?.room_scale||1;const c=await loadGlb(r.url);if(g!==generation){c.dispose();return;}roomVisual=c;
 const root=new TransformNode('room-scale',scene);roomRoot=root;root.scaling.setAll(roomScale);for(const n of c.rootNodes)n.parent=root;c.addAllToScene();
 for(const m of c.meshes){if(/ceiling/i.test(m.name))m.setEnabled(false);m.metadata={room:true};if(/wall/i.test(m.name)&&m.material){const material=m.material.clone('layout-'+m.name);if(material){m.material=material;c.materials.push(material);}}}
 wallAppearance();
 const poly=Object.values(r.structure.floor)[0].polygon_xz,s=roomScale;
 const xs=poly.map(p=>p[0]*s),zs=poly.map(p=>p[1]*s);camera.setTarget(new Vector3((Math.min(...xs)+Math.max(...xs))/2,(r.structure.floor_z+r.structure.wall_height/3)*s,(Math.min(...zs)+Math.max(...zs))/2));camera.radius=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...zs)-Math.min(...zs))*1.6;
 input('x').value=String(camera.target.x.toFixed(3));input('y').value=String((-camera.target.z).toFixed(3));
}
function wallAppearance(){for(const m of roomVisual?.meshes||[]){if(!/wall/i.test(m.name)||!m.material)continue;m.material.alpha=input('transparent-walls').checked?.23:1;if(m.material instanceof PBRMaterial){m.material.transparencyMode=input('transparent-walls').checked?2:0;m.material.emissiveColor=m.name===select('wall').value?new Color3(.28,.07,0):Color3.Black();}}}
function roomInfo(){const r=rooms.find(r=>r.id===select('room').value);if(!r)return;options('wall',Object.entries(r.structure.walls).map(([name,w])=>[name,`${name} · ${w.length.toFixed(3)} m`]),layout?.room_calibration?.wall||select('wall').value);if(layout){input('wall-length').value=layout.room_calibration?String(layout.room_calibration.meters):'';$('room-info').textContent=`尺寸已固定 · 层高 ${(r.structure.wall_height*layout.room_scale).toFixed(3)} m · 面积 ${(Object.values(r.structure.floor)[0].area_m2*layout.room_scale**2).toFixed(2)} m² · 房间比例 ${layout.room_scale.toFixed(4)}`;}else $('room-info').textContent=`${r.label}；原始层高 ${r.structure.wall_height.toFixed(3)} m。确认后固定本布局的尺度。`;wallAppearance();}
async function catalog(){const d=await request('catalog');rooms=d.rooms;options('room',rooms.map(r=>[r.id,r.label]),layout?.room_id||select('room').value);options('asset',d.runs.map((r:string)=>[r,r]),select('asset').value);options('saved',d.layouts.map((r:string)=>[r,r]),select('saved').value);roomInfo();if(!rooms.length)message('没有可用房间：请检查服务器房间结构与 GLB 配置',true);}
async function validated(candidate:Layout){message('正在检查碰撞…');const result=await request('validate',candidate);return result.layout as Layout;}
function accepted(next:Layout){layout=next;dirty=true;message(`已应用，尺寸与碰撞检查通过。${next.warnings?.length?'\n'+next.warnings.join('\n'):''}`);}
function bind(id:string,fn:()=>Promise<void>){$(id).onclick=()=>void action(fn);}
select('room').onchange=()=>void action(async()=>{roomInfo();clear();await displayRoom();});select('wall').onchange=()=>{if(!layout)input('wall-length').value='';wallAppearance();};input('transparent-walls').onchange=wallAppearance;select('instances').onchange=form;
select('axis').onchange=()=>{input('measure').value=asset?.calibration?String(asset.calibration.dimensions_m[select('axis').value]):'';};
select('asset').onchange=()=>{asset=null;assetReadSequence++;$('asset-preview').hidden=true;$('asset-info').textContent='正在读取尺寸…';void action(()=>readAsset(true));};
bind('refresh',async()=>{await catalog();await readAsset();});
bind('lock-room',async()=>{if(!select('room').value)throw Error('没有可用房间');const cal=input('wall-length').value.trim()?{wall:select('wall').value,meters:num('wall-length')}:null;layout=await validated({room_id:select('room').value,room_calibration:cal,room_scale:1,items:[]});clear();roomInfo();await displayRoom();dirty=true;message(`房间尺寸已固定，比例 ${layout.room_scale.toFixed(4)}。现在可以加入物体。`);});
bind('new',async()=>{if(dirty&&!window.confirm('当前布局有未保存内容，仍要新建吗？'))return;clear();layout=null;dirty=false;roomInfo();updateItems();await displayRoom();message('请选择房间并确认尺寸');});
async function readAsset(force=false,background=false){
 const id=select('asset').value;if(!id)return;
 const sequence=++assetReadSequence;
 const data:Asset=await request(`assets/${encodeURIComponent(id)}`);
 if(sequence!==assetReadSequence||select('asset').value!==id)return;
 if(background&&busy){pendingAssetRefresh=true;return;}
 const changed=!asset||asset.run_id!==id||JSON.stringify(asset.calibration)!==JSON.stringify(data.calibration);
 asset=data;
 const link=$<HTMLAnchorElement>('asset-preview');link.hidden=!data.viewer_url;if(data.viewer_url)link.href=data.viewer_url;
 if(force||changed){if(data.calibration){select('axis').value=data.calibration.axis;input('measure').value=String(data.calibration.dimensions_m[data.calibration.axis]);}else input('measure').value='';}
 $('asset-brief').textContent=data.calibration?`已标定 · ${['X','Y','Z'].map(k=>data.calibration!.dimensions_m[k].toFixed(2)).join(' × ')} 米`:'未标定：展开物体详情，或打开独立预览保存尺寸。';
 $('asset-info').textContent=data.calibration?`已读取保存尺寸：X / Y / Z = ${['X','Y','Z'].map(k=>data.calibration!.dimensions_m[k].toFixed(3)).join(' / ')} 米。可直接加入场景。`:'尚未标定：可打开上方独立预览保存尺寸，返回后自动读取；也可在这里输入。';
 if(changed&&data.calibration)message('已读取物体标定，新加入的物体将使用此尺寸；已放置物体保持原尺寸。');
}
async function refreshAsset(){if(busy){pendingAssetRefresh=true;return;}try{await readAsset(false,true);}catch(error){message('读取物体尺寸失败，请点击“重新读取已保存尺寸”。',true);}}
window.addEventListener('focus',()=>void refreshAsset());
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshAsset();});
window.addEventListener('storage',e=>{if(e.key==='viewforge-dimensions-changed')void refreshAsset();});
bind('read-asset',()=>readAsset(true));
bind('add',async()=>{if(!layout)throw Error('请先确认房间尺寸');await readAsset();if(!asset||asset.run_id!==select('asset').value)throw Error('请先读取当前物体尺寸');const item={id:Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join(''),run_id:asset.run_id,source_key:asset.base.source_key,base:asset.base,calibration:{axis:select('axis').value,meters:num('measure')},metric_scale:1,user_scale:1,elevation:num('elevation'),x:num('x'),z:-num('y'),yaw:num('angle')*Math.PI/180,size:[0,0,0]};const next=await validated({...layout,items:[...layout.items,item],...(placementTarget?{placement:{item_id:item.id,...placementTarget}}:{})});accepted(next);const final=next.items.at(-1)!;updateItems(final.id);void showItem(final);});
async function apply(reset=false){const item=selected();if(!layout||!item)throw Error('请选择一个已加入的物体');const change={...item,elevation:num('elevation'),x:num('x'),z:-num('y'),yaw:num('angle')*Math.PI/180,user_scale:reset?1:num('scale')};const next=await validated({...layout,items:layout.items.map(i=>i.id===item.id?change:i)});accepted(next);position(visuals.get(item.id)!,next.items.find(i=>i.id===item.id)!);form();}
bind('apply',()=>apply());bind('reset-scale',()=>apply(true));
bind('delete',async()=>{const item=selected();if(!layout||!item)return;const v=visuals.get(item.id)!;v.dead=true;v.container?.dispose();v.root.dispose();visuals.delete(item.id);layout.items=layout.items.filter(i=>i.id!==item.id);dirty=true;updateItems();statusLoading();message('已移除物体');});
bind('save',async()=>{if(!layout)throw Error('请先创建布局');const r=await request('save',layout);layout=r.layout;dirty=false;await catalog();select('saved').value=r.id;message('布局快照已保存：'+r.id);});
bind('restore',async()=>{if(!select('saved').value)throw Error('没有已保存布局');if(dirty&&!window.confirm('打开保存布局将替换未保存内容，继续吗？'))return;const next=await validated(await request(select('saved').value));clear();layout=next;await displayRoom();select('room').value=next.room_id;roomInfo();updateItems();for(const i of next.items)void showItem(i);dirty=false;message('已恢复布局及固定尺寸'+(next.warnings?.length?'\n'+next.warnings.join('\n'):''));});
// Native mouse capture and gesture input share the same candidate/validation transaction.
type CanvasPoint={x:number;y:number;clientX:number;clientY:number};
type Interaction={pointer:number|null;source:OperationSource;anchor:Vector3;angle:number;mode:OperationMode;ring:boolean;support_id:string|null;autoSurface:boolean;clientX:number;clientY:number;validatedLayout?:Layout};
let activePreview:Item|null=null;
function floorHeight(){return rooms.find(r=>r.id===layout!.room_id)!.structure.floor_z*layout!.room_scale;}
function mode(){return select('mouse-mode').value;}
function updateHandle(){
 const selection=selected();const item=selection?.id===activePreview?.id?activePreview:selection;rotationRing.setEnabled(!!item&&mode()!=='view'&&visuals.has(item.id));
 if(item&&layout){const diameter=Math.hypot(item.size[0],item.size[2])+.25;rotationRing.scaling.set(diameter/2,1,diameter/2);rotationRing.position.set(item.x,floorHeight()+(item.elevation||0)+.025,item.z);}
 for(const [id,v] of visuals)for(const mesh of v.container?.meshes||[])mesh.showBoundingBox=id===item?.id&&mode()!=='view'&&mesh.getTotalVertices()>0;
}
function pointerPosition(e:PointerEvent):CanvasPoint{const r=canvas.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top,clientX:e.clientX,clientY:e.clientY};}
function gesturePosition(p:GesturePointer):CanvasPoint{const r=canvas.getBoundingClientRect();return {x:p.u*r.width,y:p.v*r.height,clientX:r.left+p.u*r.width,clientY:r.top+p.v*r.height};}
function planePoint(p:CanvasPoint,height:number){const ray=scene.createPickingRay(p.x,p.y,Matrix.Identity(),camera);if(Math.abs(ray.direction.y)<1e-5)return null;const t=(height-ray.origin.y)/ray.direction.y;return t>0?ray.origin.add(ray.direction.scale(t)):null;}
function surfaceTarget(p:CanvasPoint,exclude?:string){
 const hit=scene.pick(p.x,p.y,m=>!!m.metadata?.instanceId&&m.metadata.instanceId!==exclude);
 if(hit?.hit&&hit.pickedPoint)return {point:hit.pickedPoint,support_id:hit.pickedMesh!.metadata.instanceId as string};
 const point=planePoint(p,floorHeight());return point?{point,support_id:null}:null;
}
const manipulation:Manipulation<Item,Interaction>=new Manipulation<Item,Interaction>({
 preview(operation){
  const item=operation.candidate;activePreview=item;position(visuals.get(item.id)!,item);updateHandle();
  markerMaterial.emissiveColor.set(1,.35,.02);placementMarker.position.set(item.x,floorHeight()+.045,item.z);placementMarker.setEnabled(true);
  input('x').value=item.x.toFixed(3);input('y').value=(-item.z).toFixed(3);input('angle').value=(item.yaw*180/Math.PI).toFixed(1);
  message(operation.context.mode==='move'&&operation.context.autoSurface?'松开后自动计算承托高度并检查碰撞；当前为位置预览。':'当前为位置预览，松开后验证碰撞并确认。');
 },
 async validate(operation){
  const {original,candidate,context}=operation;
  const next=await validated({...layout!,items:layout!.items.map(i=>i.id===original.id?candidate:i),...(context.mode==='move'&&context.autoSurface?{placement:{item_id:original.id,support_id:context.support_id}}:{})});
  context.validatedLayout=next;
  return next.items.find(i=>i.id===original.id)!;
 },
 accept(item){accepted(manipulation.current!.context.validatedLayout!);position(visuals.get(item.id)!,item);},
 restore(item){const visual=visuals.get(item.id);if(visual&&!visual.dead)position(visual,item);},
 finish(context){
  activePreview=null;placementMarker.setEnabled(false);
  if(context.pointer!==null&&canvas.hasPointerCapture(context.pointer))canvas.releasePointerCapture(context.pointer);
  camera.attachControl(canvas,true);busy=false;controls();form();
 },
 error(error){message(`${error instanceof Error?error.message:String(error)}；已恢复操作前的位置。`,true);},
});
function cancelManipulation(){if(manipulation.cancel())message('已取消操作，保留原位置');}
function beginManipulation(id:string,p:CanvasPoint,operationMode:OperationMode,source:OperationSource,pointer:number|null=null,ring=false){
 if(busy||!layout||choosingPlacement)return false;
 const item=layout.items.find(i=>i.id===id),visual=visuals.get(id);if(!item||!visual?.container||visual.dead)return false;
 const anchor=planePoint(p,floorHeight()+(item.elevation||0));if(!anchor)return false;
 const context:Interaction={pointer,source,anchor,angle:Math.atan2(anchor.z-item.z,anchor.x-item.x),mode:operationMode,ring,support_id:null,autoSurface:input('auto-surface').checked,clientX:p.clientX,clientY:p.clientY};
 if(!manipulation.begin(item,context))return false;
 camera.detachControl();camera.inertialAlphaOffset=0;camera.inertialBetaOffset=0;camera.inertialRadiusOffset=0;
 select('instances').value=id;activePreview=manipulation.current!.candidate;busy=true;controls();form();
 message(operationMode==='rotate'?'自由旋转；松开检查碰撞，Esc 取消。':'移动模型；松开检查承托与碰撞，Esc 取消。');return true;
}
function updateManipulation(p:CanvasPoint,gestureRotation?:number){
 const op=manipulation.current;if(!op||manipulation.phase!=='preview')return;
 const d=op.context;
 if(gestureRotation!==undefined){if(Math.abs(gestureRotation)<.001&&!op.moved)return;manipulation.update(o=>{o.candidate.yaw=o.original.yaw+gestureRotation;});return;}
 const target=d.mode==='move'&&d.autoSurface?surfaceTarget(p,op.original.id):null;
 const point=target?.point||planePoint(p,floorHeight()+(op.original.elevation||0));if(!point)return;
 if(Math.hypot(p.clientX-d.clientX,p.clientY-d.clientY)<3&&!op.moved)return;
 manipulation.update(o=>{
  if(d.mode==='rotate')o.candidate.yaw=d.ring?rotationFromPointer(o.original.yaw,d.angle,Math.atan2(point.z-o.original.z,point.x-o.original.x)):rotationFromPointer(o.original.yaw,0,-(p.clientX-d.clientX)*.01);
  else {Object.assign(o.candidate,translationFromPointer(o.original.x,o.original.z,d.anchor.x,d.anchor.z,point.x,point.z));if(target){d.support_id=target.support_id;o.candidate.elevation=Math.max(0,target.point.y-floorHeight());}}
 });
}
function stopCameraInertia(){camera.inertialAlphaOffset=0;camera.inertialBetaOffset=0;camera.inertialRadiusOffset=0;camera.inertialPanningX=0;camera.inertialPanningY=0;}
const observation=new CameraObservation({
 read(){
  const inverse=camera.getViewMatrix(true).clone().invert();
  return {alpha:camera.alpha,beta:camera.beta,radius:camera.radius,target:camera.target.asArray() as [number,number,number],
   right:Vector3.TransformNormal(Vector3.Right(),inverse).normalize().asArray() as [number,number,number],
   up:Vector3.TransformNormal(Vector3.Up(),inverse).normalize().asArray() as [number,number,number],
   fov:camera.fov,aspect:engine.getAspectRatio(camera),lowerBeta:camera.lowerBetaLimit??.05,upperBeta:camera.upperBetaLimit??Math.PI/2-.02};
 },
 apply(pose){camera.setTarget(Vector3.FromArray(pose.target),false,true,true);camera.alpha=pose.alpha;camera.beta=pose.beta;camera.radius=pose.radius;stopCameraInertia();camera.getViewMatrix(true);},
 begin(){camera.detachControl();stopCameraInertia();busy=true;controls();},
 end(){stopCameraInertia();camera.attachControl(canvas,true);busy=false;controls();},
});
let mouseHeld=false;
const gestureCursor=document.createElement('div');gestureCursor.className='gesture-cursor';gestureCursor.hidden=true;gestureCursor.setAttribute('aria-label','右手指针');canvas.parentElement!.append(gestureCursor);
const helperCursor=document.createElement('div');helperCursor.className='gesture-cursor gesture-helper';helperCursor.hidden=true;helperCursor.setAttribute('aria-label','左手指针');canvas.parentElement!.append(helperCursor);
function displayCursor(cursor:HTMLElement,point:GesturePointer|null){cursor.hidden=!point;if(point){const r=canvas.getBoundingClientRect(),parent=canvas.parentElement!.getBoundingClientRect();cursor.style.left=`${r.left-parent.left+point.u*r.width}px`;cursor.style.top=`${r.top-parent.top+point.v*r.height}px`;}}
const gestures=new GestureInput({
 blocked:()=>busy||mouseHeld||(!layout&&mode()!=='view')||choosingPlacement,
 mode,
 begin(point,operationMode){const p=gesturePosition(point);const pick=scene.pick(p.x,p.y,m=>!!m.metadata?.instanceId);const id=pick?.pickedMesh?.metadata?.instanceId;return typeof id==='string'&&beginManipulation(id,p,operationMode,'gesture');},
 move:point=>updateManipulation(gesturePosition(point)),
 rotate:delta=>updateManipulation(gesturePosition({u:0,v:0}),delta),
 commit:()=>manipulation.commit(),
 cancel(){if(manipulation.current?.context.source==='gesture')cancelManipulation();},
 observe:{
  begin(point,action){if(busy||mouseHeld||!roomVisual||choosingPlacement)return false;const started=observation.begin(point,action);if(started)message(action==='orbit'?'两指捏合环绕观察；松开固定视角。':'三指合拢平移视角；松开固定视角。');return started;},
  update:point=>observation.update(point),
  finish(cancel){observation.finish(cancel);message(cancel?'已取消观察调整，恢复原视角。':'观察视角已固定；松手后可开始下一次操作。');},
 },
 pointer:point=>displayCursor(gestureCursor,point),
 helperPointer:point=>displayCursor(helperCursor,point),
});
select('mouse-mode').onchange=()=>{gestures.reset();stopCameraInertia();updateHandle();};
canvas.addEventListener('pointerdown',e=>{
 if(e.button!==0)return;mouseHeld=true;gestures.reset();
 if(busy||!layout||mode()==='view'||choosingPlacement)return;
 const p=pointerPosition(e);const pick=scene.pick(p.x,p.y,m=>!!m.metadata?.instanceId||m===rotationRing);
 const ring=pick?.pickedMesh===rotationRing;const id=ring?selected()?.id:pick?.pickedMesh?.metadata?.instanceId;
 if(typeof id!=='string'||!beginManipulation(id,p,ring?'rotate':mode() as OperationMode,'mouse',e.pointerId,ring))return;
 e.preventDefault();e.stopImmediatePropagation();canvas.setPointerCapture(e.pointerId);
},true);
canvas.addEventListener('pointermove',e=>{
 const d=manipulation.current?.context;if(!d||d.source!=='mouse'||e.pointerId!==d.pointer)return;
 e.preventDefault();e.stopImmediatePropagation();updateManipulation(pointerPosition(e));
},true);
canvas.addEventListener('pointerup',e=>{
 mouseHeld=false;const d=manipulation.current?.context;if(!d||d.source!=='mouse'||e.pointerId!==d.pointer)return;
 e.preventDefault();e.stopImmediatePropagation();void manipulation.commit();
},true);
canvas.addEventListener('pointercancel',()=>{mouseHeld=false;gestures.reset();cancelManipulation();},true);
canvas.addEventListener('lostpointercapture',()=>{if(manipulation.phase==='preview'&&manipulation.current?.context.source==='mouse')cancelManipulation();});
window.addEventListener('blur',()=>{mouseHeld=false;gestures.reset();if(manipulation.phase==='preview')cancelManipulation();});
window.addEventListener('pointerup',()=>{mouseHeld=false;});
window.addEventListener('pointercancel',()=>{mouseHeld=false;});
window.addEventListener('keydown',e=>{if(e.key==='Escape'){gestures.reset();cancelManipulation();}});
connectGestureBridge({input:gestures,setMode(value){if(busy)return false;select('mouse-mode').value=value;stopCameraInertia();updateHandle();message(value==='view'?'仅观察：右手两指捏合环绕，三指合拢平移。':value==='move'?'移动模式：指向物体并捏合拖动。':'旋转模式：指向物体并捏合，左右移动自由旋转。');return true;},state:()=>({busy,mode:mode(),selectedId:selected()?.id||null,layoutReady:!!layout,phase:observation.active?'observing':manipulation.phase,message:$('status').textContent||'',capabilities:['observe-pinch-v1']})});
bind('pick-placement',async()=>{if(!layout)throw Error('请先确认房间尺寸');choosingPlacement=true;message('请点击地板或沙发等物体表面，选择新物体的放置位置。');});
scene.onPointerObservable.add(info=>{
 if(info.type!==PointerEventTypes.POINTERTAP||busy||!layout||(!choosingPlacement&&mode()==='view'))return;
 const target=surfaceTarget(pointerPosition(info.event as PointerEvent));if(!target)return;
 const {point,support_id}=target;placementTarget={support_id};choosingPlacement=false;
 markerMaterial.emissiveColor.set(1,.35,.02);placementMarker.position.set(point.x,point.y+.045,point.z);placementMarker.setEnabled(true);
 input('x').value=point.x.toFixed(3);input('y').value=(-point.z).toFixed(3);input('elevation').value=Math.max(0,point.y-floorHeight()).toFixed(3);
 message(support_id?'已选中物体表面，点击“加入场景”将自动计算承托高度。':'已选择地面位置，点击“加入场景”。');
});
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
Object.defineProperty(window,'__viewforgeLayout',{get:()=>({layout,busy,camera:{alpha:camera.alpha,beta:camera.beta,radius:camera.radius,target:camera.target.asArray()},observation:observation.action,handlePosition:rotationRing.position.asArray(),screenPositions:(layout?.items||[]).map(i=>{const p=Vector3.Project(new Vector3(i.x,floorHeight()+(i.elevation||0)+i.size[1]/2,i.z),Matrix.Identity(),scene.getTransformMatrix(),camera.viewport.toGlobal(engine.getRenderWidth(),engine.getRenderHeight()));const rect=canvas.getBoundingClientRect();return {id:i.id,x:p.x+rect.left,y:p.y+rect.top};}),visuals:[...visuals.values()].map(v=>v.state),bounds:[...visuals.values()].map(v=>{const b=v.root.getHierarchyBoundingVectors(true);return {min:b.min.asArray(),max:b.max.asArray()};})})});
void action(async()=>{await catalog();await readAsset();await displayRoom();if(rooms.length)message('已有房间已加载。确认尺寸后，读取物体尺寸并加入；点击地面设置橙色摆放点。');});
