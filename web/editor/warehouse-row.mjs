export function warehouseRow(entity, {inspectObject, removeImportedObject, thumbnailSize}) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'object-row'; row.dataset.object = entity.id;
  row.setAttribute('aria-pressed', 'false');
  row.setAttribute('aria-label', `${entity.name}，查看与布置`);
  row.innerHTML = `<span class="warehouse-state">在房间</span><img class="object-thumb" alt="" width="${thumbnailSize.width}" height="${thumbnailSize.height}"><span class="object-copy"><strong>${entity.name}</strong><small>${entity.category}</small></span><span class="object-dot" aria-hidden="true"></span>`;
  row.onclick = () => {
    inspectObject(entity.id);
  };
  let card = row;
  if (entity.added) {
    card = document.createElement('div'); card.className = 'rc-imported-card';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'rc-remove-object';
    remove.dataset.removeObject = entity.id;
    remove.setAttribute('aria-label', `删除${entity.name}这一份`);
    remove.title = '删除这一份物品，保留重建结果';
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></svg>';
    remove.onclick = () => removeImportedObject(entity.id);
    card.append(row, remove);
  }
  return card;
}
