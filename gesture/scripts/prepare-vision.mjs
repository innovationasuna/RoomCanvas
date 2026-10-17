import { copyFile, mkdir, readdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const modelUrl='https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
await mkdir('public/vision/wasm',{recursive:true});
const resources=[];
for(const name of await readdir('node_modules/@mediapipe/tasks-vision/wasm')) {
 if(!/\.(wasm|js)$/.test(name)) continue;
 const path=`public/vision/wasm/${name}`; await copyFile(`node_modules/@mediapipe/tasks-vision/wasm/${name}`,path);
 resources.push({path,source:'@mediapipe/tasks-vision@1.1.0/wasm/'+name});
}
const response=await fetch(modelUrl); if(!response.ok) throw new Error(`模型下载失败 ${response.status}`);
const path='public/vision/hand_landmarker.task'; await writeFile(path,Buffer.from(await response.arrayBuffer())); resources.push({path,source:modelUrl});
for(const item of resources) { const bytes=await readFile(item.path); item.bytes=bytes.length; item.sha256=createHash('sha256').update(bytes).digest('hex'); }
await writeFile('public/vision/manifest.json',JSON.stringify({package:'@mediapipe/tasks-vision',version:'1.1.0',modelVersion:'float16/1',resources},null,2)+'\n');
console.log('本地识别资源已准备',resources.length);
