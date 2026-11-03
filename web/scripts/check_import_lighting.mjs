// Replays the real import/placement UI with a synthetic unlit vertex-colour GLB.
import {parseArgs} from 'node:util';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {BoxGeometry} from '../vendor/build/three.module.js';

const {values}=parseArgs({options:{url:{type:'string',default:'http://127.0.0.1:7880/web/'},output:{type:'string'},playwright:{type:'string'},browser:{type:'string'}}});
if(!values.output)throw new Error('请指定仓库外的 --output 结果目录');
const output=resolve(values.output),repo=fileURLToPath(new URL('../../',import.meta.url));
if(output===repo||output.startsWith(repo+'/'))throw new Error('不要把私人房间截图写入仓库');
const {chromium}=createRequire(import.meta.url)(values.playwright?resolve(values.playwright):'playwright');
await mkdir(output,{recursive:true});
const geometry=new BoxGeometry(.4,.4,.4).toNonIndexed();geometry.translate(0,.2,0);
const positions=new Float32Array(geometry.attributes.position.array),colors=new Float32Array(positions.length).fill(.42);
const binary=Buffer.concat([Buffer.from(positions.buffer),Buffer.from(colors.buffer)]);
const gltf={asset:{version:'2.0'},extensionsUsed:['KHR_materials_unlit'],scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0,name:'LightingProbe'}],
  meshes:[{primitives:[{attributes:{POSITION:0,COLOR_0:1},material:0}]}],materials:[{extensions:{KHR_materials_unlit:{}},pbrMetallicRoughness:{baseColorFactor:[1,1,1,1]}}],
  buffers:[{byteLength:binary.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.byteLength},{buffer:0,byteOffset:positions.byteLength,byteLength:colors.byteLength}],
  accessors:[{bufferView:0,componentType:5126,count:positions.length/3,type:'VEC3',min:[-.2,0,-.2],max:[.2,.4,.2]},{bufferView:1,componentType:5126,count:colors.length/3,type:'VEC3'}]};
let json=Buffer.from(JSON.stringify(gltf));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
const header=Buffer.alloc(20),chunk=Buffer.alloc(8);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+binary.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);chunk.writeUInt32LE(binary.length);chunk.writeUInt32LE(0x004e4942,4);
const glb=Buffer.concat([header,json,chunk,binary]);
const browser=await chromium.launch({headless:true,...(values.browser?{executablePath:values.browser}:{})});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1}),errors=[];
  await page.addInitScript(()=>localStorage.setItem('roomcanvas:tools','full'));
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.route('**/viewforge/assets/catalog',r=>r.fulfill({json:{runs:[]}}));
  await page.route('**/viewforge/assets/lighting-probe/*.glb',r=>r.fulfill({body:glb,contentType:'model/gltf-binary'}));
  await page.goto(new URL('editor/?room=office&lightingLab=1',values.url).href,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.roomEditor?.snapshot().lighting.state==='settled',null,{timeout:120000});
  assert.equal(await page.locator('#import-lighting').isChecked(),true,'导入物品应默认开启受光');
  await page.evaluate(()=>roomLightingLab.importObject('lighting-probe',{bounds:{min:[-.2,0,-.2],max:[.2,.4,.2]},transform:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],lengths:{X:.4,Y:.4,Z:.4}},1));
  await page.waitForFunction(()=>roomEditor.snapshot().pending?.valid,null,{timeout:30000});
  const pendingId=await page.evaluate(()=>roomEditor.snapshot().pending.id);
  await page.locator('#light-menu').evaluate(e=>{e.open=true;});await page.locator('#import-lighting').click();
  assert.equal(await page.locator('#import-lighting').isChecked(),true,'摆放中切换应保留默认受光模式');
  assert.equal(await page.evaluate(()=>roomEditor.snapshot().pending.id),pendingId,'切换不能丢弃摆放草稿');
  await page.locator('#light-menu').evaluate(e=>{e.open=false;});
  await page.click('#confirm-placement');await page.waitForFunction(()=>roomEditor.snapshot().pending===null,null,{timeout:30000});
  const id=await page.evaluate(()=>roomLightingLab.materials().imported[0].id);
  await page.evaluate(id=>roomLightingLab.focusObject(id),id);await page.waitForTimeout(500);
  const report={version:1,fixture:'unlit vertex colours, missing source normals',results:[],errors};
  for(const mode of ['original','pbr','original']){
    await page.locator('#light-menu').evaluate(e=>{e.open=true;});await page.locator('#import-lighting').setChecked(mode==='pbr');await page.locator('#light-menu').evaluate(e=>{e.open=false;});await page.waitForTimeout(500);
    const sample=await page.evaluate(id=>roomLightingLab.lightResponseProbe(id),id);
    const averages=await page.evaluate(async sample=>{
      const mean=async url=>{const img=await createImageBitmap(await(await fetch(url)).blob()),canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;const ctx=canvas.getContext('2d');ctx.drawImage(img,sample.center[0]-8,sample.center[1]-8,16,16,0,0,16,16);const pixels=ctx.getImageData(0,0,16,16).data;let sum=0;for(let i=0;i<pixels.length;i+=4)sum+=pixels[i]+pixels[i+1]+pixels[i+2];img.close();return sum/(16*16*3);};
      return{lit:await mean(sample.lit),dark:await mean(sample.dark)};
    },sample);
    const result={mode,...averages,material:await page.evaluate(()=>roomLightingLab.materials().imported[0])};
    assert.equal(result.material.mode,mode);assert.equal(result.material.normalsAdded,1);
    if(mode==='original')assert.ok(Math.abs(result.lit-result.dark)<.1,'原显示随光变化');
    else assert.ok(result.lit-result.dark>20,'PBR 未实际响应光照');
    report.results.push(result);
    for(const key of ['lit','dark'])await writeFile(join(output,`${mode}-${key}.png`),Buffer.from(sample[key].split(',')[1],'base64'));
  }
  assert.deepEqual(errors,[]);await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
  console.log('通过：真实导入与放置、PBR 受光、缺失法线补算、原显示回退；结果 '+output);
}finally{await browser.close();}
