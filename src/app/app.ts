import { CameraSource } from '../camera/camera';
import { Tracker } from '../tracking/tracker';
import { RemoteTracker } from '../tracking/remote';
import { GestureEngine } from '../gestures/engine';
import { Controller } from '../controls/controller';
import { Scene } from '../scene/core/scene';
import { UI } from '../ui/ui';
import { CONFIG } from '../shared/config';
import type { Action, GestureFrame, Pointer, TrackingFrame } from '../shared/types';

export class App {
  readonly ui: UI;
  readonly scene: Scene;
  readonly controller: Controller;
  private camera: CameraSource;
  private tracker: Tracker | RemoteTracker = new Tracker();
  private remoteToken = '';
  private gestures = new GestureEngine();
  private cameraActive = false;
  private cameraStarting = false;
  private cameraGeneration = 0;
  private animation = 0;
  private disposed = false;
  private pointerHeld = false;
  private lastInference = 0;
  private lastVideoTime = -1;
  private lastResult = 0;
  private staleSent = false;
  private resultTimes: number[] = [];
  private lastUI = 0;
  private lastGesture?: GestureFrame;
  private mouse: Pointer = {x:0.5,y:0.5};
  private events = new AbortController();
  constructor(host:HTMLElement){
    this.ui=new UI(host);this.scene=new Scene(this.ui.canvas);this.controller=new Controller(this.scene);this.camera=new CameraSource(this.ui.video);
    const fragment = new URLSearchParams(location.hash.slice(1));
    this.remoteToken = fragment.get('token') ?? '';
    if (fragment.has('token')) history.replaceState(null, '', location.pathname + location.search);
    this.ui.trackingMode(new URLSearchParams(location.search).get('tracking') === 'remote');
    this.ui.onTrackingMode=()=>this.stopCamera();
    this.ui.onAction=action=>this.action(action);this.ui.onMenu=()=>this.openMenu();
    this.ui.onSelect=id=>{if(!this.controller.grabbing){this.controller.selected=id;this.scene.highlight(id);}};
    this.ui.onCamera=()=>void this.startCamera();this.ui.onStop=()=>this.stopCamera();this.ui.onDevice=()=>{if(this.cameraActive||this.cameraStarting)void this.startCamera();};
    this.camera.onDisconnect=()=>{this.stopCamera();this.ui.error('摄像头已断开，重新连接后点击开启。');};
    const canvas=this.ui.canvas,options={signal:this.events.signal};
    canvas.addEventListener('pointerdown',event=>{if(event.button!==0||this.ui.menuOpen)return;this.pointerHeld=true;canvas.setPointerCapture(event.pointerId);this.mouse=this.position(event);this.controller.interrupt();this.gestures.reset();this.controller.mouseDown(this.mouse);},options);
    canvas.addEventListener('pointermove',event=>{this.mouse=this.position(event);if(this.ui.menuOpen)return;if(!this.cameraActive||this.pointerHeld)this.controller.mouseMove(this.mouse);},options);
    canvas.addEventListener('pointerup',event=>{if(!this.pointerHeld)return;this.pointerHeld=false;this.mouse=this.position(event);this.controller.mouseUp(this.mouse);this.gestures.reset();},options);
    canvas.addEventListener('pointercancel',()=>{this.pointerHeld=false;this.controller.interrupt();this.gestures.reset();},options);
    canvas.addEventListener('wheel',event=>{event.preventDefault();if(!this.ui.menuOpen&&!this.controller.grabbing)this.controller.mouseDepth(event.deltaY);},{...options,passive:false});
    document.addEventListener('visibilitychange',()=>{if(document.hidden){this.controller.interrupt();this.gestures.reset();this.lastGesture=undefined;}},options);
    window.addEventListener('pagehide',()=>this.dispose(),options);
    window.addEventListener('keydown',event=>{if(event.key==='Escape'){this.controller.interrupt();this.ui.closeMenu();this.gestures.reset();}},options);
  }
  async start(){
    await this.scene.load();this.ui.ready();this.controller.status='指向家具，按住鼠标拖动；或开启摄像头';
    if(navigator.mediaDevices)void this.camera.devices().then(devices=>this.ui.devices(devices));
    this.loop(performance.now());
  }
  private position(event:PointerEvent):Pointer{const r=this.ui.canvas.getBoundingClientRect();return {x:(event.clientX-r.left)/r.width,y:(event.clientY-r.top)/r.height};}
  private openMenu(){this.controller.interrupt();this.gestures.reset();this.lastGesture=undefined;this.ui.openMenu(this.controller);}
  private action(action:Action){
    if(action==='reset'){this.controller.interrupt();this.ui.openMenu(this.controller,true);return;}
    this.controller.action(action);
    this.ui.closeMenu();this.controller.needsRelease=true;
  }
  private async startCamera(){
    this.stopCamera();const generation=this.cameraGeneration;this.cameraStarting=true;this.ui.error('');this.ui.cameraState('loading');
    try {
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('浏览器无法访问摄像头：本机请用 localhost；跨设备请使用已信任证书的 HTTPS 地址。');
      this.tracker=this.ui.remote?new RemoteTracker(this.remoteToken):new Tracker();
      this.tracker.onError=error=>{this.stopCamera();this.ui.error('识别停止：'+error);};
      this.tracker.onFrame=frame=>this.frame(frame);
      await this.tracker.start();if(generation!==this.cameraGeneration)return;
      const started=await this.camera.start(this.ui.device||undefined);if(!started||generation!==this.cameraGeneration)return;
      this.cameraActive=true;this.cameraStarting=false;this.gestures.reset();this.controller.interrupt();this.ui.cameraState('on');
      this.lastResult=performance.now();this.staleSent=false;this.resultTimes=[];this.lastVideoTime=-1;
      await this.ui.devices(await this.camera.devices());
    }catch(error){if(generation!==this.cameraGeneration)return;this.stopCamera();const name=error instanceof Error?error.name:'';this.ui.error(name==='NotAllowedError'?'摄像头权限未获允许；可继续使用鼠标，允许权限后重新开启。':error instanceof Error?error.message:String(error));}
  }
  private stopCamera(){this.cameraGeneration++;this.cameraActive=false;this.cameraStarting=false;this.camera.stop();this.tracker.stop();this.gestures.reset();this.controller.interrupt();this.lastGesture=undefined;this.resultTimes=[];this.ui.cameraState('off');}
  private frame(frame:TrackingFrame){
    if(!this.cameraActive)return;
    const now=performance.now();
    // Discard delayed positions rather than applying them after a render/UI stall.
    if(now-frame.timestamp>250){
      this.ui.text('tracking-timing',`结果过期 · 推理 ${frame.inferenceMs.toFixed(0)} ms · 往返 ${(frame.roundTripMs??now-frame.timestamp).toFixed(0)} ms，已冻结`);
      this.controller.interrupt();this.gestures.reset();this.lastGesture=undefined;return;
    }
    this.lastResult=now;this.staleSent=false;this.resultTimes.push(now);this.resultTimes=this.resultTimes.filter(t=>now-t<2000);
    const gesture=this.gestures.process(frame,this.ui.video.videoWidth/Math.max(1,this.ui.video.videoHeight));this.lastGesture=gesture;
    if(this.pointerHeld)return;
    if(gesture.menuCloseRequested&&this.ui.menuOpen){
      this.controller.interrupt();this.ui.closeMenu();this.gestures.reset();this.lastGesture=undefined;
      this.ui.pointer(gesture);this.ui.tracking(frame,gesture);return;
    }
    if(gesture.menuRequested&&!this.controller.grabbing&&!this.ui.menuOpen)this.openMenu();
    this.ui.pointer(gesture);this.ui.tracking(frame,gesture);
    if(!this.ui.menuOpen)this.controller.input(gesture);
  }
  private loop=(now:number)=>{
    if(this.disposed)return;
    if(this.cameraActive&&!document.hidden){
      if(now-this.lastInference>=CONFIG.inferenceInterval && this.ui.video.currentTime!==this.lastVideoTime){this.lastInference=now;this.lastVideoTime=this.ui.video.currentTime;void this.tracker.detect(this.ui.video,now);}
      if(now-this.lastResult>CONFIG.lossMs&&!this.staleSent){this.staleSent=true;this.controller.interrupt();this.gestures.reset();this.lastGesture=undefined;this.ui.pointer({timestamp:now,menuRequested:false,interrupted:true,ambiguous:false});this.controller.status='追踪暂停 · 当前位置已冻结';}
    }
    const taskRunning=!this.controller.viewing&&!this.controller.paused&&!this.ui.menuOpen&&(this.pointerHeld||(!this.cameraActive&&!this.controller.needsRelease)||!!this.lastGesture?.operator);
    this.scene.render(now,taskRunning);
    if(now-this.lastUI>100){const times=this.resultTimes.filter(t=>now-t<2000);const hz=times.length>1?(times.length-1)*1000/(times[times.length-1]-times[0]):0;this.ui.update(this.controller,this.scene,hz);this.lastUI=now;}
    this.animation=requestAnimationFrame(this.loop);
  };
  dispose(){if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this.animation);this.stopCamera();this.events.abort();this.scene.dispose();}
}
