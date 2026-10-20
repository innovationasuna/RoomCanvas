import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const manifest=JSON.parse(await readFile('public/vision/manifest.json','utf8'));
const pkg=JSON.parse(await readFile('package.json','utf8'));
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
const sources=await readFile('docs/sources.md','utf8');
const licenses={'@mediapipe/tasks-vision':'Apache-2.0','typescript':'Apache-2.0','vite':'MIT','vitest':'MIT','@types/node':'MIT','fflate':'MIT','google-auth-library':'Apache-2.0'};
for(const [name,version] of Object.entries({...pkg.dependencies,...pkg.devDependencies})) {
 const installed=JSON.parse(await readFile(`node_modules/${name}/package.json`,'utf8'));
 if(installed.version!==version||lock.packages[`node_modules/${name}`]?.version!==version)throw new Error(`依赖版本未固定 ${name}`);
 if(installed.license!==licenses[name]||!sources.includes(version))throw new Error(`许可/版本清单不匹配 ${name}`);
}
for(const doc of ['plan','architecture','gestures','sources','acceptance'])await readFile(`docs/${doc}.md`,'utf8');
for(const dependency of manifest.siteDependencies || []) {
 const resolved=lock.packages[`node_modules/${dependency.name}`];
 if(!resolved || resolved.version!==dependency.version || resolved.integrity!==dependency.integrity || resolved.resolved!==dependency.source)throw new Error(`网站依赖来源或校验值不匹配 ${dependency.name}`);
}
for(const r of manifest.resources) { const b=await readFile(r.path); if(createHash('sha256').update(b).digest('hex')!==r.sha256) throw new Error(`校验失败 ${r.path}`); }
const outputs=await readdir('outputs').catch(error=>{if(error.code==='ENOENT')return [];throw error;}); if(outputs.length) console.log('outputs 包含用户输出',outputs.length);
console.log('识别模型、WASM、网站资源、依赖版本与许可清单校验通过');
