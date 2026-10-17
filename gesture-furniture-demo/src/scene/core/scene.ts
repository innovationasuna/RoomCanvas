import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { CameraPose, ObjectInfo, Point, Pointer, SceneId, ScenePort, Transform } from '../../shared/types';
import { CONFIG, clamp } from '../../shared/config';
import { copyTransform } from '../../controls/mapping';
import { CATALOG } from '../furniture/catalog';
import { TargetTask, TARGETS } from '../xyz/targets';

export class Scene implements ScenePort {
  active: SceneId = 'furniture';
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(42, 1, 0.05, 100);
  readonly task = new TargetTask();
  private world = new THREE.Scene();
  private roots = { furniture: new THREE.Group(), xyz: new THREE.Group() };
  private objects = new Map<string, THREE.Object3D>();
  private sizes = new Map<string, Point>();
  private initial: Record<SceneId, Record<string, Transform>> = { furniture: {}, xyz: {} };
  private cameraPoses: Record<SceneId, CameraPose> = { furniture: { theta: 0.78, phi: 1.02, radius: 9.8 }, xyz: {theta:0.4,phi:1.18,radius:8.3} };
  private ray = new THREE.Raycaster();
  private floor = new THREE.Plane(new THREE.Vector3(0,1,0),0);
  private selected?: string;
  private outline = new THREE.BoxHelper(new THREE.Object3D(), '#bd6a3c');
  private target = new THREE.Group();
  private projection: THREE.Line;
  private projectionDot: THREE.Mesh;
  private resizeObserver: ResizeObserver;
  private environment: THREE.WebGLRenderTarget;
  private frameTimes: number[] = [];
  private lastTime?: number;
  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 0.92;
    this.world.background = new THREE.Color('#e9e6de');
    const pmrem = new THREE.PMREMGenerator(this.renderer); const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room,0.04); this.world.environment = this.environment.texture; this.world.environmentIntensity = 0.55; room.dispose(); pmrem.dispose();
    this.world.add(this.roots.furniture,this.roots.xyz); this.roots.xyz.visible = false;
    this.world.add(new THREE.HemisphereLight('#fff5df','#a4ad9d',0.9));
    const sun = new THREE.DirectionalLight('#fff1d8',2.5); sun.position.set(-2,7,4); sun.castShadow = true;
    sun.shadow.mapSize.set(2048,2048); sun.shadow.camera.left=-5; sun.shadow.camera.right=5; sun.shadow.camera.top=5; sun.shadow.camera.bottom=-5;
    sun.shadow.normalBias=0.025; this.world.add(sun);
    const fill = new THREE.DirectionalLight('#d7e6f3',0.6); fill.position.set(4,3,-1); this.world.add(fill);
    this.outline.visible=false; this.world.add(this.outline);
    this.buildXYZ();
    this.projection = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]),new THREE.LineDashedMaterial({color:'#648070',dashSize:0.07,gapSize:0.06}));
    this.projectionDot = new THREE.Mesh(new THREE.RingGeometry(0.1,0.13,32),new THREE.MeshBasicMaterial({color:'#648070',side:THREE.DoubleSide}));
    this.projectionDot.rotation.x=-Math.PI/2; this.roots.xyz.add(this.projection,this.projectionDot);
    this.initial.xyz = this.snapshotFor('xyz');
    this.resizeObserver = new ResizeObserver(()=>this.resize()); this.resizeObserver.observe(canvas.parentElement!); this.resize();
    this.setCamera(this.cameraPoses.furniture);
  }
  async load() {
    const loader = new GLTFLoader();
    const assets = await Promise.all([loader.loadAsync('/models/room/room.glb'),...CATALOG.map(c=>loader.loadAsync(c.path))]);
    this.roots.furniture.add(assets[0].scene);
    CATALOG.forEach((c,i)=>{
      const object=assets[i+1].scene; object.name=c.id;
      object.position.set(c.position.x,c.position.y,c.position.z); object.rotation.y=c.rotation;
      this.objects.set(c.id,object); this.roots.furniture.add(object);
      const local = object.clone(); local.position.set(0,0,0); local.rotation.set(0,0,0); local.updateMatrixWorld(true);
      const bounds=new THREE.Box3().setFromObject(local);
      // Enclose around the pivot: offset backs/cushions must also stay inside the room.
      this.sizes.set(c.id,{x:2*Math.max(Math.abs(bounds.min.x),Math.abs(bounds.max.x)),y:bounds.max.y,z:2*Math.max(Math.abs(bounds.min.z),Math.abs(bounds.max.z))});
    });
    this.roots.furniture.traverse(object=>{ if(object instanceof THREE.Mesh) { object.castShadow=true; object.receiveShadow=true; } });
    this.initial.furniture=this.snapshotFor('furniture');
  }
  private buildXYZ() {
    const root=this.roots.xyz;
    const ground=new THREE.Mesh(new THREE.PlaneGeometry(6,5),new THREE.MeshStandardMaterial({color:'#e1dfd4',roughness:1}));
    ground.rotation.x=-Math.PI/2; ground.receiveShadow=true; root.add(ground);
    const grid=new THREE.GridHelper(5,20,'#929f93','#c5cbbf'); grid.position.y=0.006; root.add(grid);
    const boundary = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(5,2.8,4)),new THREE.LineBasicMaterial({color:'#b5bdb0',transparent:true,opacity:0.45})); boundary.position.y=1.4; root.add(boundary);
    const cursor=new THREE.Mesh(new THREE.SphereGeometry(0.085,32,24),new THREE.MeshStandardMaterial({color:'#c17547',roughness:0.35,metalness:0.12}));
    cursor.position.set(0,1.2,0); cursor.castShadow=true; root.add(cursor); this.objects.set('cursor',cursor); this.sizes.set('cursor',{x:0.17,y:0.17,z:0.17});
    const shell=new THREE.Mesh(new THREE.SphereGeometry(0.1,24,16),new THREE.MeshBasicMaterial({color:'#6b947c',wireframe:true,transparent:true,opacity:0.4}));
    const halo=new THREE.Mesh(new THREE.TorusGeometry(0.14,0.007,8,48),new THREE.MeshBasicMaterial({color:'#5f816b'}));
    this.target.add(shell,halo); root.add(this.target);
  }
  private resize() { const r=this.canvas.parentElement!.getBoundingClientRect(); this.renderer.setSize(r.width,r.height,false); this.camera.aspect=r.width/Math.max(1,r.height); this.camera.updateProjectionMatrix(); }
  pick(pointer: Pointer) {
    if(this.active==='xyz') return 'cursor';
    this.ray.setFromCamera(new THREE.Vector2(pointer.x*2-1,1-pointer.y*2),this.camera);
    const hits=this.ray.intersectObjects(CATALOG.map(c=>this.objects.get(c.id)).filter((o):o is THREE.Object3D=>!!o),true);
    if(!hits.length) return undefined;
    let object: THREE.Object3D | null=hits[0].object;
    while(object) { if(this.objects.get(object.name)===object) return object.name; object=object.parent; }
    return undefined;
  }
  floorPoint(pointer: Pointer) {
    this.ray.setFromCamera(new THREE.Vector2(pointer.x*2-1,1-pointer.y*2),this.camera);
    const p=this.ray.ray.intersectPlane(this.floor,new THREE.Vector3());
    return p ? {x:p.x,y:p.y,z:p.z}:undefined;
  }
  info(id:string):ObjectInfo|undefined {
    const object=this.objects.get(id); if(!object) return;
    return {id,label:CATALOG.find(c=>c.id===id)?.label??'三维光标',size:this.sizes.get(id)!,transform:{position:{x:object.position.x,y:object.position.y,z:object.position.z},rotation:object.rotation.y,scale:object.scale.x}};
  }
  apply(id:string,t:Transform) { const object=this.objects.get(id); if(!object)return; object.position.set(t.position.x,t.position.y,t.position.z); object.rotation.y=t.rotation; object.scale.setScalar(t.scale); object.updateMatrixWorld(true); }
  highlight(id?:string) { this.selected=id; const object=id?this.objects.get(id):undefined; this.outline.visible=!!object; if(object)this.outline.setFromObject(object); }
  getCamera(){return {...this.cameraPoses[this.active]};}
  setCamera(pose:CameraPose) {
    const p={theta:pose.theta,phi:clamp(pose.phi,0.25,1.45),radius:clamp(pose.radius,3.5,14)};this.cameraPoses[this.active]=p;
    const target=new THREE.Vector3(0,this.active==='xyz'?1.1:0.65,0);
    this.camera.position.setFromSphericalCoords(p.radius,p.phi,p.theta).add(target);this.camera.lookAt(target);this.camera.updateMatrixWorld(true);
  }
  cameraAxes(){
    const forward=this.camera.getWorldDirection(new THREE.Vector3());const right=new THREE.Vector3(1,0,0).applyQuaternion(this.camera.quaternion);const up=new THREE.Vector3(0,1,0).applyQuaternion(this.camera.quaternion);
    const point=(v:THREE.Vector3):Point=>({x:v.x,y:v.y,z:v.z});return {forward:point(forward),right:point(right),up:point(up)};
  }
  switchScene(scene:SceneId){this.active=scene;this.roots.furniture.visible=scene==='furniture';this.roots.xyz.visible=scene==='xyz';this.highlight();this.setCamera(this.cameraPoses[scene]);}
  private snapshotFor(scene:SceneId){const out:Record<string,Transform>={};for(const id of scene==='xyz'?['cursor']:CATALOG.map(c=>c.id)){const info=this.info(id);if(info)out[id]=copyTransform(info.transform);}return out;}
  snapshot(){return this.snapshotFor(this.active);}
  restore(snapshot:Record<string,Transform>){for(const [id,t]of Object.entries(snapshot))this.apply(id,t);}
  reset(){this.restore(this.initial[this.active]);this.cameraPoses[this.active]=this.active==='xyz'?{theta:0.4,phi:1.18,radius:8.3}:{theta:0.78,phi:1.02,radius:9.8};this.setCamera(this.cameraPoses[this.active]);if(this.active==='xyz')this.task.reset();}
  render(now:number,running:boolean){
    if(this.lastTime!==undefined){this.frameTimes.push(now-this.lastTime);if(this.frameTimes.length>120)this.frameTimes.shift();}this.lastTime=now;
    if(this.selected)this.outline.update();
    if(this.active==='xyz'){
      const position=this.info('cursor')!.transform.position;this.task.update(position,now,running);
      this.target.visible=!this.task.complete;if(!this.task.complete){const t=TARGETS[this.task.index];this.target.position.set(t.x,t.y,t.z);this.target.rotation.y=now*0.0003;}
      this.projection.geometry.setFromPoints([new THREE.Vector3(position.x,0.015,position.z),new THREE.Vector3(position.x,position.y,position.z)]);this.projection.computeLineDistances();this.projectionDot.position.set(position.x,0.018,position.z);
    }
    this.renderer.render(this.world,this.camera);
  }
  get fps(){if(!this.frameTimes.length)return 0;const sorted=[...this.frameTimes].sort((a,b)=>a-b);return Math.round(1000/sorted[Math.floor(sorted.length/2)]);}
  dispose(){this.resizeObserver.disconnect();const geometries=new Set<THREE.BufferGeometry>();const materials=new Set<THREE.Material>();this.world.traverse(o=>{if(o instanceof THREE.Mesh||o instanceof THREE.Line){geometries.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:[o.material])materials.add(m);}});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());this.environment.dispose();this.renderer.dispose();}
}
