import type { LocalSession } from './room-types';

let session: LocalSession | undefined;
export async function getSession() {
  session = await request<LocalSession>('/api/session');
  return session;
}
export function setSession(value: LocalSession) {session = value;}
export async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET') headers.set('X-RoomCanvas-CSRF', session?.csrf || '');
  const response = await fetch(url, {...init, headers, credentials: 'same-origin'});
  const data = await response.json().catch(() => ({error: '本机房间服务暂时不可用'}));
  if (!response.ok) throw new Error(data.error || '操作失败，请重试');
  return data as T;
}
export function jsonBody(value: unknown): Pick<RequestInit, 'body' | 'headers'> {
  return {body: JSON.stringify(value), headers: {'Content-Type': 'application/json'}};
}
