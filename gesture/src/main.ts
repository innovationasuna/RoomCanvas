import './styles/main.css';
import { App } from './app/app';
const host=document.querySelector<HTMLElement>('#app')!;
try {
  const app=new App(host);
  app.start().catch(error=>{app.ui.get('loading').textContent='场景加载失败：'+String(error);app.ui.error('请检查本地模型资源，刷新后重试。');app.dispose();});
} catch(error) {
  host.replaceChildren();const message=document.createElement('div');message.className='fatal';message.textContent='无法启动三维场景。请使用支持 WebGL2 的 Chrome / Safari，并开启浏览器硬件加速。\n'+String(error);host.append(message);
}
