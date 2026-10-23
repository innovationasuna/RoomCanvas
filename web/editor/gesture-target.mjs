// 近距离吸附和已缓存的悬停目标都必须重新检查可见性。
// 折叠的 details 子元素可能仍返回非零矩形，不能只靠尺寸判断。
export function canGestureActivate(element) {
  if (!element || element.disabled || element.closest('[hidden], [inert], [data-gesture-ignore]')) return false;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.localName === 'details' && !parent.open) {
      const summary = parent.querySelector(':scope > summary');
      if (!summary?.contains(element)) return false;
    }
  }
  return !element.checkVisibility || element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
}

export function isExplicitExport(event) {
  // 手势使用 element.click()，不能触发文件下载；鼠标和键盘仍可导出。
  return event?.isTrusted === true;
}
