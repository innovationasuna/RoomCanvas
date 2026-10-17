"""Metric room layouts. Original GLBs are immutable; instances store calibration + scale."""
import json
import hashlib
import math
import os
import re
import uuid
from pathlib import Path
from dimensions import atomic_json, read_dimensions, result_directory

ROOMS = {
    'office': ('route1_office_room_v1', '办公室 · RoomPlan 米制'),
    'tea': ('route1_tea_room_v1', '茶室 · RoomPlan 米制'),
    'office-photo': ('route2_step6_office_structure', '办公室 · 照片重建 / 扫描配准米制'),
}

def room_root(root):
    return Path(os.environ.get('VIEWFORGE_ROOMS_ROOT', str(root.parent/'RoomCanvas-Reconstruction/runs')))

def room(root, name):
    if name not in ROOMS:
        raise ValueError('未知房间')
    folder, label = ROOMS[name]
    path = room_root(root)/folder
    data = json.loads((path/'room_structure.json').read_text())
    if data['meta']['units'] != 'meter':
        raise ValueError('房间尚未具有米制依据')
    version=hashlib.sha256((path/'room_structure.json').read_bytes()+(path/'empty_room.glb').read_bytes()).hexdigest()
    return dict(id=name, label=label, version=version, structure=data, url=f'/viewforge/layouts/rooms/{name}.glb')

def positive(value, label, low=1e-6, high=1e6):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'{label}超出有效范围')
    return value

def finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > 1e6:
        raise ValueError('位置或角度无效')
    return value

def validate_layout(root, payload):
    r=room(root,payload['room_id']); structure=r['structure']
    if payload.get('room_version') and payload['room_version'] != r['version']: raise ValueError('房间源模型已变化，请新建布局并重新标定')
    calibration=payload.get('room_calibration')
    scale=1.
    if calibration:
        wall=structure['walls'].get(calibration.get('wall'))
        if wall is None: raise ValueError('请选择有效的参考墙')
        scale=positive(calibration.get('meters'),'墙长')/wall['length']
    positive(scale,'房间比例')
    poly=next(iter(structure['floor'].values()))['polygon_xz']
    poly=[[v*scale for v in p] for p in poly]
    height=structure['wall_height']*scale
    items=[]
    if not isinstance(payload.get('items'),list) or len(payload['items'])>100: raise ValueError('最多放置 100 个物体')
    ids=set()
    for raw in payload['items']:
        ident=raw.get('id')
        if not isinstance(ident,str) or not re.fullmatch(r'[\w-]{1,80}',ident) or ident in ids: raise ValueError('物体实例编号无效')
        ids.add(ident)
        run=result_directory(root,raw['run_id']); asset=read_dimensions(run)
        if raw.get('source_key') != asset['base']['source_key']: raise ValueError('物体源模型已变化，请重新加入')
        cal=raw.get('calibration') or {}
        axis=cal.get('axis')
        if axis not in ('X','Y','Z'): raise ValueError('物体需要先标定尺寸')
        meters=positive(cal.get('meters'),'物体实测长度')
        base=asset['base']; metric=meters/positive(base['lengths'][axis],'模型边长',1e-12)
        user_scale=positive(raw.get('user_scale'), '手动缩放',.01,100)
        size=[(b-a)*metric*user_scale for a,b in zip(base['bounds']['min'],base['bounds']['max'])]
        item=dict(id=ident,run_id=run.name,source_key=base['source_key'],calibration=dict(axis=axis,meters=meters),metric_scale=metric,user_scale=user_scale,
                  x=finite(raw.get('x')),z=finite(raw.get('z')),yaw=finite(raw.get('yaw')),elevation=finite(raw.get('elevation',0)),size=size,base=base)
        if item['elevation'] < 0: raise ValueError('物体不能穿过地板')
        items.append(item)
    from layout_collision import check, settle_on_surface
    placement=payload.get('placement')
    if placement is not None:
        if not isinstance(placement,dict): raise ValueError('放置目标格式错误')
        settle_on_surface(root,items,placement.get('item_id'),placement.get('support_id'))
    if any(i['size'][1]+i['elevation']>height+1e-6 for i in items): raise ValueError('物体超出房间层高')
    warnings=check(root,room_root(root)/ROOMS[r['id']][0]/'empty_room.glb',structure,scale,items) if items else []
    return dict(schema_version=1,room_id=r['id'],room_version=r['version'],room_calibration=calibration,room_scale=scale,items=items,warnings=warnings)

class LayoutsMiddleware:
    def __init__(self,app,root): self.app,self.root=app,Path(root)
    async def __call__(self,scope,receive,send):
        prefix='/viewforge/layouts/'
        if scope['type']!='http' or not scope['path'].startswith(prefix): return await self.app(scope,receive,send)
        from starlette.requests import Request
        from starlette.responses import JSONResponse,FileResponse,RedirectResponse
        from starlette.concurrency import run_in_threadpool
        from urllib.parse import urlsplit
        req=Request(scope,receive); route=scope['path'][len(prefix):]
        directory=self.root/'data/layouts'; directory.mkdir(parents=True,exist_ok=True)
        try:
            if req.method=='GET' and route=='viewer':
                from urllib.parse import quote
                target='/gradio_api/file='+quote(str(Path(__file__).parent/'assets/room-layout.html'),safe='/')
                response=RedirectResponse(target+('?' + req.url.query if req.url.query else ''))
            elif req.method=='GET' and route=='catalog':
                rooms=[]
                for name in ROOMS:
                    try: rooms.append(room(self.root,name))
                    except FileNotFoundError: pass
                runs=[p.name for p in sorted((self.root/'runs').iterdir(),reverse=True) if (p/'reconstruction/result.glb').is_file()]
                layouts=[p.stem for p in sorted(directory.glob('*.json'),reverse=True)]
                response=JSONResponse(dict(rooms=rooms,runs=runs,layouts=layouts))
            elif req.method=='GET' and route.startswith('rooms/') and route.endswith('.glb'):
                name=route[6:-4]; room(self.root,name)
                response=FileResponse(room_root(self.root)/ROOMS[name][0]/'empty_room.glb',media_type='model/gltf-binary')
            elif req.method=='GET' and route.startswith('assets/'):
                parts=route.split('/'); run=result_directory(self.root,parts[1])
                if len(parts)==3 and parts[2] in ('preview.glb','result.glb'):
                    file=run/'reconstruction'/parts[2]
                    if not file.is_file(): raise FileNotFoundError('没有轻量预览')
                    response=FileResponse(file,media_type='model/gltf-binary')
                elif len(parts)==2:
                    from urllib.parse import quote
                    data=await run_in_threadpool(read_dimensions,run)
                    manifest=run/'cover/preview.json'
                    if manifest.is_file():
                        viewer='/gradio_api/file='+quote(str(Path(__file__).parent/'assets/cover-viewer.html'),safe='/')
                        data['viewer_url']=viewer+'?manifest='+quote('/gradio_api/file='+str(manifest),safe='')
                    response=JSONResponse(data)
                else: raise ValueError('无效资产地址')
            elif req.method=='POST' and route in ('save','validate'):
                origin=req.headers.get('origin')
                if origin and urlsplit(origin).netloc!=req.headers.get('host'): raise ValueError('请在当前页面保存')
                if req.headers.get('content-type','').split(';')[0]!='application/json': raise ValueError('需要 JSON')
                body=await req.body()
                if len(body)>300000: raise ValueError('布局过大')
                payload=json.loads(body)
                if not isinstance(payload,dict): raise ValueError('布局格式错误')
                result=await run_in_threadpool(validate_layout,self.root,payload)
                ident=uuid.uuid4().hex
                if route=='save': await run_in_threadpool(atomic_json,directory/f'{ident}.json',result)
                response=JSONResponse(dict(id=ident,layout=result))
            elif req.method=='GET' and re.fullmatch(r'[a-f0-9]{32}',route):
                response=JSONResponse(json.loads((directory/f'{route}.json').read_text()))
            else:
                response=JSONResponse(dict(error='接口不存在'),status_code=404)
        except FileNotFoundError as exc: response=JSONResponse(dict(error=str(exc)),status_code=404)
        except (ValueError,KeyError,TypeError,IndexError,AttributeError) as exc: response=JSONResponse(dict(error=str(exc)),status_code=400)
        response.headers['Cache-Control']='no-store'
        await response(scope,receive,send)
