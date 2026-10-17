import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mkdir, writeFile } from 'node:fs/promises';
// GLTFExporter uses FileReader for binary buffers; no external assets are loaded.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.(); }); }
  readAsDataURL(blob) { blob.arrayBuffer().then(result => { this.result = `data:${blob.type};base64,${Buffer.from(result).toString('base64')}`; this.onloadend?.(); }); }
};
const material = (color, roughness = 0.8, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
const textile = material('#a7b4a0'), cream = material('#eee8dc'), oak = material('#ae835b'), dark = material('#3c4038'), wall = material('#f2eee5');
function box(group, size, position, mat, radius = 0.035) {
 const mesh = new THREE.Mesh(new RoundedBoxGeometry(...size, 2, Math.min(radius, ...size.map(v => v / 3))), mat);
 mesh.position.set(...position); group.add(mesh); return mesh;
}
function cylinder(group, radius, height, position, mat) {
 const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 32), mat); mesh.position.set(...position); group.add(mesh); return mesh;
}
function sofa() {
 const g = new THREE.Group(); g.name = '自制云杉沙发';
 for (const x of [-0.87, 0.87]) for (const z of [-0.36, 0.36]) box(g,[0.065,0.17,0.065],[x,0.085,z],oak,0.01);
 box(g,[2.12,0.27,0.92],[0,0.305,0],textile,0.1);
 box(g,[2.12,0.58,0.19],[0,0.72,-0.4],textile,0.07);
 for (const x of [-0.48,0.48]) { box(g,[0.92,0.2,0.69],[x,0.515,0.06],cream,0.065); const back=box(g,[0.9,0.43,0.16],[x,0.78,-0.27],textile,0.065); back.rotation.x=-0.1; }
 for (const x of [-0.995,0.995]) box(g,[0.18,0.34,0.87],[x,0.62,0.015],textile,0.06);
 const pillow=box(g,[0.38,0.34,0.13],[-0.67,0.76,-0.1],material('#c2ad87'),0.07); pillow.rotation.z=0.2;
 return g;
}
function table() {
 const g = new THREE.Group(); g.name='自制橡木茶几';
 box(g,[1.22,0.09,0.66],[0,0.43,0],oak,0.08);
 for (const x of [-0.43,0.43]) for(const z of [-0.21,0.21]) box(g,[0.055,0.38,0.055],[x,0.19,z],dark,0.012);
 cylinder(g,0.09,0.13,[0.33,0.54,0],material('#e6ddca'));
 box(g,[0.28,0.022,0.2],[-0.15,0.488,0.02],material('#737f70'),0.005);
 return g;
}
function chair() {
 const g = new THREE.Group(); g.name='自制阅读椅';
 for(const x of [-0.24,0.24]) for(const z of [-0.23,0.23]) box(g,[0.055,0.4,0.055],[x,0.2,z],oak,0.01);
 box(g,[0.61,0.14,0.62],[0,0.46,0],cream,0.065);
 box(g,[0.58,0.51,0.12],[0,0.76,-0.26],cream,0.06);
 for(const x of [-0.3,0.3]) box(g,[0.055,0.1,0.54],[x,0.64,0],oak,0.025);
 return g;
}
function room() {
 const g=new THREE.Group(); g.name='自制栖间房间';
 box(g,[6.12,0.16,5.12],[0,-0.08,0],material('#d3b99a'),0.02);
 for(let i=0;i<30;i++) box(g,[0.196,0.009,4.99],[-2.9+i*0.2,0.005,0],material(i%3===0?'#d0b28d':i%3===1?'#d7bc9a':'#dbc4a5'),0.001);
 box(g,[6.1,3,0.12],[0,1.5,-2.55],wall,0.01);
 box(g,[0.12,3,5.1],[-3.05,1.5,0],wall,0.01);
 box(g,[5.99,0.12,0.05],[0,0.07,-2.48],cream,0.005);
 box(g,[0.05,0.12,4.98],[-2.98,0.07,0],cream,0.005);
 box(g,[2.7,0.008,2.2],[0,0.014,0.3],material('#e7dfce'),0.002);
 // A luminous window and framed print create a calm, readable room.
 box(g,[1.6,1.38,0.035],[-1.65,1.72,-2.47],material('#a29a87'),0.008);
 const glass=material('#d9e6df',0.2); glass.emissive.set('#d9e6df'); glass.emissiveIntensity=0.45;
 box(g,[1.48,1.26,0.04],[-1.65,1.72,-2.44],glass,0.005);
 box(g,[0.035,1.26,0.045],[-1.65,1.72,-2.41],cream,0.003);
 box(g,[0.83,1.05,0.05],[1.75,1.85,-2.45],oak,0.01);
 box(g,[0.74,0.96,0.04],[1.75,1.85,-2.41],cream,0.008);
 const art=box(g,[0.43,0.56,0.015],[1.7,1.85,-2.38],material('#859080'),0.005); art.rotation.z=-0.12;
 cylinder(g,0.18,0.38,[2.3,0.19,-1.9],material('#c8b7a2'));
 cylinder(g,0.035,1.0,[2.3,0.8,-1.9],oak);
 for(let i=0;i<10;i++) { const leaf=new THREE.Mesh(new THREE.SphereGeometry(0.15,12,8),textile); leaf.scale.set(0.65,1.8,0.65); leaf.position.set(2.3+Math.sin(i*2.4)*0.2,1.05+(i%3)*0.18,-1.9+Math.cos(i*2.4)*0.2); leaf.rotation.z=Math.sin(i)*0.6; g.add(leaf); }
 cylinder(g,0.16,0.035,[-2.35,0.03,-1.7],dark); cylinder(g,0.018,1.7,[-2.35,0.88,-1.7],dark);
 const shade=new THREE.Mesh(new THREE.ConeGeometry(0.24,0.35,32,1,true),material('#e7dcc4')); shade.position.set(-2.35,1.73,-1.7); g.add(shade);
 return g;
}
for(const [path,object] of [['room/room.glb',room()],['furniture/sofa.glb',sofa()],['furniture/table.glb',table()],['furniture/chair.glb',chair()]]) {
 const data=await new GLTFExporter().parseAsync(object,{binary:true});
 await mkdir(`public/models/${path.split('/')[0]}`,{recursive:true}); await writeFile(`public/models/${path}`,Buffer.from(data));
 console.log(path,data.byteLength);
}
