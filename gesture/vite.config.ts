import { defineConfig, loadEnv, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { localApiPlugin } from './server/local-api.ts';
// 可选同源验收入口；默认仍用 7870 编辑器以保留已有浏览器布局。
const defaultEditorOrigin = 'http://127.0.0.1:7870';
// Google GIS 对本机 HTTP 开发环境的来源与弹窗要求。
const loginHeaders = {'Referrer-Policy':'no-referrer-when-downgrade','Cross-Origin-Opener-Policy':'same-origin-allow-popups'};
// 根地址与旧书签跳到唯一页面；查询参数与浏览器中的 hash 保持可用。
function roomCanvasEntry(): Plugin {
  const redirect: import('vite').Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const url = new URL(req.url || '/', 'http://localhost');
    if (!['/', '/index.html', '/roomcanvas.html', '/viewforge.html', '/furniture-demo.html'].includes(url.pathname)) return next();
    res.writeHead(302, {Location: `/RoomCanvas.html${url.search}`});
    res.end();
  };
  return {
    name: 'roomcanvas-entry',
    configureServer(server) { server.middlewares.use(redirect); },
    configurePreviewServer(server) { server.middlewares.use(redirect); },
  };
}
export default defineConfig(({mode}) => {
  const env = loadEnv(mode, process.cwd(), ['GOOGLE_', 'ROOMCANVAS_', 'VITE_ROOMCANVAS_']);
  const dataRoot = env.ROOMCANVAS_DATA_ROOT ? resolve(env.ROOMCANVAS_DATA_ROOT) : fileURLToPath(new URL('../../.roomcanvas-local/',import.meta.url));
  const editorTarget = env.VITE_ROOMCANVAS_EDITOR_ORIGIN || defaultEditorOrigin;
  const proxy = {
    '/room': {target:editorTarget,changeOrigin:false,rewrite:(path:string) => path.replace(/^\/room/,'')},
    // 导入房间使用同源 iframe，其物体 API 也必须经过编辑器服务的白名单转发。
    '/viewforge': {target:editorTarget,changeOrigin:false},
  };
  return {
  appType:'mpa',
  plugins:[roomCanvasEntry(),localApiPlugin({repoRoot:fileURLToPath(new URL('../',import.meta.url)),dataRoot,clientId:env.GOOGLE_CLIENT_ID})],
  worker:{format:'es'},
  server:{headers:loginHeaders,proxy,fs:{deny:['.env','.env.*','*.{crt,pem}','**/.git/**','**/.roomcanvas-local/**',`${dataRoot}/**`,'**/server/**']}},
  preview:{headers:loginHeaders,proxy},
  build:{target:'es2022',rollupOptions:{input:{RoomCanvas:'RoomCanvas.html'}}},
  };
});
