// Actual app material rendering for opt-in fixed-geometry material experiments.
import {parseArgs} from 'node:util';
import {createRequire} from 'node:module';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const {values} = parseArgs({options:{root:{type:'string'},stage:{type:'string',default:'manual'},
  url:{type:'string',default:'http://127.0.0.1:18180/'},playwright:{type:'string'},browser:{type:'string'}}});
if(!values.root || !['manual','estimated'].includes(values.stage))throw new Error('Pass --root and --stage manual|estimated');
const root=resolve(values.root),require=createRequire(import.meta.url);
const {chromium}=require(values.playwright?resolve(values.playwright):'playwright');
const models={};
const kinds=values.stage==='manual'?['baseline','manual_roughness','procedural_normal','manual_combined']:
  ['baseline','manual_roughness','estimated_roughness','estimated_mr','estimated_full'];
for(const profile of ['plush','sofa']){
  const manifest=JSON.parse(await readFile(join(root,'variants',profile,'variants.json'),'utf8'));
  for(const kind of kinds){
    const key=profile+'_'+kind;
    models[key]={profile,kind,path:kind==='baseline'?manifest.source:manifest.variants[kind].path,
      origin:kind==='baseline'?{method:'native_mv_colour_baking_fixed_factors'}:manifest.variants[kind].origin};
  }
}
const browser=await chromium.launch({headless:true,...(values.browser?{executablePath:values.browser}:{})});
try{
  const page=await browser.newPage({viewport:{width:800,height:800},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.route('**/__material_trial__',route=>route.fulfill({contentType:'text/html',body:
    '<link rel="icon" href="data:,"><style>body{margin:0}</style><script type="importmap">'+JSON.stringify({imports:{
      three:new URL('web/vendor/build/three.module.js',values.url).href,
      'three/addons/':new URL('web/vendor/examples/jsm/',values.url).href}})+'</script>'}));
  await page.route('**/__material_glb__/*',async route=>{
    const key=new URL(route.request().url()).pathname.split('/').pop();
    if(!models[key])return route.abort();
    await route.fulfill({contentType:'model/gltf-binary',body:await readFile(models[key].path)});
  });
  await page.goto(new URL('__material_trial__',values.url).href);
  const device=await page.evaluate(async base=>{
    const THREE=await import('three');
    const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
    const {createImportMaterials}=await import(new URL('web/editor/import-materials.mjs',base));
    const {createEnvironmentLighting}=await import(new URL('web/editor/environment-lighting.mjs',base));
    const {createRenderMetrics}=await import(new URL('web/editor/render-metrics.mjs',base));
    const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'low-power',preserveDrawingBuffer:true});
    renderer.setSize(800,800);renderer.setPixelRatio(1);renderer.outputColorSpace=THREE.SRGBColorSpace;
    renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1;
    renderer.shadowMap.enabled=true;renderer.shadowMap.autoUpdate=false;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    document.body.appendChild(renderer.domElement);
    const scene=new THREE.Scene();scene.background=new THREE.Color('#e8e8e8');
    const environment=createEnvironmentLighting(renderer,scene,{intensity:.6});
    const hemisphere=new THREE.HemisphereLight(0xffffff,0x777777,1);scene.add(hemisphere);
    const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(2,3,4);light.castShadow=true;
    light.shadow.mapSize.set(2048,2048);Object.assign(light.shadow.camera,{left:-4,right:4,top:4,bottom:-4,near:.1,far:30});
    light.shadow.camera.updateProjectionMatrix();scene.add(light);
    const floor=new THREE.Mesh(new THREE.PlaneGeometry(100,100),new THREE.MeshStandardMaterial({color:0xc8c8c8,roughness:1}));
    floor.rotation.x=-Math.PI/2;floor.position.y=-.505;floor.receiveShadow=true;scene.add(floor);
    const camera=new THREE.OrthographicCamera(-1,1,1,-1,.01,100);
    const metrics=createRenderMetrics(renderer,{gpu:true,limit:400});
    const gl=renderer.getContext(),debug=gl.getExtension('WEBGL_debug_renderer_info');
    window.materialTrial={THREE,GLTFLoader,createImportMaterials,renderer,scene,environment,hemisphere,light,floor,camera,metrics,gl};
    return {renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
      threeRevision:THREE.REVISION,userAgent:navigator.userAgent,gpuTimer:metrics.snapshot().gpuTimerSupported,
      size:[800,800],pixelRatio:1};
  },values.url);
  assert.ok(!/swiftshader|software|llvmpipe/i.test(device.renderer));
  const summaries=[];
  for(const profile of ['plush','sofa']){
    const output=join(root,'renders',values.stage,profile);await mkdir(output,{recursive:true});
    let clayHash;
    for(const kind of kinds){
      const key=profile+'_'+kind;
      const result=await page.evaluate(async({key,profile,kind})=>{
        const b=window.materialTrial,{THREE,GLTFLoader,createImportMaterials,renderer,scene,camera,hemisphere,light,metrics,gl}=b;
        const {scene:model}=await new GLTFLoader().loadAsync('/__material_glb__/'+key);
        const group=new THREE.Group();group.add(model);group.updateMatrixWorld(true);
        const box=new THREE.Box3().setFromObject(group),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
        group.scale.setScalar(1/size.y);group.position.copy(center).multiplyScalar(-1/size.y);group.updateMatrixWorld(true);
        const materials=createImportMaterials(THREE,model,{preservePBR:true});
        const originals=new Map(),buffers=new Map(),textures=new Map(),usage={triangles:0,vertices:0,materials:[]};
        model.traverse(mesh=>{
          if(!mesh.isMesh)return;mesh.castShadow=true;originals.set(mesh,mesh.material);
          usage.triangles+=(mesh.geometry.index?.count||mesh.geometry.attributes.position.count)/3;
          usage.vertices+=mesh.geometry.attributes.position.count;
          for(const attr of [...Object.values(mesh.geometry.attributes),mesh.geometry.index].filter(Boolean)){
            const upload=attr.isInterleavedBufferAttribute?attr.data:attr;buffers.set(upload,upload.array.byteLength);
          }
          for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
            usage.materials.push({type:material.type,baseColor:!!material.map,roughness:material.roughness,
              metalness:material.metalness,roughnessMap:!!material.roughnessMap,metalnessMap:!!material.metalnessMap,normalMap:!!material.normalMap});
            for(const value of Object.values(material))if(value?.isTexture&&!textures.has(value.source)){
              const image=value.source.data;let w=image.width,h=image.height,bytes=0;
              do{bytes+=w*h*4;if(!value.generateMipmaps)break;w=Math.floor(w/2);h=Math.floor(h/2);}while(w&&h);
              textures.set(value.source,{width:image.width,height:image.height,estimatedRgba8MipBytes:bytes});
            }
          }
        });
        usage.geometryBufferBytes=[...buffers.values()].reduce((a,b)=>a+b,0);
        usage.textures=[...textures.values()];usage.estimatedTextureBytes=usage.textures.reduce((a,b)=>a+b.estimatedRgba8MipBytes,0);
        const half=new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3()).length()/2*1.12;
        scene.add(group);
        const configure=(direction,zoom=1,target=new THREE.Vector3())=>{
          Object.assign(camera,{left:-half*zoom,right:half*zoom,top:half*zoom,bottom:-half*zoom});camera.updateProjectionMatrix();
          camera.position.fromArray(direction).normalize().multiplyScalar(half*5).add(target);camera.lookAt(target);camera.updateMatrixWorld();
        };
        const resetLights=()=>{hemisphere.intensity=1;light.intensity=2;light.position.set(2,3,4);};
        const captures=[];
        for(const [view,direction]of [['front',[0,.12,1]],['oblique',[1,.65,1]],['side',[1,.12,0]],['back',[0,.12,-1]]]){
          configure(direction);resetLights();renderer.shadowMap.needsUpdate=true;
          for(let i=0;i<3;i++)renderer.render(scene,camera);
          captures.push({name:kind+'-'+view,data:renderer.domElement.toDataURL('image/png')});
        }
        configure([1,.4,1],.5,new THREE.Vector3(profile==='sofa'?.8:0,0,0));
        renderer.render(scene,camera);captures.push({name:kind+'-detail',data:renderer.domElement.toDataURL('image/png')});
        configure(profile==='plush'?[0,.12,1]:[1,.65,1]);
        const clay=new THREE.MeshStandardMaterial({color:0x6b7780,roughness:.75,metalness:0,side:THREE.DoubleSide});
        for(const mesh of originals.keys())mesh.material=clay;
        renderer.render(scene,camera);captures.push({name:kind+'-clay',data:renderer.domElement.toDataURL('image/png')});
        for(const [mesh,material]of originals)mesh.material=material;
        clay.dispose();
        configure([1,.65,1]);const originalEnvironment=scene.environment;scene.environment=null;hemisphere.intensity=.1;
        for(const [name,x]of [['light_left',-3],['light_right',3]]){
          light.position.set(x,2,3);light.intensity=3;renderer.shadowMap.needsUpdate=true;renderer.render(scene,camera);
          captures.push({name:kind+'-'+name,data:renderer.domElement.toDataURL('image/png')});
        }
        scene.environment=originalEnvironment;resetLights();configure([1,.65,1]);renderer.shadowMap.needsUpdate=true;
        for(let i=0;i<12;i++){renderer.render(scene,camera);if(i%4===0)await new Promise(requestAnimationFrame);}
        metrics.reset();
        for(let round=0;round<3;round++)for(let frame=0;frame<24;frame++){
          await new Promise(requestAnimationFrame);metrics.measure('cached-shadow',()=>renderer.render(scene,camera));
        }
        const deadline=performance.now()+10000;
        while(metrics.snapshot().pendingQueries){if(performance.now()>deadline)throw new Error('GPU timer timeout');await new Promise(r=>setTimeout(r,16));}
        const performanceResult=metrics.snapshot();
        if(gl.getError()!==gl.NO_ERROR)throw new Error('WebGL error');
        const snapshot=materials.snapshot();
        scene.remove(group);materials.dispose();
        const disposed=new Set();model.traverse(mesh=>{if(!mesh.isMesh)return;mesh.geometry.dispose();
          for(const m of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
            for(const value of Object.values(m))if(value?.isTexture&&!disposed.has(value)){value.dispose();disposed.add(value);}m.dispose();}});
        renderer.renderLists.dispose();
        return {key,profile,kind,size:size.toArray(),usage,snapshot,performance:performanceResult,captures};
      },{key,profile,kind});
      for(const capture of result.captures){
        const bytes=Buffer.from(capture.data.split(',')[1],'base64');await writeFile(join(output,capture.name+'.png'),bytes);
        if(capture.name.endsWith('-clay')){
          const hash=createHash('sha256').update(bytes).digest('hex');
          if(clayHash)assert.equal(hash,clayHash,'Identical geometry must render identically with the same clay material');
          clayHash=hash;result.claySha256=hash;
        }
      }
      delete result.captures;result.origin=models[key].origin;
      assert.equal(result.snapshot.mode,'pbr');assert.ok(result.usage.materials.every(m=>m.type==='MeshStandardMaterial'));
      assert.equal(result.usage.materials.some(m=>m.normalMap),['procedural_normal','manual_combined'].includes(kind));
      assert.equal(result.usage.materials.some(m=>m.roughnessMap),!['baseline','procedural_normal'].includes(kind));
      const perf=result.performance.summary['cached-shadow'];assert.equal(perf.frames,72);assert.equal(perf.gpuSamples,72);
      assert.deepEqual(errors,[]);
      summaries.push(result);
      await writeFile(join(output,kind+'-report.json'),JSON.stringify(result,null,2));
      console.log(JSON.stringify({key,triangles:result.usage.triangles,gpuMs:perf.gpuMs,textureMiB:result.usage.estimatedTextureBytes/2**20}));
    }
  }
  await writeFile(join(root,'renders',values.stage,'report.json'),JSON.stringify({date:'2026-11-03',device,
    method:'Actual app createImportMaterials(preservePBR=true); same geometry, cameras and lights; PCFSoft2048 cached shadow. 3x24 GPU samples per variant. Microbenchmark, not complete room FPS. Texture payload estimated RGBA8+mips, not process VRAM.',
    models:summaries,errors},null,2));
}finally{await browser.close();}
