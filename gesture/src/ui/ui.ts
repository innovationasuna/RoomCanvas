import type { Action, GestureFrame, HandSignal, ObjectInfo, TrackingFrame } from '../shared/types';
import { CONFIG } from '../shared/config';
import { CATALOG } from '../scene/furniture/catalog';
import type { Controller } from '../controls/controller';
import type { Scene } from '../scene/core/scene';

export const MODE_LABELS = { move: '移动', rotate: '旋转', height: '高度', observe: '观察', scale: '缩放' };
const icon = (name: string) => {
  const paths: Record<string,string> = {
    move:'M12 3v18M3 12h18M8 7l4-4 4 4M8 17l4 4 4-4M7 8l-4 4 4 4M17 8l4 4-4 4',
    rotate:'M20 7v5h-5M20 12a8 8 0 1 0-2 5',
    height:'M12 3v18M7 8l5-5 5 5M7 16l5 5 5-5',
    observe:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    scale:'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6',
    camera:'M3 7h4l2-3h6l2 3h4v13H3zM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    sofa:'M5 13V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v5M3 12h4v6H3zM17 12h4v6h-4zM7 15h10M5 18v2M19 18v2',
    chair:'M7 12V4h10v8M5 12h14v4H5zM7 16v5M17 16v5',
    table:'M3 8h18v4H3zM6 12v9M18 12v9',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]??paths.move}"/></svg>`;
};

export class UI {
  readonly canvas: HTMLCanvasElement;
  readonly video: HTMLVideoElement;
  readonly skeleton: HTMLCanvasElement;
  menuOpen = false;
  confirming = false;
  onAction?: (action: Action) => void;
  onCamera?: () => void;
  onStop?: () => void;
  onDevice?: () => void;
  onTrackingMode?: () => void;
  onMenu?: () => void;
  onSelect?: (id:string) => void;
  private hovered?: HTMLButtonElement;
  constructor(readonly host: HTMLElement) {
    host.innerHTML = `
      <header class="topbar"><a class="brand" href="#" aria-label="栖间首页"><span class="brand-mark">栖</span><span>栖间<span class="brand-sub">SPATIAL LAB</span></span></a>
        <div class="top-note"><span class="live-dot"></span>本地手势空间实验室 <span class="version">V 0.1</span></div>
        <button class="quiet-button" id="help-toggle">操作指南 <span>↗</span></button></header>
      <main class="workspace">
        <aside class="sidebar"><div class="eyebrow">A ROOM, YOUR WAY</div><h1>用双手，<br>布置你的空间<span class="title-dot">。</span></h1><p class="intro">从一把椅子的位置开始。指向、捏合、移动，让空间随你的想法改变。</p>
          <div class="scene-tabs" role="group" aria-label="场景"><button data-action="furniture" class="active">室内布置</button><button data-action="xyz">三维定位</button></div>
          <section id="furniture-panel"><div class="section-heading"><h2>空间里的物件</h2><span>03 ITEMS</span></div>
            <div class="catalog">${CATALOG.map(c=>`<button class="catalog-item" data-item="${c.id}"><span class="item-icon" style="--item-color:${c.color}">${icon(c.id==='sofa'?'sofa':c.id==='table'?'table':'chair')}</span><span><small>${c.category}</small><strong>${c.label}</strong></span><span class="item-arrow">↗</span></button>`).join('')}</div>
          </section>
          <section id="xyz-panel" hidden><div class="section-heading"><h2>三维目标定位</h2><span>20 TARGETS</span></div><p class="task-copy">捏合控制光标。手靠近摄像头，光标靠近你；后退则进入空间深处。</p><div class="task-score"><b id="target-count">01</b><span>/ 20 个目标</span></div><div class="progress-track"><i id="target-progress"></i></div><div class="task-result" id="target-result">到达目标中心 10 厘米范围，并保持 1 秒。</div></section>
          <section class="inspector"><div class="section-heading"><h2 id="object-label">尚未选择物件</h2><span>TRANSFORM</span></div><div class="coordinate-grid"><div><small>X · 水平</small><b id="coord-x">—</b></div><div><small>Y · 高度</small><b id="coord-y">—</b></div><div><small>Z · 纵深</small><b id="coord-z">—</b></div></div><div class="object-extra"><span id="angle">朝向 —</span><span id="size">尺寸保持真实比例</span></div></section>
          <div class="sidebar-bottom"><span class="privacy-dot"></span><span id="privacy-note">画面仅在本机处理<br><small>默认不录制，不上传</small></span></div>
        </aside>
        <div class="stage-column">
          <div class="stage-toolbar" role="group" aria-label="操作模式">${Object.entries(MODE_LABELS).map(([id,label])=>`<button data-action="${id}" aria-label="${label}" title="${label}" class="${id==='move'?'active':''}">${icon(id)}<span>${label}</span></button>`).join('')}<span class="toolbar-separator"></span><button id="menu-button" title="打开手势菜单" aria-label="打开手势菜单"><span class="menu-glyph">⌘</span><span>菜单</span></button></div>
        <section class="stage" aria-label="三维交互场景"><canvas id="scene-canvas" aria-label="室内家具三维场景"></canvas>
          <div class="stage-heading"><div><span class="eyebrow">SPACE / 01</span><h2 id="scene-title">午后 · 起居室</h2><p id="scene-subtitle">6 × 5 m / 自制家具资产</p></div><span class="room-badge">LOCAL STUDIO</span></div>
          <div id="loading" class="loading-panel"><span class="spinner"></span>正在准备你的空间…</div>
          <div class="scene-status"><span class="status-dot"></span><span id="status-text">正在加载本地场景</span></div>
          <svg class="gesture-overlay" id="gesture-overlay" hidden aria-hidden="true">
            <g data-hand="operator" style="display:none"><line class="finger-link"/><circle class="finger-tip" data-tip="thumb" r="7"/><circle class="finger-tip" data-tip="index" r="7"/></g>
            <g data-hand="helper" style="display:none"><line class="finger-link"/><circle class="finger-tip" data-tip="thumb" r="7"/><circle class="finger-tip" data-tip="index" r="7"/></g>
          </svg>
          <div class="gesture-cursor" id="gesture-cursor" hidden><span></span></div>
          <div class="gesture-cursor helper-cursor" id="left-gesture-cursor" hidden><span></span></div>
          <div class="gesture-menu" id="gesture-menu" hidden role="dialog" aria-label="手势操作菜单"><div class="menu-header"><div><span class="eyebrow">GESTURE MENU</span><h3 id="menu-title">下一步，想做什么？</h3></div><button data-action="close" aria-label="关闭菜单">×</button></div><p>右手指向选项，捏合确认；左手握拳关闭菜单</p><div id="menu-items" class="menu-items"></div><div class="menu-foot">确认后先松开捏合，再开始操作</div></div>
          <div class="depth-indicator" id="depth-indicator" hidden><span>深处</span><div><i id="depth-marker"></i></div><span>靠近</span></div>
          <div class="stage-footer"><span id="input-state">鼠标模式 · 拖动操作 / 滚轮调节</span><span class="performance"><b id="fps">—</b> FPS <span>/</span> <b id="inference">—</b> Hz</span></div>
        </section>
        </div>
        <aside class="right-panel"><div class="section-heading"><h2>手部追踪</h2><span id="camera-state">未开启</span></div><div class="camera-preview"><video id="camera-video" muted playsinline></video><canvas id="skeleton" width="320" height="240"></canvas><div id="camera-placeholder">${icon('camera')}<span>给双手一个入口</span><small>开启后可用手势操作空间</small></div><span class="preview-badge">ON DEVICE</span></div>
          <label class="device-label" for="tracking-mode">计算位置</label><select id="tracking-mode"><option value="local">本机浏览器</option><option value="remote">Mac mini 后端</option></select><p id="tracking-note" class="task-copy">画面仅在本机处理。</p><p id="tracking-timing" class="task-copy" aria-live="polite">尚未开始识别</p><label class="device-label" for="camera-device">摄像头</label><select id="camera-device"><option value="">系统默认设备</option></select><button id="camera-start" class="primary-button">开启摄像头 <span>→</span></button><button id="camera-stop" class="quiet-button stop-button" hidden>停止追踪</button>
          <div class="tracking-readout"><span id="hand-status">等待开启</span><span id="hand-role">右手：物体 · 天蓝 / 左手：视角 · 浅绿</span></div><div id="camera-error" class="error-message" hidden role="alert"></div>
          <div class="guide-card"><div class="eyebrow">HOW TO PLAY</div><h3>三个动作，就够了</h3><div><b>01</b><p><strong>指向</strong><span>移动右手，家具会高亮</span></p></div><div><b>02</b><p><strong>捏合</strong><span>右手操作物体，左手环绕视角</span></p></div><div><b>03</b><p><strong>张掌</strong><span>左手张掌稍停，打开模式菜单</span></p></div></div>
          <div class="mode-note"><span>当前模式</span><strong id="mode-label">移动</strong><p id="mode-tip">保持捏合，沿地板移动；松开放置。</p></div>
          <div class="small-actions"><button data-action="undo">↶ 撤销 <span id="undo-count">0</span></button><button data-action="reset">复位</button></div>
        </aside>
      </main><div class="help-dialog" id="help-dialog" hidden role="dialog" aria-label="操作指南"><button id="help-close" aria-label="关闭指南">×</button><span class="eyebrow">GETTING STARTED</span><h2>让动作有明确的开始和结束。</h2><p>先用鼠标熟悉场景，再开启摄像头。右手捏合操作；左手张掌保持约 0.6 秒打开菜单。选中菜单项后，先松手再抓取。</p><p>右手按当前模式操作。左手在任意模式捏合拖动可环绕视角，松开固定；左右控制先开始者优先，不能同时拖动物体和视角。观察模式双手捏合可缩放视角；XYZ 缩放模式双手可缩放光标。</p><p>三维定位用掌部投影大小估计相对深度。转掌会影响估计：提示出现时请把掌面朝向摄像头。跟踪丢失会冻结位置，恢复后松手重新抓取。</p><p>鼠标：左键拖动；菜单选择模式；滚轮调整观察距离，XYZ 移动模式下调整深度。</p><small>本机性能和真人定位准确率仍需实测，不代表已通过验收。</small></div>`;
    this.canvas=this.get('scene-canvas');this.video=this.get('camera-video');this.skeleton=this.get('skeleton');
    host.addEventListener('click',event=>{
      const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button');if(!button)return;
      if(button.dataset.action)this.onAction?.(button.dataset.action as Action);
      if(button.dataset.item)this.onSelect?.(button.dataset.item);
    });
    this.get<HTMLButtonElement>('camera-start').onclick=()=>this.onCamera?.();
    this.get<HTMLButtonElement>('camera-stop').onclick=()=>this.onStop?.();
    this.get<HTMLSelectElement>('camera-device').onchange=()=>this.onDevice?.();
    this.get<HTMLSelectElement>('tracking-mode').onchange=()=>{this.onTrackingMode?.();this.trackingMode(this.remote);};
    this.get<HTMLButtonElement>('menu-button').onclick=()=>this.onMenu?.();
    this.get<HTMLButtonElement>('help-toggle').onclick=()=>{this.get('help-dialog').hidden=false;};
    this.get<HTMLButtonElement>('help-close').onclick=()=>{this.get('help-dialog').hidden=true;};
  }
  get<T extends HTMLElement=HTMLElement>(id:string){return this.host.querySelector<T>('#'+id)!;}
  text(id:string,text:string){this.get(id).textContent=text;}
  ready(){this.get('loading').hidden=true;}
  error(message:string){this.get('camera-error').hidden=!message;this.text('camera-error',message);}
  cameraState(state:'off'|'loading'|'on') {
    this.text('camera-state',state==='on'?'运行中':state==='loading'?'准备中':'未开启');
    const start=this.get<HTMLButtonElement>('camera-start');start.hidden=state==='on';start.disabled=state==='loading';
    start.textContent=state==='loading'?'正在准备追踪…':this.remote?'开启摄像头并发送画面 →':'开启摄像头 →';
    this.get('camera-stop').hidden=state==='off';this.get('camera-placeholder').hidden=state==='on';
    this.text('input-state',state==='on'?'手势模式 · 左手张掌打开菜单':'鼠标模式 · 拖动操作 / 滚轮调节');
    if(state==='off'){this.text('hand-status','等待开启');this.get('gesture-cursor').hidden=true;this.get('left-gesture-cursor').hidden=true;this.get('gesture-overlay').setAttribute('hidden','');this.skeleton.getContext('2d')!.clearRect(0,0,320,240);}
  }
  async devices(devices:MediaDeviceInfo[]) {
    const select=this.get<HTMLSelectElement>('camera-device'),old=select.value;
    select.replaceChildren(new Option('系统默认设备',''),...devices.map((d,i)=>new Option(d.label||`摄像头 ${i+1}`,d.deviceId)));
    if(devices.some(d=>d.deviceId===old))select.value=old;
  }
  get remote(){return this.get<HTMLSelectElement>('tracking-mode').value==='remote';}
  trackingMode(remote:boolean){
    this.get<HTMLSelectElement>('tracking-mode').value=remote?'remote':'local';
    this.text('tracking-note',remote?'开启后，将摄像头画面发送到提供本网页的 Mac mini 识别；不录制、不保存。':'画面仅在本机处理，不上传。');
    this.text('privacy-note',remote?'画面发送到 Mac mini 计算，不录制、不保存':'画面仅在本机处理，默认不录制、不上传');
    this.host.querySelector('.preview-badge')!.textContent=remote?'MAC MINI':'ON DEVICE';
    this.text('tracking-timing','尚未开始识别');
    this.get<HTMLButtonElement>('camera-start').textContent=remote?'开启摄像头并发送画面 →':'开启摄像头 →';
  }
  get device(){return this.get<HTMLSelectElement>('camera-device').value;}
  openMenu(controller:Controller,confirm=false){
    this.menuOpen=true;this.confirming=confirm;this.get('gesture-menu').hidden=false;
    this.text('menu-title',confirm?'恢复初始布局？':'下一步，想做什么？');
    const actions:[Action,string][] = confirm ? [['confirm-reset','确认复位'],['cancel-reset','保留当前布局']] : [
      ['move','移动家具 / 光标'],['rotate','旋转物体'],['height','调整高度'],['observe','环绕观察'],
      ...(controller.scene.active==='xyz'?[['scale','双手缩放'] as [Action,string]]:[]),
      ['undo','撤销上一步'],[controller.paused?'resume':'pause',controller.paused?'恢复控制':'暂停控制'],
      [controller.scene.active==='xyz'?'furniture':'xyz',controller.scene.active==='xyz'?'返回室内布置':'进入 XYZ 验证'],
      ['reset','复位场景'],['close','关闭菜单'],
    ];
    this.get('menu-items').innerHTML=actions.map(([action,label])=>`<button data-action="${action}">${label}<span>↗</span></button>`).join('');
  }
  closeMenu(){this.menuOpen=false;this.confirming=false;this.get('gesture-menu').hidden=true;this.hovered?.classList.remove('hovered');this.hovered=undefined;}
  pointer(frame:GestureFrame){
    this.fingertips(frame);
    const left=this.get('left-gesture-cursor'),helper=frame.helper;left.hidden=!this.showFingerGuide(helper);
    if(helper){left.style.left=`${helper.pointer.x*100}%`;left.style.top=`${helper.pointer.y*100}%`;left.classList.toggle('pinching',helper.pinching);}
    const cursor=this.get('gesture-cursor');const hand=frame.operator;cursor.hidden=!this.showFingerGuide(hand);if(!hand){this.hovered?.classList.remove('hovered');this.hovered=undefined;return;}
    const r=this.canvas.getBoundingClientRect();const x=r.left+hand.pointer.x*r.width,y=r.top+hand.pointer.y*r.height;
    cursor.style.left=`${hand.pointer.x*100}%`;cursor.style.top=`${hand.pointer.y*100}%`;cursor.classList.toggle('pinching',hand.pinching);
    this.hovered?.classList.remove('hovered');
    this.hovered=this.menuOpen ? document.elementFromPoint(x,y)?.closest<HTMLButtonElement>('#gesture-menu button')??undefined:undefined;
    this.hovered?.classList.add('hovered');
    if(this.hovered && hand.started)this.onAction?.(this.hovered.dataset.action as Action);
  }
  private showFingerGuide(hand?:HandSignal){
    return !!hand?.fingertips && hand.pinchRatio !== undefined && Number.isFinite(hand.pinchRatio) && hand.pinchRatio < CONFIG.fingerGuideMaxRatio;
  }
  private fingertips(frame:GestureFrame){
    const overlay=this.get('gesture-overlay');let visible=false;
    for(const role of ['operator','helper']as const){
      const group=overlay.querySelector<SVGGElement>(`[data-hand="${role}"]`)!,hand=frame[role];
      const show=this.showFingerGuide(hand);group.style.display=show?'':'none';if(!show||!hand?.fingertips)continue;visible=true;
      const {thumb,index}=hand.fingertips,percent=(value:number)=>`${value*100}%`,line=group.querySelector('line')!;
      line.setAttribute('x1',percent(thumb.x));line.setAttribute('y1',percent(thumb.y));line.setAttribute('x2',percent(index.x));line.setAttribute('y2',percent(index.y));
      for(const [name,point]of Object.entries(hand.fingertips)){const circle=group.querySelector(`[data-tip="${name}"]`)!;circle.setAttribute('cx',percent(point.x));circle.setAttribute('cy',percent(point.y));}
    }
    overlay.toggleAttribute('hidden',!visible);
  }
  tracking(frame:TrackingFrame,gesture:GestureFrame){
    this.text('tracking-timing',`推理 ${frame.inferenceMs.toFixed(0)} ms${frame.roundTripMs===undefined?'':` · 往返 ${frame.roundTripMs.toFixed(0)} ms`}`);
    this.text('hand-status',gesture.ambiguous?'手部身份不明确':gesture.operator?.pinching?'右手捏合中':gesture.helper?.pinching?'左手捏合中':gesture.operator?'右手已识别':gesture.helper?'左手已识别':'未识别到手部');
    const ctx=this.skeleton.getContext('2d')!;ctx.clearRect(0,0,320,240);
    const edges=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
    for(const hand of frame.hands){ctx.strokeStyle=hand.side==='Right'?'#ddac7e':'#a4c4a4';ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=1.5;for(const [a,b]of edges){ctx.beginPath();ctx.moveTo((1-hand.landmarks[a].x)*320,hand.landmarks[a].y*240);ctx.lineTo((1-hand.landmarks[b].x)*320,hand.landmarks[b].y*240);ctx.stroke();}for(const p of hand.landmarks){ctx.beginPath();ctx.arc((1-p.x)*320,p.y*240,2.4,0,Math.PI*2);ctx.fill();}
      if(hand.side==='Right'?!gesture.operator:!gesture.helper)continue;
      const thumb=hand.landmarks[4],index=hand.landmarks[8];const x1=(1-thumb.x)*320,y1=thumb.y*240,x2=(1-index.x)*320,y2=index.y*240;
      const rgb=hand.side==='Right'?'135,206,250':'170,225,170';
      ctx.strokeStyle=`rgba(${rgb},0.72)`;ctx.fillStyle=`rgba(${rgb},0.45)`;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
      for(const [x,y]of [[x1,y1],[x2,y2]]){ctx.beginPath();ctx.arc(x,y,4.5,0,Math.PI*2);ctx.fill();ctx.stroke();}
      ctx.fillStyle=`rgba(${rgb},0.85)`;ctx.beginPath();ctx.arc((x1+x2)/2,(y1+y2)/2,2.5,0,Math.PI*2);ctx.fill();
    }
  }
  update(controller:Controller,scene:Scene,inferenceHz:number){
    this.text('status-text',controller.status);this.text('mode-label',MODE_LABELS[controller.mode]);
    this.text('mode-tip',{move:scene.active==='xyz'?'捏合移动；前后移动手掌调整深度。':'保持捏合，沿地板移动；松开放置。',rotate:'捏合后水平移动，绕竖直轴旋转。',height:'捏合后上下移动，调整离地高度。',observe:'单手环绕，双手捏合拉开或靠近。',scale:'双手捏合后拉开或靠近，缩放光标。'}[controller.mode]);
    this.text('fps',String(scene.fps||'—'));this.text('inference',inferenceHz?String(Math.round(inferenceHz)):'—');this.text('undo-count',String(controller.undoCount));
    this.get('furniture-panel').hidden=scene.active!=='furniture';this.get('xyz-panel').hidden=scene.active!=='xyz';this.get('depth-indicator').hidden=scene.active!=='xyz';
    this.text('scene-title',scene.active==='xyz'?'自由 · 三维定位':'午后 · 起居室');this.text('scene-subtitle',scene.active==='xyz'?'自然深度控制 / 20 个目标':'6 × 5 m / 自制家具资产');
    this.host.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button=>{
      button.classList.toggle('active',button.dataset.action===controller.mode||button.dataset.action===scene.active);
      if(button.dataset.action==='scale')button.disabled=scene.active!=='xyz';
    });
    this.host.querySelectorAll<HTMLButtonElement>('[data-item]').forEach(b=>b.classList.toggle('selected',b.dataset.item===controller.selected));
    const info=scene.info(scene.active==='xyz'?'cursor':controller.selected??'');this.inspect(info);
    if(scene.active==='xyz'){
      const task=scene.task;this.text('target-count',String(Math.min(20,task.index+1)).padStart(2,'0'));this.get('target-progress').style.width=`${task.progress*100}%`;
      this.text('target-result',task.complete?`已完成 20 个目标 · ${task.times.filter(t=>t<=10).length} 个在 10 秒内完成`:`距目标 ${task.distance.toFixed(2)} m · 到达后保持 1 秒`);
      const p=info!.transform.position,forward=scene.cameraAxes().forward;
      const extent=Math.abs(forward.x)*2.5+Math.abs(forward.y)*1.325+Math.abs(forward.z)*2;
      const toward=-(p.x*forward.x+(p.y-1.475)*forward.y+p.z*forward.z)/extent;
      this.get('depth-marker').style.top=`${Math.max(0,Math.min(1,(toward+1)/2))*100}%`;
    }
  }
  private inspect(info?:ObjectInfo){
    this.text('object-label',info?.label??'尚未选择物件');
    for(const axis of ['x','y','z']as const)this.text('coord-'+axis,info?info.transform.position[axis].toFixed(2)+' m':'—');
    this.text('angle',info?`朝向 ${Math.round(info.transform.rotation*180/Math.PI)}°`:'朝向 —');
    this.text('size',info?.id==='cursor'?`缩放 ${info.transform.scale.toFixed(2)}×`:'尺寸保持真实比例');
  }
}
