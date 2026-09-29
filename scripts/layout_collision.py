"""Full triangle-mesh collision: preserves table undersides and concave cavities."""
from functools import lru_cache
import threading
import numpy as np
import trimesh
import fcl

# trimesh lazy caches and FCL models are protected across ASGI worker threads.
LOCK = threading.RLock()

@lru_cache(maxsize=12)
def load_mesh(path, version, transform):
    scene=trimesh.load_scene(path,process=False)
    meshes=[]
    for node in scene.graph.nodes_geometry:
        matrix,name=scene.graph[node]
        mesh=scene.geometry[name].copy()
        mesh.apply_transform(np.array(transform).reshape(4,4,order='F') @ matrix)
        meshes.append(mesh)
    mesh=trimesh.util.concatenate(meshes)
    mesh.merge_vertices()
    components=mesh.split(only_watertight=False)
    representatives=np.array([m.vertices[0] for m in components if len(m.vertices)])
    return mesh, representatives, ([mesh] if len(components)==1 and mesh.is_watertight else [m for m in components if m.is_watertight])

@lru_cache(maxsize=24)
def model(path,version,transform,scale,center):
    mesh,reps,solids=load_mesh(path,version,transform)
    vertices=(mesh.vertices-np.array(center))*scale
    bvh=fcl.BVHModel(); bvh.beginModel(len(vertices),len(mesh.faces)); bvh.addSubModel(vertices,mesh.faces); bvh.endModel()
    return bvh

def world_instance(path,base,scale,x,z,yaw,floor):
    center=(np.array(base['bounds']['min'])+base['bounds']['max'])/2
    center[1]=base['bounds']['min'][1]
    transform=tuple(base['transform']); version=base['source_key']
    mesh,reps,solids=load_mesh(str(path),version,transform)
    c,s=np.cos(yaw),np.sin(yaw)
    rotation=np.array([[c,0,s],[0,1,0],[-s,0,c]])
    translation=np.array([x,floor,z])
    matrix=np.eye(4); matrix[:3,:3]=rotation*scale; matrix[:3,3]=translation-rotation@(center*scale)
    obj=fcl.CollisionObject(model(str(path),version,transform,scale,tuple(center)),fcl.Transform(rotation,translation))
    return dict(obj=obj,mesh=mesh,reps=reps,solids=solids,matrix=matrix,
                vertices=trimesh.transform_points(mesh.vertices,matrix))

def intersects(a,b):
    va,vb=a['vertices'],b['vertices']
    if np.any(np.minimum(va.max(0),vb.max(0))-np.maximum(va.min(0),vb.min(0)) < -1e-7): return False
    if fcl.collide(a['obj'],b['obj'],fcl.CollisionRequest(),fcl.CollisionResult()): return True
    # Triangle intersection alone misses one closed component wholly inside another.
    for outer,inner in ((a,b),(b,a)):
        points=trimesh.transform_points(inner['reps'],np.linalg.inv(outer['matrix']) @ inner['matrix'])
        for solid in outer['solids']:
            in_bounds=np.all((points>solid.bounds[0]) & (points<solid.bounds[1]),axis=1)
            if in_bounds.any() and solid.contains(points[in_bounds]).any(): return True
    return False

def all_inside(points,polygon):
    x,z=points[:,0],points[:,2]; inside=np.zeros(len(points),dtype=bool); boundary=inside.copy()
    for a,b in zip(polygon,polygon[1:]+polygon[:1]):
        dx,dz=b[0]-a[0],b[1]-a[1]
        boundary |= (abs(dx*(z-a[1])-dz*(x-a[0]))<1e-7)&(x>=min(a[0],b[0])-1e-7)&(x<=max(a[0],b[0])+1e-7)&(z>=min(a[1],b[1])-1e-7)&(z<=max(a[1],b[1])+1e-7)
        if abs(dz)>1e-12: inside ^= ((a[1]>z)!=(b[1]>z)) & (x < dx*(z-a[1])/dz+a[0])
    return bool(np.all(inside|boundary))

def check(root,room_path,structure,scale,items):
    with LOCK:
        floor=structure['floor_z']*scale
        poly=[[v*scale for v in p] for p in next(iter(structure['floor'].values()))['polygon_xz']]
        instances=[]; warnings=[]
        # Keep actual wall holes, exclude floor/ceiling contact planes; height is checked separately.
        scene=trimesh.load_scene(room_path,process=False)
        walls=[]
        for node in scene.graph.nodes_geometry:
            matrix,name=scene.graph[node]
            if 'wall' not in str(node).lower() and 'wall' not in str(name).lower(): continue
            mesh=scene.geometry[name].copy(); mesh.apply_transform(matrix); mesh.apply_scale(scale)
            bvh=fcl.BVHModel(); bvh.beginModel(len(mesh.vertices),len(mesh.faces)); bvh.addSubModel(mesh.vertices,mesh.faces); bvh.endModel()
            walls.append(dict(obj=fcl.CollisionObject(bvh),vertices=mesh.vertices,mesh=mesh,reps=mesh.vertices[:1],solids=[mesh] if mesh.is_watertight else [],matrix=np.eye(4)))
        if not walls: raise ValueError('房间 GLB 缺少可识别的墙体，无法验证碰撞')
        for item in items:
            instance=world_instance(root/'runs'/item['run_id']/'reconstruction/result.glb',item['base'],item['metric_scale']*item['user_scale'],item['x'],item['z'],item['yaw'],floor+item['elevation'])
            if not all_inside(instance['vertices'],poly): raise ValueError('物体超出地板边界')
            if any(intersects(instance,w) for w in walls): raise ValueError('物体与墙体发生碰撞')
            if any(intersects(instance,other) for other in instances): raise ValueError('物体之间发生网格碰撞')
            if not instance['mesh'].is_watertight: warnings.append(f"{item['run_id']} 网格未封闭：已检测表面穿插，内部包含检测仅覆盖封闭部分")
            instances.append(instance)
        return list(dict.fromkeys(warnings))


@lru_cache(maxsize=12)
def vertical_surface(path, version, transform):
    # All layout rotations are yaw-only, so vertical rays remain vertical in
    # calibrated mesh coordinates. A 2D triangle index avoids rebuilding a
    # heavyweight world-space ray index on every drag.
    from scipy.spatial import cKDTree
    mesh,_,_=load_mesh(path,version,transform)
    triangles=mesh.triangles
    center=triangles[:,:,[0,2]].mean(axis=1)
    radius=np.linalg.norm(triangles[:,:,[0,2]]-center[:,None,:],axis=2).max(axis=1)
    return triangles,cKDTree(center),float(radius.max())+1e-9


def vertical_heights(root, item, world_points, elevation, upward):
    path=str(root/'runs'/item['run_id']/'reconstruction/result.glb')
    triangles,tree,radius=vertical_surface(path,item['base']['source_key'],tuple(item['base']['transform']))
    scale=item['metric_scale']*item['user_scale']
    center=(np.array(item['base']['bounds']['min'])+item['base']['bounds']['max'])/2
    center[1]=item['base']['bounds']['min'][1]
    c,s=np.cos(item['yaw']),np.sin(item['yaw'])
    points=(world_points-np.array([item['x'],item['z']])) @ np.array([[c,s],[-s,c]])/scale+center[[0,2]]
    result=np.full(len(points),np.inf if upward else -np.inf)
    for index,candidates in enumerate(tree.query_ball_point(points,radius)):
        if not candidates: continue
        tri=triangles[candidates]
        a=tri[:,0,:][:,[0,2]];u=tri[:,1,:][:,[0,2]]-a;v=tri[:,2,:][:,[0,2]]-a;p=points[index]-a
        determinant=u[:,0]*v[:,1]-u[:,1]*v[:,0]
        valid=abs(determinant)>1e-16
        divisor=np.where(valid,determinant,1.)
        b=(p[:,0]*v[:,1]-p[:,1]*v[:,0])/divisor
        d=(u[:,0]*p[:,1]-u[:,1]*p[:,0])/divisor
        valid &= (b>=-1e-9)&(d>=-1e-9)&(b+d<=1+1e-9)
        if not valid.any(): continue
        heights=tri[:,0,1]+b*(tri[:,1,1]-tri[:,0,1])+d*(tri[:,2,1]-tri[:,0,1])
        value=np.min(heights[valid]) if upward else np.max(heights[valid])
        result[index]=(value-center[1])*scale+elevation
    return result


def settle_on_surface(root, items, item_id, support_id):
    """Find a full-mesh vertical contact pose, with 2 mm clearance for FCL.

    Samples use both meshes' real surfaces, never the support's bounding-box top.
    A final full-mesh collision check/refinement covers unsampled surface details.
    This places an object; it does not simulate gravity or stability.
    """
    with LOCK:
        item=next((i for i in items if i['id']==item_id),None)
        if item is None: raise ValueError('找不到待放置物体')
        if support_id is None:
            item['elevation']=0.
            return
        support=next((i for i in items if i['id']==support_id),None)
        if support is None or support is item: raise ValueError('请选择另一个物体作为承托表面')
        def instance(i, elevation):
            return world_instance(root/'runs'/i['run_id']/'reconstruction/result.glb',i['base'],i['metric_scale']*i['user_scale'],i['x'],i['z'],i['yaw'],elevation)
        moving=instance(item,0.)
        fixed=instance(support,support['elevation'])
        low=np.maximum(moving['vertices'].min(0),fixed['vertices'].min(0))
        high=np.minimum(moving['vertices'].max(0),fixed['vertices'].max(0))
        if high[0]<=low[0] or high[2]<=low[2]: raise ValueError('物体没有位于所选承托表面上方')
        grids=np.meshgrid(np.linspace(low[0]+1e-7,high[0]-1e-7,15),np.linspace(low[2]+1e-7,high[2]-1e-7,15))
        points=np.column_stack([grids[0].ravel(),grids[1].ravel()])
        for obj in (moving,fixed):
            vertices=obj['vertices'][::max(1,len(obj['vertices'])//256),:][:,[0,2]]
            points=np.vstack([points,vertices])
        points=np.vstack([[[item['x'],item['z']]],points])
        bottom=vertical_heights(root,item,points,0.,True)
        top=vertical_heights(root,support,points,support['elevation'],False)
        valid=np.isfinite(bottom)&np.isfinite(top)
        if not valid.any() or not np.isfinite(top[0]): raise ValueError('目标中心下方没有承托表面，请向表面内部移动')
        elevation=max(0.,float(np.max(top[valid]-bottom[valid])))+.002
        # Python-FCL keeps the reusable geometry in our bounded model cache.
        def collides(value):
            moved=instance(item,value)
            return intersects(moved,fixed)
        if collides(elevation):
            upper=float(fixed['vertices'][:,1].max())+.002
            lower=elevation
            if collides(upper): raise ValueError('未找到无碰撞的承托位置')
            for _ in range(16):
                middle=(lower+upper)/2
                if collides(middle): lower=middle
                else: upper=middle
            elevation=upper+.002
        item['elevation']=elevation
