// 本地工作台的底部家具栏；复用原编辑器的按钮、缩略图和文件操作。
export function mountStudioUI({resize, selected}) {
  const $ = selector => document.querySelector(selector);
  const root = $('#rc-placement-demo'), shelf = $('#object-panel'), catalog = $('#object-list');
  root.dataset.studio = 'true';
  root.dataset.shelf = 'open'; root.dataset.screen = 'studio';
  const bottom = document.createElement('div'); bottom.className = 'studio-bottom';
  const navigation = document.createElement('nav'); navigation.className = 'studio-bottom-nav'; navigation.setAttribute('aria-label','场景家具与素材');
  navigation.innerHTML = '<div class="shelf-tabs" role="group" aria-label="家具分类"><button type="button" data-shelf-tab="room" aria-pressed="true">房间家具</button><button type="button" data-shelf-tab="stored" aria-pressed="false">＋ 添加素材</button></div><button type="button" id="shelf-toggle" aria-expanded="true" aria-controls="object-panel">收起家具栏 ↓</button>';
  const tools = $('.rc-tools'); tools.classList.add('studio-actions');
  const menu = $('#tools-menu .rc-menu-panel');
  menu.prepend($('#clear-room'),$('#reset-layout'));
  $('#tools-menu summary').textContent = '更多 ···';
  $('#export-layout').textContent = '保存布局文件';
  $('#list-toggle').hidden = true; $('#close-list').hidden = true;
  navigation.insertBefore(tools,$('#shelf-toggle') || navigation.lastElementChild);
  bottom.append(navigation,shelf); root.insertBefore(bottom,$('.rc-footer'));
  shelf.before($('#wall-section'));
  $('.rc-shelf-title').textContent = '家具';
  $('#search').placeholder = '找一件家具';
  const empty = document.createElement('p'); empty.className = 'shelf-empty'; empty.hidden = true; shelf.append(empty);
  let tab = 'room', screen = 'studio';
  const filter = () => {
    const term = $('#search').value.trim().toLowerCase(); let count = 0;
    for (const card of catalog.children) {
      const row = card.matches('[data-object]') ? card : card.querySelector('[data-object]');
      if (!row) {
        card.hidden = card.id === 'add-object' && (screen !== 'library' && tab !== 'stored');
        continue;
      }
      const stored = row.dataset.stored === 'true';
      card.hidden = !row.textContent.toLowerCase().includes(term) || (screen !== 'library' && (tab === 'stored' ? !stored : stored));
      if (!card.hidden) count++;
    }
    $('#object-count').textContent = `${count} 件`;
    empty.hidden = count > 0 || (tab === 'stored' && !term);
    empty.textContent = term ? '未找到家具' : tab === 'stored' ? '暂无收起的家具' : '房间内暂无家具';
  };
  const expand = open => {
    root.dataset.shelf = open ? 'open' : 'closed';
    navigation.querySelector('#shelf-toggle').textContent = open ? '收起家具栏 ↓' : '展开家具栏 ↑';
    navigation.querySelector('#shelf-toggle').setAttribute('aria-expanded',String(open));
    shelf.inert = !open;
  };
  navigation.querySelector('#shelf-toggle').onclick = () => expand(root.dataset.shelf !== 'open');
  for (const button of navigation.querySelectorAll('[data-shelf-tab]')) button.onclick = () => {
    tab = button.dataset.shelfTab; expand(true);
    navigation.querySelectorAll('[data-shelf-tab]').forEach(b => b.setAttribute('aria-pressed',String(b === button)));filter();
  };
  $('#search').oninput = filter;
  const observer = new MutationObserver(filter); observer.observe(catalog,{subtree:true,childList:true,attributes:true,attributeFilter:['data-stored']});
  new ResizeObserver(resize).observe($('.rc-stage'));
  const show = next => {
    if (next === 'library' && selected()) return;
    if (screen === 'library' && next === 'studio') {
      tab = 'room'; navigation.querySelectorAll('[data-shelf-tab]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.shelfTab === tab)));
    }
    screen = next; root.dataset.screen = next;
    if (next === 'library') {expand(true); $('#search').value='';}
    filter(); requestAnimationFrame(resize);
  };
  filter();
  return {show, get screen() {return screen;}};
}
