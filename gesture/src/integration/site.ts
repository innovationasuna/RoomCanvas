import { getSession } from './local-client';
import { setupAccount } from './account';
import { setupLibrary } from './room-library';
import { setupCoverPull } from './cover-pull';
import type { RoomRecord } from './room-types';

type Page = 'home' | 'rooms' | 'create' | 'login' | 'tasks' | 'studio' | 'furniture';
const pages: Page[] = ['home', 'rooms', 'create', 'login', 'tasks', 'studio', 'furniture'];
const sectionName = (page: Page) => page === 'furniture' ? 'studio' : page;
export function setupSite(port: {openRoom: (room: RoomRecord) => void; leaveStudio: () => void; pending: () => boolean}) {
  let current: Page | null = null, requested: Page | null = null, room: RoomRecord | undefined, changing = 0, noticeTimer = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const main = document.querySelector('main')!, cover = document.getElementById('cover')!;
  const coverPull = setupCoverPull(cover, {canStart: () => current === 'home' && !requested, open: () => void navigate('rooms'), reducedMotion: reduced});
  const notice = (message: string, undo?: () => void) => {
    const box = document.getElementById('site-notice')!;
    box.replaceChildren(document.createTextNode(message));
    if (undo) {const button = document.createElement('button'); button.textContent = '撤销'; button.onclick = () => {button.disabled = true; undo();}; box.append(button);}
    box.hidden = false; clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {box.hidden = true;}, undo ? 10000 : 4500);
  };
  const library = setupLibrary({notice, created: () => void navigate('rooms'), open(selected) {
    if (port.pending()) {notice('请先确认或取消当前试摆。'); return;}
    room = selected; library.opened(selected); void navigate('studio');
  }});
  const account = setupAccount(async () => {await library.reload(); room = library.rooms[0];}, notice);
  const roomTitle = () => room?.name || '我的房间';
  const isWorkspace = (page: Page | null) => page === 'studio' || page === 'furniture';
  const section = (page: Page) => document.querySelector<HTMLElement>(`main > section[data-page="${sectionName(page)}"]`)!;
  function playCover() {
    coverPull.reset();
    cover.querySelectorAll<HTMLElement>('.reveal-line > span,.pull-invite').forEach((element, index) => {
      element.getAnimations().forEach(animation => animation.cancel());
      if (reduced.matches) return;
      element.animate([{opacity: 0, transform: index < 2 ? 'translateY(115%)' : 'translateY(18px)'}, {opacity: 1, transform: 'translateY(0)'}], {duration: index < 2 ? 1050 : 850, delay: index * 180 + 80, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both'});
    });
  }
  function updatePage(next: Page, push: boolean) {
    current = next;
    if (push) {
      const target = new URL(location.href); target.hash = next;
      if (isWorkspace(next) && room) target.searchParams.set('room', room.id); else target.searchParams.delete('room');
      history.pushState(null, '', target);
    }
    document.body.dataset.page = next;
    document.querySelectorAll('.site-header a').forEach(link => {
      if (link.getAttribute('href') === '#' + next) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    document.getElementById('room-title')!.textContent = next === 'furniture' ? `家具库 · ${roomTitle()}` : roomTitle();
    window.scrollTo({top: 0, behavior: 'instant'});
    if (isWorkspace(next) && room) port.openRoom(room);
    document.title = next === 'home' ? 'RoomCanvas · 把家布置成喜欢的样子' : `RoomCanvas · ${({rooms: '我的房间', create: '创建新房间', login: '登录', tasks: '制作进度', studio: roomTitle(), furniture: '家具库'} as Record<string, string>)[next]}`;
    if (next === 'login') void account.render();
    if (next === 'create') library.resetCreate();
  }
  async function navigate(next: Page, push = true) {
    if (next === requested) return;
    if (next === current) {
      if (next === 'home') playCover();
      else if (next === 'create') library.resetCreate(true);
      else if (isWorkspace(next) && room) {port.openRoom(room); document.getElementById('room-title')!.textContent = roomTitle();}
      return;
    }
    if (isWorkspace(current) && port.pending() && !(current === 'furniture' && next === 'studio')) {notice('请先确认放置或取消，再离开房间。'); history.replaceState(null, '', '#studio'); return;}
    if (isWorkspace(next)) {
      if (!room || !library.find(room.id)) room = library.rooms[0];
      if (!room) {notice('先创建一个房间，再开始布置。'); next = 'rooms';}
    }
    requested = next;
    const ticket = ++changing, previous = current;
    document.body.classList.add('page-changing');
    if (previous === 'studio') port.leaveStudio();
    const slide = previous === 'home' && next === 'rooms' && !reduced.matches;
    if (!slide && previous && !reduced.matches) await main.animate([{opacity: 1, transform: 'translateY(0)'}, {opacity: 0, transform: 'translateY(-8px)'}], {duration: 150, easing: 'ease-in', fill: 'forwards'}).finished.catch(() => {});
    if (ticket !== changing) return;
    main.getAnimations().forEach(animation => animation.cancel());
    document.querySelectorAll<HTMLElement>('main > section[data-page]').forEach(element => {element.hidden = element.dataset.page !== sectionName(next);});
    updatePage(next, push);
    if (slide) {
      const outgoing = section('home'), incoming = section('rooms');
      const headerHeight = document.querySelector('.site-header')!.getBoundingClientRect().height;
      outgoing.hidden = false;
      outgoing.style.cssText = `position:fixed;inset:${headerHeight}px 0 0;z-index:8;overflow:hidden;pointer-events:none`;
      const dragOffset = coverPull.takeOffset();
      const incomingAnimation = incoming.animate([{transform: 'translateX(80px)', opacity: .5}, {transform: 'translateX(0)', opacity: 1}], {duration: 740, easing: 'cubic-bezier(.16,1,.3,1)'});
      await outgoing.animate([{transform: `translateX(${dragOffset}px)`}, {transform: 'translateX(-100vw)'}], {duration: 680, easing: 'cubic-bezier(.65,0,.2,1)', fill: 'forwards'}).finished.catch(() => {});
      outgoing.hidden = true; outgoing.removeAttribute('style'); outgoing.getAnimations().forEach(animation => animation.cancel()); incomingAnimation.cancel();
    } else if (!reduced.matches) {
      main.animate([{opacity: 0, transform: 'translateY(12px)'}, {opacity: 1, transform: 'translateY(0)'}], {duration: 420, easing: 'cubic-bezier(.2,.7,.2,1)'});
    }
    if (previous === 'home') coverPull.reset();
    if (ticket !== changing) return;
    requested = null; document.body.classList.remove('page-changing');
    if (next === 'home') playCover();
    else {const heading = section(next).querySelector<HTMLElement>('h1'); if (heading) {heading.tabIndex = -1; heading.focus({preventScroll: true});}}
  }
  function readRoute(): Page {
    const selected = new URLSearchParams(location.search).get('room');
    if (selected) {
      const found = library.find(selected);
      if (!found) {notice('这个房间已删除或不可访问。'); return 'rooms';}
      room = found;
    }
    const value = location.hash.slice(1) as Page;
    return pages.includes(value) ? value : new URLSearchParams(location.search).has('layout') ? 'studio' : 'home';
  }
  document.addEventListener('click', event => {
    const target = (event.target as Element).closest<HTMLElement>('a,button'); if (!target) return;
    if (target.hasAttribute('data-rail-toggle')) {
      const collapsed = document.querySelector('.workspace')!.classList.toggle('rail-collapsed');
      document.querySelectorAll('[data-rail-toggle]').forEach(button => button.setAttribute('aria-expanded', String(!collapsed)));
      document.querySelector<HTMLElement>('.rail-body')!.inert = collapsed;
    } else if (target instanceof HTMLAnchorElement && target.getAttribute('href')?.startsWith('#') && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const page = target.hash.slice(1) as Page;
      if (pages.includes(page)) {event.preventDefault(); void navigate(page);}
    }
  });
  window.addEventListener('popstate', () => void navigate(readRoute(), false));
  if (innerWidth < 680) {document.querySelector('.workspace')!.classList.add('rail-collapsed'); document.querySelector<HTMLElement>('.rail-body')!.inert = true;}
  void (async () => {
    try {
      const session = await getSession();
      document.getElementById('account-link')!.firstChild!.textContent = session.user ? '我的账户 ' : '登录 ';
      await library.reload(); room = library.rooms[0];
    } catch (error) {notice((error as Error).message);}
    await navigate(readRoute(), false);
  })();
  return {notice, get page() {return current;}, selectionOpened() {if (current === 'furniture') void navigate('studio');}};
}
