const assets = './assets/';
const scenes = {
  overview: {image:'office.jpg', mode:'空间总览', title:'你的房间，成为画布。', description:'独立的家具，真实的尺度。每一次改变，都从这里开始。', alt:'按真实尺寸重建的办公室三维模型'},
  placement: {image:'office-placement.jpg', mode:'家具布置', title:'先预览，再确认。', description:'移动、旋转、升降，检查碰撞与支撑之后，确认这一次改变。', alt:'选中办公椅后显示位置参数与连续拖动工具'},
  night: {image:'office-night.jpg', mode:'夜间光照', title:'灯亮起来，感觉就不同。', description:'同一个办公室样例，在夜间光照与中央顶灯下的效果。', alt:'办公室夜间光照截图'},
  objects: {image:'add-object.jpg', mode:'照片重建', title:'让新的物品，也有位置。', description:'从照片到三维模型，用实测边长把它带回真实尺度。', alt:'添加物品对话框中的上传照片步骤'},
  preview: {image:'office-preview.jpg', mode:'空间体验', title:'打开窗，再走近一点。', description:'查看支持开合的门窗和家具，探索房间里的活动空间。', alt:'办公室体验模式和走进房间入口'}
};
const image = document.querySelector('#stage-image');
let activeScene='overview', sceneRequest=0;
async function setScene(name) {
  if(!scenes[name] || activeScene===name) return;
  activeScene=name;
  const scene=scenes[name], request=++sceneRequest;
  const preload=new Image();preload.src=assets+scene.image;
  try {await preload.decode();} catch {return;}
  if(request!==sceneRequest) return;
  image.src=preload.src;image.alt=scene.alt;
  if(!matchMedia('(prefers-reduced-motion: reduce)').matches) image.animate([{opacity:.35},{opacity:1}],{duration:450,easing:'ease-out'});
  document.querySelector('#stage-mode').textContent=scene.mode;
  document.querySelector('#stage-title').textContent=scene.title;
  document.querySelector('#stage-description').textContent=scene.description;
  document.querySelectorAll('[data-view]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.view===name)));
}
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>setScene(button.dataset.view)));
document.querySelectorAll('[data-light]').forEach(button=>button.addEventListener('click',()=>{
  const name=button.dataset.light;
  document.querySelectorAll('[data-light]').forEach(other=>other.setAttribute('aria-pressed',String(other===button)));
  const proof=document.querySelector('#light-proof');proof.src=assets+(name==='overview'?'office-preview.jpg':'office-night.jpg');
  proof.alt=name==='overview'?'办公室日间光照效果':'办公室夜间光照效果';
  setScene(name);
}));
const desktop=matchMedia('(min-width:701px)');
const observer=new IntersectionObserver(entries=>{
  if(!desktop.matches) return;
  const visible=entries.filter(entry=>entry.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio);
  if(visible.length)setScene(visible[0].target.dataset.scene);
},{rootMargin:'-15% 0px -45% 0px',threshold:[0,.1,.3]});
document.querySelectorAll('[data-scene]').forEach(section=>observer.observe(section));
if(!matchMedia('(prefers-reduced-motion: reduce)').matches){
  const reveal=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('reveal-in');reveal.unobserve(entry.target);}}),{threshold:.08});
  document.querySelectorAll('.story-section:not(.hero) h2,.story-section:not(.hero)>p,.inline-proof,.section-heading,.workflow-path article,.doc-list>a,.closing h2').forEach(el=>reveal.observe(el));
}
const menu=document.querySelector('.menu-toggle'),nav=document.querySelector('#navigation');
function closeMenu(){nav.classList.remove('open');menu.setAttribute('aria-expanded','false');menu.setAttribute('aria-label','展开导航');}
menu.addEventListener('click',()=>{const open=nav.classList.toggle('open');menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?'收起导航':'展开导航');});
nav.addEventListener('click',event=>{if(event.target.closest('a'))closeMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&nav.classList.contains('open')){closeMenu();menu.focus();}});
document.addEventListener('click',event=>{if(!event.target.closest('.header'))closeMenu();});
document.querySelector('#copy-command').addEventListener('click',async()=>{
  const command=document.querySelector('#setup-command').textContent,status=document.querySelector('#copy-status');
  try{await navigator.clipboard.writeText(command);status.textContent='启动命令已复制。';}
  catch{const range=document.createRange();range.selectNodeContents(document.querySelector('#setup-command'));const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);status.textContent='已选中命令，请按 ⌘C 或 Ctrl+C 复制。';}
});
