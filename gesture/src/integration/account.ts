import { getSession, jsonBody, request, setSession } from './local-client';
import type { LocalSession } from './room-types';

interface GoogleIdentity {
  initialize(options: {client_id: string; nonce: string; callback: (response: {credential: string}) => void; auto_select: boolean; context: string}): void;
  renderButton(element: HTMLElement, options: Record<string, string | number>): void;
  disableAutoSelect(): void;
}
declare global {interface Window {google?: {accounts: {id: GoogleIdentity}}}}
let googleScript: Promise<void> | undefined;
function loadGoogle() {
  if (window.google?.accounts.id) return Promise.resolve();
  if (googleScript) return googleScript;
  googleScript = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
    script.referrerPolicy = 'strict-origin-when-cross-origin';
    const timeout = window.setTimeout(() => {script.remove(); googleScript = undefined; reject(new Error('Google 暂时无法连接，请重试'));}, 15000);
    script.onload = () => {clearTimeout(timeout); resolve();};
    script.onerror = () => {clearTimeout(timeout); script.remove(); googleScript = undefined; reject(new Error('Google 暂时无法连接，请重试'));};
    document.head.append(script);
  });
  return googleScript;
}

export function setupAccount(changed: () => Promise<void>, notice: (message: string) => void) {
  const status = document.getElementById('login-status')!;
  const fallback = document.getElementById('google-unavailable') as HTMLButtonElement;
  let generation = 0;
  async function render() {
    const current = ++generation;
    try {
      const session = await getSession();
      if (current !== generation) return;
      const signed = !!session.user;
      document.getElementById('account-link')!.firstChild!.textContent = signed ? '我的账户 ' : '登录 ';
      document.getElementById('signed-in')!.hidden = !signed;
      document.getElementById('signed-out')!.hidden = signed;
      document.getElementById('login-title')!.textContent = signed ? '很高兴见到你。' : '欢迎回家。';
      document.getElementById('account-name')!.textContent = session.user?.name || '';
      document.getElementById('account-email')!.textContent = session.user?.email || '';
      if (signed) return;
      fallback.hidden = false; fallback.disabled = true;
      if (!session.clientId) {status.textContent = 'Google 登录配置中'; return;}
      status.textContent = '正在连接 Google…';
      await loadGoogle();
      if (current !== generation) return;
      const identity = window.google?.accounts.id;
      if (!identity) throw new Error('Google 暂时无法连接，请重试');
      const container = document.getElementById('google-signin')!;
      container.replaceChildren();
      identity.initialize({client_id: session.clientId, nonce: session.nonce, auto_select: false, context: 'signin', callback: async response => {
        status.textContent = '正在登录…';
        try {
          const next = await request<LocalSession>('/api/auth/google', {method: 'POST', ...jsonBody(response)});
          setSession(next); await changed(); await render(); notice('登录成功');
        } catch (error) {status.textContent = (error as Error).message;}
      }});
      identity.renderButton(container, {type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'rectangular', width: Math.min(350, container.clientWidth || 350), locale: 'zh_CN'});
      fallback.hidden = true; status.textContent = '';
    } catch (error) {
      status.textContent = (error as Error).message;
      fallback.hidden = false; fallback.disabled = false;
      fallback.textContent = '重新连接 Google'; fallback.onclick = () => void render();
    }
  }
  document.getElementById('signout')!.addEventListener('click', async () => {
    try {
      setSession(await request<LocalSession>('/api/auth/logout', {method: 'POST'}));
      window.google?.accounts.id.disableAutoSelect(); await changed(); await render(); notice('已退出登录');
    } catch (error) {notice((error as Error).message);}
  });
  return {render};
}
