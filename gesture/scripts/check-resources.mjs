import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const manifest=JSON.parse(await readFile('public/vision/manifest.json','utf8'));
const pkg=JSON.parse(await readFile('package.json','utf8'));
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
const sources=await readFile('docs/sources.md','utf8');
const licenses={'three':'MIT','@mediapipe/tasks-vision':'Apache-2.0','typescript':'Apache-2.0','vite':'MIT','vitest':'MIT','@types/three':'MIT','@types/node':'MIT'};
for(const [name,version] of Object.entries({...pkg.dependencies,...pkg.devDependencies})) {
 const installed=JSON.parse(await readFile(`node_modules/${name}/package.json`,'utf8'));
 if(installed.version!==version||lock.packages[`node_modules/${name}`]?.version!==version)throw new Error(`依赖版本未固定 ${name}`);
 if(installed.license!==licenses[name]||!sources.includes(version))throw new Error(`许可/版本清单不匹配 ${name}`);
}
for(const doc of ['architecture','gestures','sources','roomcanvas-integration','remote-backend'])await readFile(`docs/${doc}.md`,'utf8');
for(const r of manifest.resources) { const b=await readFile(r.path); if(createHash('sha256').update(b).digest('hex')!==r.sha256) throw new Error(`校验失败 ${r.path}`); }
if(manifest.backend) {
 const backendLock=await readFile(manifest.backend.lockfile,'utf8');
 if(createHash('sha256').update(backendLock).digest('hex')!==manifest.backend.lockSha256)throw new Error('后端依赖锁文件校验失败');
 for(const dependency of manifest.backend.dependencies) {
  if(!backendLock.toLowerCase().includes(`${dependency.name}==${dependency.version}`.toLowerCase())||!sources.includes(dependency.version)||!dependency.sha256.length)throw new Error(`后端依赖来源缺失 ${dependency.name}`);
  for(const hash of dependency.sha256)if(!backendLock.includes(`--hash=sha256:${hash}`))throw new Error(`后端依赖校验值缺失 ${dependency.name}`);
 }
}
for(const name of ['room/room.glb','furniture/sofa.glb','furniture/table.glb','furniture/chair.glb']) { const b=await readFile('public/models/'+name); if(b.toString('ascii',0,4)!=='glTF' || b.readUInt32LE(8)!==b.length) throw new Error(`GLB 无效 ${name}`); }
const outputs=await readdir('outputs').catch(error=>{if(error.code==='ENOENT')return [];throw error;}); if(outputs.length) console.log('outputs 包含用户输出',outputs.length);
console.log('模型、WASM、GLB、依赖版本与许可清单校验通过');
