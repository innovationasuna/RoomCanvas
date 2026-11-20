// The Form shell owns presentation only. Scene state, history and placement stay in scene-editor.
import {createPanelCoordinator} from './workspace-panels.mjs';
import {createContentMotion} from './workspace-motion.mjs';
const $ = selector => document.querySelector(selector);
const icon = name => `<svg aria-hidden="true"><use href="#icon-${name}"/></svg>`;
const element = (tag, className, html = '') => {
  const node = document.createElement(tag); node.className = className; node.innerHTML = html; return node;
};
const readPreference = (key, fallback) => {try {return localStorage.getItem(key) || fallback;} catch {return fallback;}};
const savePreference = (key, value) => {try {localStorage.setItem(key, value);} catch { /* UI preferences are optional. */ }};

function createWorkspace() {
  const root = $('#rc-placement-demo'), stage = $('.rc-stage'), toolbar = $('.rc-tools');
  root.dataset.mode = 'edit'; root.dataset.tool = 'move'; root.dataset.selection = 'none';
  root.dataset.density = readPreference('roomcanvas:tools', 'simple') === 'full' ? 'full' : 'simple';
  root.dataset.hints = readPreference('roomcanvas:hints', 'on');
  let state = {ready: false, selected: null, pending: false, mode: 'edit'}, filter = 'room';
  let guideDone = readPreference('roomcanvas:guide-done', '') === 'yes';

  // One fixed scene surface. Library and inspector are overlays, never canvas columns.
  stage.before(toolbar);
  const inspector = $('.rc-controls'), library = $('#object-panel');
  const importMenu = $('#import-menu'), focusButton = $('#focus');
  const scene = element('div', 'rc-scene');
  for (const child of [...stage.children]) if (child !== inspector) scene.append(child);
  stage.replaceChildren(library, scene, inspector);
  const panelSurface = element('div', 'rc-panel-surface');
  panelSurface.setAttribute('aria-hidden', 'true'); stage.prepend(panelSurface);
  $('.rc-warehouse-dock').remove();
  $('#viewport').setAttribute('aria-label', '三维房间。单击选择物品，拖动已选物品移动；按住中键拖动旋转镜头，右键拖动平移，滚轮缩放。');

  // Project operations belong with the room name, not beside every everyday tool.
  const project = $('.rc-project'), title = project.querySelector('strong');
  const projectMenu = element('details', 'rc-menu rc-project-menu');
  projectMenu.id = 'project-menu';
  projectMenu.innerHTML = `<summary aria-label="房间与项目操作"><h1></h1><span class="rc-project-chevron" aria-hidden="true">${icon('chevron')}</span></summary><div class="rc-menu-panel"><p class="menu-heading">布局管理</p></div>`;
  projectMenu.querySelector('h1').append(title); project.replaceChildren(projectMenu);
  const projectPanel = projectMenu.querySelector('.rc-menu-panel');
  for (const id of ['resume-layout', 'export-layout', 'import-layout', 'layout-file']) projectPanel.append($('#'+id));
  projectPanel.append(element('hr', 'menu-rule'));
  projectPanel.append(element('p', 'menu-heading', '房间整理'));
  for (const id of ['clear-room', 'reset-layout']) projectPanel.append($('#'+id));
  const allRooms = element('a', 'rc-project-home', `${icon('arrow-left')}<span>返回全部房间</span>`);
  projectPanel.append(element('hr', 'menu-rule'), allRooms);
  const mirrorHome = () => {
    const href = $('#home-link').getAttribute('href'); allRooms.hidden = !href;
    if (href) allRooms.setAttribute('href', href); else allRooms.removeAttribute('href');
  };
  new MutationObserver(mirrorHome).observe($('#home-link'), {attributes: true, attributeFilter: ['href']}); mirrorHome();
  for (const [id, symbol, label] of [
    ['resume-layout', 'undo', '继续上次布置'],
    ['export-layout', 'download', '导出布局备份'],
    ['import-layout', 'upload', '导入布局'],
    ['clear-room', 'cabinet', '收起全部物品'],
    ['reset-layout', 'reset', '恢复原始布置'],
  ]) $('#'+id).innerHTML = `${icon(symbol)}<span>${label}</span>`;
  $('#save-state').hidden = true;
  $('.rc-top').append(element('div', 'rc-header-actions', '<button type="button" class="rc-tool" id="open-help" aria-label="操作帮助">帮助 <span aria-hidden="true">?</span></button>'));
  $('[data-mode="preview"]').textContent = '体验';
  const walkButton = $('[data-mode="walk"]'); walkButton.textContent = '走进房间'; walkButton.className = 'rc-tool';
  const sceneHeading = element('div', 'rc-scene-heading', '<span class="rc-view-caption"><span class="rc-live-dot"></span><span id="view-caption">空间总览</span><span class="rc-view-units">真实尺寸 · 米</span></span><div class="rc-experience-actions"></div>');
  sceneHeading.querySelector('.rc-experience-actions').append(walkButton);
  const exitWalk = element('button', 'rc-tool', '退出漫游'); exitWalk.type = 'button'; exitWalk.id = 'exit-walk';
  sceneHeading.querySelector('.rc-experience-actions').append(exitWalk);
  scene.prepend(sceneHeading);

  // A quiet activity rail; keep the existing control IDs and scene callbacks.
  toolbar.classList.add('rc-sidebar'); toolbar.setAttribute('aria-label', '场景工具侧栏');
  const redo = element('button', 'rc-tool'); redo.id = 'redo'; redo.type = 'button'; redo.disabled = true;
  const historyTools = element('div', 'rc-history-tools'); historyTools.append($('#undo'), redo);
  const toolsPanel = $('#tools-menu .rc-menu-panel');
  const nearWalls = $('.rc-near-walls'), ceiling = $('#ceiling').closest('label'), material = $('#import-lighting').closest('label');
  const environment = $('#light-menu .rc-menu-panel');
  environment.setAttribute('role', 'region');
  environment.setAttribute('aria-labelledby', 'environment-title');
  const environmentHead = element('div', 'rc-environment-head', '<h2 id="environment-title">环境</h2><button type="button" class="rc-tool" id="close-environment" aria-label="关闭环境面板">×</button>');
  environment.prepend(environmentHead);
  $('#close-environment').onclick = () => {$('#light-menu').open = false; $('#light').focus();};
  // Native radio inputs keep keyboard navigation, without an OS menu covering this panel.
  // The original select remains the lighting controller's value source.
  const timeSelect = $('#lighting-time'), timeLabel = timeSelect.closest('label');
  timeLabel.hidden = true;
  const timeChoices = element('fieldset', 'rc-time-choices', '<legend>光照时段</legend>');
  for (const option of timeSelect.options) {
    const label = element('label', 'rc-time-choice');
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'lighting-time-choice'; radio.value = option.value;
    radio.checked = option.selected; radio.disabled = timeSelect.disabled;
    const caption = document.createElement('span'); caption.textContent = option.textContent;
    label.append(radio, caption); timeChoices.append(label);
  }
  timeLabel.after(timeChoices);
  const lamp = $('.rc-lamp-power'), lampCopy = element('span', 'rc-setting-copy', '<span id="lamp-name">中央顶灯</span>');
  lampCopy.append($('#lamp-status')); lamp.prepend(lampCopy);
  $('#lamp-power').classList.add('rc-setting-switch');
  $('#lamp-power').setAttribute('role', 'switch');
  $('#lamp-power').setAttribute('aria-label', '中央顶灯');
  environment.append(element('label', 'rc-switch-row rc-environment-grid', '<span class="rc-setting-copy"><span>地面网格</span><small>主格 1 米 · 细格 25 厘米</small></span><input id="ground-grid" class="rc-setting-switch" type="checkbox" role="switch" checked aria-label="显示地面网格，主格1米，细格25厘米">'));
  const extraLight = element('div', 'rc-full-only rc-environment-extra');
  extraLight.append($('#lamp-angle').closest('label'), $('#light-menu .rc-lighting-note'), nearWalls, ceiling, material, $('#lighting-menu')); environment.append(extraLight);
  const originalLink = toolsPanel.querySelector('a');
  toolsPanel.classList.add('rc-settings-panel');
  toolsPanel.id = 'settings-panel';
  toolsPanel.setAttribute('role', 'region');
  toolsPanel.setAttribute('aria-labelledby', 'settings-title');
  toolsPanel.replaceChildren(element('div', 'rc-settings-head', '<h2 id="settings-title">设置</h2><button type="button" class="rc-tool" id="close-settings" aria-label="关闭设置">×</button>'));
  const density = element('fieldset', 'rc-density', `<legend>工具显示</legend>
    <div id="tool-density" class="rc-density-switch">
      <label class="rc-density-option"><input class="rc-sr-only" type="radio" name="tool-density" value="simple"><span>简洁</span><small>常用布置工具</small></label>
      <label class="rc-density-option"><input class="rc-sr-only" type="radio" name="tool-density" value="full"><span>完整</span><small>全部工具与参数</small></label>
    </div>`);
  toolsPanel.append(density);
  const hintToggle = element('label', 'rc-switch-row rc-settings-hints', '<span class="rc-setting-copy"><span>操作提示</span><small>显示操作说明和引导</small></span><input id="hints-toggle" class="rc-setting-switch" type="checkbox" role="switch" aria-label="操作提示">');
  toolsPanel.append(hintToggle);
  const guideAction = element('button', 'rc-settings-action', `<span class="rc-setting-copy"><span>重新查看上手引导</span><small>从选择物品到完成布置</small></span>${icon('chevron')}`);
  guideAction.type = 'button'; guideAction.id = 'restart-guide'; toolsPanel.append(guideAction);
  // Source-model navigation belongs to the project menu, so settings has the same height in both modes.
  if (originalLink) {originalLink.classList.add('rc-full-only'); projectPanel.append(originalLink);}
  $('#close-settings').onclick = () => {$('#tools-menu').open = false; $('#tools-menu > summary').focus({preventScroll: true});};
  $('#lighting-menu summary').textContent = '画面调色（实验）';
  $('#lamp-angle').closest('label').classList.add('rc-full-only');
  $('#light-menu .rc-lighting-note').classList.add('rc-full-only');
  const mainTools = element('div', 'rc-rail-main'); mainTools.append($('#gesture-toggle'), $('#list-toggle'), historyTools);
  const settingsTools = element('div', 'rc-rail-settings'); settingsTools.append($('#light-menu'), $('#tools-menu'));
  toolbar.replaceChildren(mainTools, settingsTools);
  const railButton = (button, symbol, label, hint = label) => {
    button.classList.add('rc-rail-button');
    button.innerHTML = `${icon(symbol)}<span class="rc-sr-only">${label}</span>`;
    button.setAttribute('aria-label', label); button.dataset.tooltip = hint;
  };
  railButton($('#gesture-toggle'), 'hand', '手势控制面板', '手势 · 打开 / 收起面板');
  railButton($('#list-toggle'), 'layers', '物品库');
  railButton($('#undo'), 'undo', '撤销', '撤销 · ⌘ / Ctrl Z');
  railButton(redo, 'redo', '重做', '重做 · ⌘ / Ctrl Shift Z');
  railButton($('#light'), 'light', '环境');
  railButton($('#tools-menu > summary'), 'settings', '设置');
  $('#tools-menu > summary').setAttribute('aria-controls', 'settings-panel');
  $('#tools-menu > summary').removeAttribute('title');

  // The rail chooses one panel; camera capture and gesture recognition have their own lifecycle.
  const gestureCard = $('#gesture-card'), gestureButton = $('#gesture-toggle');
  const gestureHeading = element('div', 'rc-gesture-heading', '<span>手势控制</span><button type="button" class="rc-tool rc-close" id="close-gesture-panel" aria-label="收起手势面板">×</button>');
  gestureCard.prepend(gestureHeading);
  const gestureFooter = element('div', 'rc-gesture-footer', '<button type="button" class="rc-action" id="stop-gestures">开启手势与摄像头</button>');
  gestureCard.append(gestureFooter);
  gestureButton.setAttribute('aria-controls', 'gesture-card');
  gestureButton.setAttribute('aria-expanded', 'false');
  gestureButton.removeAttribute('aria-pressed');
  gestureButton.append(element('span', 'rc-camera-indicator'));
  gestureButton.lastChild.setAttribute('aria-hidden', 'true');
  let setLibraryOpen = null;
  const panels = createPanelCoordinator({
    // Call the drawer directly: a synthetic close-button click would also dismiss the new menu.
    library: () => {if (!library.hidden) setLibraryOpen?.(false);},
    gesture: () => setGesturePanel(false),
    environment: () => {$('#light-menu').open = false;},
    tools: () => {$('#tools-menu').open = false;},
  });
  function setGesturePanel(open) {
    gestureCard.hidden = !open;
    gestureButton.setAttribute('aria-expanded', String(open));
    panels.setOpen('gesture', open);
  }
  $('#close-gesture-panel').onclick = () => {setGesturePanel(false); gestureButton.focus({preventScroll: true});};
  gestureCard.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') {event.preventDefault(); $('#close-gesture-panel').click();}
  });

  // A compact furniture list, with real state filters and one add entry.
  const shelfHead = $('.rc-shelf-head');
  shelfHead.querySelector('.rc-shelf-title').textContent = '物品库';
  const search = $('.rc-search'); search.querySelector('span').innerHTML = icon('search');
  search.querySelector('input').placeholder = '搜索物品名称';
  shelfHead.after(search);
  const tabs = element('div', 'rc-library-tabs', '<button type="button" data-library="room" aria-pressed="true">房间中 <span></span></button><button type="button" data-library="stored" aria-pressed="false">已收纳 <span></span></button>');
  search.after(tabs);
  const count = $('#object-count'); shelfHead.after(count);
  const add = $('#add-object');
  add.querySelector('strong').textContent = '添加物品';
  const libraryFoot = element('div', 'rc-library-footer');
  libraryFoot.append(add, importMenu);
  $('#warehouse-content').append(libraryFoot);
  const empty = element('p', 'rc-library-empty'); empty.id = 'library-empty'; empty.hidden = true;
  $('#object-list').after(empty);
  const clearFilter = element('button', 'rc-tool', '清除搜索'); clearFilter.type = 'button'; clearFilter.id = 'clear-search'; clearFilter.hidden = true; empty.after(clearFilter);
  $('#import-menu summary').textContent = '从已生成的模型添加';

  // Measurements and continuous tools stay visible; confirmation is pinned below the scroll area.
  const inspectorHeading = element('div', 'rc-panel-heading', '<span>物品属性与操作</span><button type="button" class="rc-tool rc-close" id="close-inspector" aria-label="关闭物品详情">×</button>');
  const body = $('#selection-controls'); body.classList.add('rc-inspector-body');
  const summary = element('div', 'rc-object-summary'); summary.append($('#selected-name'), $('#selected-category'));
  const dimensions = element('section', 'rc-object-dimensions', '<div class="rc-inspector-section-heading"><h3>模型尺寸</h3><span>米 · 宽 × 深 × 高</span></div><dl><div><dt>宽</dt><dd id="dimension-width">—</dd></div><div><dt>深</dt><dd id="dimension-depth">—</dd></div><div><dt>高</dt><dd id="dimension-height">—</dd></div></dl>');
  const transform = $('.transform-section'), resetObject = $('#reset-object');
  const readouts = element('dl', 'rc-pose-readouts');
  for (const [id, label, unit] of [['offset-x', 'X', '米'], ['offset-z', 'Z', '米'], ['offset-y', '高度 Y', '米'], ['rotation', '角度', '']]) {
    const row = element('div', '', `<dt>${label}</dt><dd><span>${unit}</span></dd>`);
    row.querySelector('dd').prepend($('#'+id)); readouts.append(row);
  }
  transform.replaceChildren(element('div', 'rc-inspector-section-heading', '<h3>位置与角度</h3><span>相对初始状态</span>'), readouts);
  const height = element('section', 'height-section'); height.append($('.height-heading'), $('.height-buttons'));
  $('.advanced-controls').remove();
  const fieldset = $('#selection-fieldset');
  fieldset.insertBefore(height, $('.rotate-section'));
  fieldset.append($('.placement-section'));
  const adjust = element('div', 'rc-adjust-controls'); adjust.id = 'adjust-controls';
  const continuousTools = element('section', 'rc-continuous-tools', '<div class="rc-inspector-section-heading"><h3>连续拖动工具</h3><span>松手即停</span></div>');
  continuousTools.append(adjust);
  // Keep the legacy bindings for keyboard shortcuts, outside the visible tools.
  const legacy = $('#legacy-selection-controls'); legacy.hidden = true;
  $('#candidate-coordinate').hidden = true;
  const inspectorFoot = element('div', 'rc-inspector-footer');
  const storeButton = $('#store-object');
  inspectorFoot.append(focusButton, resetObject, storeButton);
  focusButton.innerHTML = `${icon('focus')}聚焦`;
  resetObject.innerHTML = `${icon('reset')}还原`;
  resetObject.setAttribute('aria-label', '还原此物品的初始位置和角度');
  storeButton.innerHTML = `${icon('cabinet')}收起`;
  storeButton.setAttribute('aria-label', '收起物品到物品库');
  $('#cancel-placement').textContent = '取消调整';
  const pendingActions = $('.rc-pending-actions'); pendingActions.append($('#cancel-placement'), $('#confirm-placement'));
  const transaction = element('div', 'rc-inspector-transaction'); transaction.append($('.rc-state'), pendingActions);
  body.replaceChildren(summary, dimensions, transform, inspectorFoot, $('#wall-section'), continuousTools, legacy);
  for (const id of ['session-rotate-left', 'session-rotate-right']) transaction.querySelector('#'+id).hidden = true;
  $('#empty-selection').textContent = '点击房间里的物品，或从物品库选择。';
  inspector.replaceChildren(inspectorHeading, body, transaction, $('#empty-selection'), $('#selected-count'));

  const guide = element('aside', 'rc-guide', '<div class="rc-guide-top"><span id="guide-step">开始布置</span><button type="button" id="dismiss-guide" aria-label="收起上手引导">×</button></div><strong id="guide-title">从一件物品开始</strong><p id="guide-copy">点选房间里的物品，或在左侧物品库中挑选。</p><div class="rc-guide-progress" aria-hidden="true"><i></i><i></i><i></i></div>');
  scene.append(guide);
  const footer = $('.rc-footer');
  footer.prepend(element('span', 'rc-footer-brand', 'RoomCanvas <span>空间布置工作台</span>'));
  footer.append(element('span', 'rc-footer-unit', '模型尺寸 1:1 · 单位：米'));
  $('.rc-help').append(element('button', 'rc-inline-help', '操作帮助')); $('.rc-inline-help').type = 'button';

  const help = element('dialog', 'rc-dialog rc-help-dialog', `
    <form method="dialog" class="rc-dialog-head">
      <div><h2 id="rc-help-title">操作帮助</h2><p id="rc-help-description">随手试一试，随时能撤销。</p></div>
      <button class="rc-tool rc-help-close" aria-label="关闭帮助" autofocus>×</button>
    </form>
    <div class="rc-help-body">
      <div class="rc-help-grid">
        <section><h3>观察房间</h3><dl class="rc-help-controls">
          <div><dt>中键拖动</dt><dd>旋转镜头</dd></div>
          <div><dt>右键拖动</dt><dd>平移视角</dd></div>
          <div><dt>滚轮</dt><dd>放大 / 缩小</dd></div>
        </dl><p class="rc-help-note">“整体”找回全景，“俯视”看清布局。</p></section>
        <section><h3>调整物品</h3><p>单击选中物品后拖动，或使用右侧控件。</p><dl class="rc-help-controls">
          <div><dt>左上摇杆</dt><dd>移动</dd></div>
          <div><dt>左下转盘</dt><dd>旋转</dd></div>
          <div><dt>右侧拉杆</dt><dd>升降</dd></div>
        </dl><p class="rc-help-note">松手即停，调整满意后确认放置。</p></section>
        <section><h3>走进空间</h3><p>切换“体验”可开合门窗。进入漫游后：</p><dl class="rc-help-controls">
          <div><dt><kbd>W A S D</kbd></dt><dd>走动</dd></div>
          <div><dt>中键拖动</dt><dd>转头</dd></div>
          <div><dt><kbd>Esc</kbd></dt><dd>退出漫游</dd></div>
        </dl></section>
        <section><h3>完整工具与手势</h3><p>左侧“设置”选择“完整”，展开精细参数。</p><p>点击左侧工具栏顶部的手势按钮开启手势：左手比 1 / 2 / 3 / 4 切换动作，右手捏合调整、竖拇指确认。</p></section>
      </div>
      <section class="rc-help-shortcuts"><h3>常用快捷键</h3><dl>
        <div><dt>撤销</dt><dd><kbd>⌘ / Ctrl</kbd><kbd>Z</kbd></dd></div>
        <div><dt>重做</dt><dd><kbd>⌘ / Ctrl</kbd><kbd>Shift</kbd><kbd>Z</kbd></dd></div>
        <div><dt>搜索物品</dt><dd><kbd>/</kbd></dd></div>
        <div><dt>旋转物品</dt><dd><kbd>R</kbd></dd></div>
        <div><dt>确认放置</dt><dd><kbd>Enter</kbd></dd></div>
        <div><dt>取消调整</dt><dd><kbd>Esc</kbd></dd></div>
      </dl></section>
      <section class="rc-help-safety"><h3>放心调整</h3><p>确认前可取消，确认后可撤销、重做。布局保存在当前浏览器，可从房间菜单导出备份。</p></section>
    </div>
    <div class="rc-dialog-actions"><button type="button" id="help-guide" class="rc-action">重新开始引导</button><button type="button" id="help-done" class="rc-action rc-confirm">开始布置 <span aria-hidden="true">→</span></button></div>`);
  root.append(help);
  help.setAttribute('aria-labelledby', 'rc-help-title');
  help.setAttribute('aria-describedby', 'rc-help-description');
  const showHelp = () => help.showModal();
  $('#open-help').onclick = $('.rc-inline-help').onclick = showHelp;
  $('#help-done').onclick = () => help.close();
  const restartGuide = () => {guideDone = false; root.dataset.hints = 'on'; savePreference('roomcanvas:hints', 'on'); savePreference('roomcanvas:guide-done', ''); $('#hints-toggle').checked = true; update(state);};
  $('#restart-guide').onclick = () => {$('#tools-menu').open = false; restartGuide();};
  $('#help-guide').onclick = () => {help.close(); restartGuide();};
  $('#dismiss-guide').onclick = () => {guideDone = true; savePreference('roomcanvas:guide-done', 'yes'); update(state);};
  $('#hints-toggle').checked = root.dataset.hints !== 'off';
  $('#hints-toggle').onchange = event => {root.dataset.hints = event.target.checked ? 'on' : 'off'; savePreference('roomcanvas:hints', root.dataset.hints); update(state);};
  for (const input of $('#tool-density').querySelectorAll('input')) input.checked = input.value === root.dataset.density;
  $('#tool-density').onchange = event => {
    if (!event.target.matches('input[name="tool-density"]') || !event.target.checked) return;
    root.dataset.density = event.target.value; savePreference('roomcanvas:tools', root.dataset.density);
    // Stay in settings while changing tool visibility; opening another rail panel would close it.
    update(state);
  };
  tabs.onclick = event => {
    const tab = event.target.closest('[data-library]'); if (!tab) return;
    filter = tab.dataset.library; filterLibrary();
  };
  search.querySelector('input').addEventListener('input', filterLibrary);
  clearFilter.onclick = () => {$('#search').value = ''; filterLibrary(); $('#search').focus();};

  // Rail panels dock to the scene; imports expand inside the library footer.
  const menus = [...root.querySelectorAll('details.rc-menu')];
  // Closing surfaces stop accepting focus immediately, even while their visual exit finishes.
  function syncPanelInput() {
    const editing = root.dataset.mode === 'edit';
    if (library.hidden || !editing || importMenu.hidden) importMenu.open = false;
    library.inert = library.hidden || !editing;
    gestureCard.inert = gestureCard.hidden;
    inspector.inert = inspector.hidden || !editing || (!library.hidden && (root.dataset.density === 'simple' || innerWidth <= 1100));
    for (const menu of menus) {
      const panel = menu.querySelector(':scope > .rc-menu-panel');
      if (panel) panel.inert = !menu.open;
    }
    importMenu.querySelector('summary').setAttribute('aria-expanded', String(importMenu.open));
  }
  const inputObserver = new MutationObserver(syncPanelInput);
  inputObserver.observe(root, {attributes:true, attributeFilter:['data-mode','data-density']});
  for (const panel of [library, gestureCard, inspector]) inputObserver.observe(panel, {attributes:true, attributeFilter:['hidden']});
  inputObserver.observe(importMenu, {attributes:true, attributeFilter:['hidden']});
  syncPanelInput();
  function positionMenus() {
    for (const menu of menus.filter(menu => menu.open)) {
      const panel = menu.querySelector(':scope > .rc-menu-panel'); if (!panel) continue;
      if (menu === importMenu || menu.closest('.rc-environment-extra')) continue;
      const inRail = !!menu.closest('.rc-sidebar');
      if (inRail) {
        // Match the library's edges without taking space away from the WebGL viewport.
        const bounds = stage.getBoundingClientRect();
        panel.style.left = `${bounds.left}px`;
        panel.style.top = `${bounds.top}px`;
        panel.style.height = `${bounds.height}px`;
        panel.style.maxHeight = `${bounds.height}px`;
        continue;
      }
      const anchor = menu.querySelector('summary').getBoundingClientRect();
      const topEdge = 12, bottomEdge = innerHeight - 12;
      const menuWidth = menu.id === 'project-menu' ? 256 : 320;
      const left = Math.max(12, Math.min(anchor.left, innerWidth - Math.min(menuWidth, innerWidth - 24) - 12));
      panel.style.width = `${Math.min(menuWidth, innerWidth - left - 12)}px`;
      panel.style.maxHeight = `${Math.max(0, bottomEdge - topEdge)}px`;
      panel.style.left = `${left}px`;
      const height = panel.getBoundingClientRect().height;
      panel.style.top = `${Math.max(topEdge, Math.min(anchor.bottom + 8, bottomEdge - height))}px`;
    }
  }
  for (const menu of menus) {
    menu.addEventListener('toggle', () => {
      if (menu.id === 'light-menu') panels.setOpen('environment', menu.open);
      if (menu.id === 'tools-menu') panels.setOpen('tools', menu.open);
      if (menu.open) for (const other of menus) if (other !== menu && !other.contains(menu) && !menu.contains(other)) other.open = false;
      syncPanelInput();
      positionMenus();
    });
    menu.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') {event.preventDefault(); menu.open = false; menu.querySelector('summary').focus();}
    });
  }
  document.addEventListener('click', event => {for (const menu of menus) if (!menu.contains(event.target)) menu.open = false;});
  window.addEventListener('resize', positionMenus);
  window.addEventListener('resize', syncPanelInput);
  // Keep docked panels aligned when the workspace resizes; popovers still fit their content.
  const menuObserver = new ResizeObserver(positionMenus);
  menuObserver.observe(stage);
  for (const menu of menus) {
    const panel = menu.querySelector(':scope > .rc-menu-panel');
    if (panel && !menu.closest('.rc-environment-extra')) menuObserver.observe(panel);
  }
  // Dialog keyboard events must not leak into the scene's placement shortcuts.
  root.addEventListener('keydown', event => {if (event.target.closest('dialog')) event.stopPropagation();});

  const confirmDialog = element('dialog', 'rc-dialog rc-confirm-dialog', '<form method="dialog"><h2 id="action-title"></h2><p id="action-description"></p><div class="rc-dialog-actions"><button class="rc-action" value="cancel" autofocus>取消</button><button class="rc-action rc-confirm" value="confirm" id="action-confirm">确认</button></div></form>');
  confirmDialog.setAttribute('aria-labelledby', 'action-title'); root.append(confirmDialog);

  function filterLibrary() {
    const rows = [...$('#object-list').querySelectorAll('[data-object]')], term = $('#search').value.trim().toLowerCase();
    let count = 0, roomCount = 0;
    for (const row of rows) {
      const stored = row.dataset.stored === 'true'; if (!stored) roomCount++;
      const visible = (filter === 'stored' ? stored : !stored) && row.textContent.toLowerCase().includes(term);
      (row.closest('.rc-imported-card') || row).hidden = !visible; if (visible) count++;
    }
    for (const tab of tabs.querySelectorAll('button')) {
      tab.setAttribute('aria-pressed', String(tab.dataset.library === filter));
      tab.querySelector('span').textContent = tab.dataset.library === 'room' ? roomCount : rows.length - roomCount;
    }
    empty.hidden = !state.ready || count > 0;
    empty.textContent = term ? '没有找到这件物品，换个名称试试。' : filter === 'stored' ? '还没有收纳的物品。选中房间里的物品，点击“收起”即可放到这里。' : '房间里暂时没有物品，从“已收纳”中放回，或添加一件新物品。';
    clearFilter.hidden = empty.hidden || !term;
    $('#object-count').textContent = term ? `找到 ${count} 件物品` : `共 ${rows.length} 件物品`;
  }
  function setTool(tool) {
    root.dataset.tool = tool;
  }
  const contentMotion = createContentMotion();
  function update(next) {
    const previous = state;
    state = {...state, ...next};
    root.dataset.selection = state.selected ? 'selected' : 'none'; root.dataset.pending = String(!!state.pending);
    root.dataset.wall = String(!!state.wall); root.dataset.ready = String(!!state.ready);
    if (state.wall && root.dataset.tool !== 'move') setTool('move');
    $('#exit-walk').hidden = state.mode !== 'walk'; walkButton.hidden = state.mode === 'walk';
    $('.rc-panel-heading > span').textContent = state.pending ? '调整预览 · 尚未保存' : '物品属性与操作';
    $('#view-caption').textContent = state.mode === 'walk' ? '室内漫游' : state.mode === 'preview' ? '空间体验' : state.view === 'top' ? '俯视布局' : '空间总览';
    guide.hidden = !state.ready || guideDone || root.dataset.hints === 'off' || state.mode !== 'edit';
    const step = state.pending ? 2 : state.selected ? 1 : 0;
    $('#guide-step').textContent = ['开始布置', '已选中物品', '调整后确认'][step];
    $('#guide-title').textContent = ['从一件物品开始', '试着换个位置', '满意了，就放在这里'][step];
    $('#guide-copy').textContent = ['点选房间里的物品，或从物品库选择。', '拖动已选物品，或使用右侧连续拖动工具调整。选中本身不会改变位置。', '点击“确认放置”保存这次调整；不满意可取消，回到原位置。'][step];
    guide.querySelectorAll('.rc-guide-progress i').forEach((part, index) => part.classList.toggle('active', index <= step));
    for (const id of ['list-toggle','clear-room','reset-layout','export-layout','import-layout']) $('#'+id).disabled = !state.ready;
    filterLibrary();
    if (previous.selected && state.selected && previous.selected !== state.selected) contentMotion.refresh([summary, dimensions, transform]);
    if (!guide.hidden && (previous.pending !== state.pending || previous.selected !== state.selected)) contentMotion.refresh([$('#guide-title'), $('#guide-copy')]);
  }
  update(state);
  return {
    update, filterLibrary, setTool, setGesturePanel,
    get gesturePanelOpen() {return !gestureCard.hidden;},
    bindLibrary(setOpen) {setLibraryOpen = setOpen;},
    libraryVisibility(open) {panels.setOpen('library', open);},
    get density() {return root.dataset.density;},
    completed() {guideDone = true; savePreference('roomcanvas:guide-done', 'yes'); update(state);},
    showStored() {filter = 'stored'; filterLibrary();},
    confirm(title, description, actionLabel = '确认') {
      if (confirmDialog.open) return Promise.resolve(false);
      $('#action-title').textContent = title; $('#action-description').textContent = description; $('#action-confirm').textContent = actionLabel;
      confirmDialog.returnValue = ''; confirmDialog.showModal();
      return new Promise(resolve => confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'confirm'), {once: true}));
    },
  };
}

export const workspace = createWorkspace();
