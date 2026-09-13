"""Coordinate and preview adapters for MV-SAM3D -> COVER (column vectors)."""
from pathlib import Path
import json
from urllib.parse import quote
import numpy as np
from scipy.spatial.transform import Rotation

# Upstream mesh export: row_vertices @ A, hence column_vertices -> A.T.
CANONICAL_TO_GLB = np.array([[1.,0.,0.],[0.,0.,1.],[0.,-1.,0.]])


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False)+'\n')
    tmp.replace(path)


def file_url(path):
    return '/gradio_api/file=' + quote(str(Path(path).absolute()), safe='/')


def matrix_list(matrix):
    return np.asarray(matrix).reshape(4,4).flatten(order='F').tolist()


def quat_matrix(wxyz):
    q = np.asarray(wxyz, dtype=float).reshape(4)
    q /= np.linalg.norm(q)
    return Rotation.from_quat(q[[1,2,3,0]]).as_matrix()


def affine(linear, translation=None):
    out = np.eye(4)
    out[:3,:3] = linear
    if translation is not None:
        out[:3,3] = np.asarray(translation).reshape(3)
    return out


def look_at(position, target=(0.,0.,0.), up=(0.,1.,0.)):
    """OpenCV/gsplat w2c, +z forward, +y down."""
    pos, target, up = map(lambda x: np.asarray(x,dtype=float), (position,target,up))
    z = target-pos
    z /= np.linalg.norm(z)
    x = np.cross(z,up)
    x /= np.linalg.norm(x)
    y = np.cross(z,x)
    R = np.stack([x,y,z])
    return affine(R, -R@pos)


def camera_center(viewmat):
    return np.linalg.inv(viewmat)[:3,3]


def load_gaussians(path):
    from plyfile import PlyData
    p = PlyData.read(path)['vertex']
    means = np.stack([p[c] for c in ('x','y','z')],-1).astype(np.float32)
    scales = np.exp(np.stack([p[f'scale_{i}'] for i in range(3)],-1)).astype(np.float32)
    quats = np.stack([p[f'rot_{i}'] for i in range(4)],-1).astype(np.float32)
    quats /= np.linalg.norm(quats,axis=-1,keepdims=True)
    logits = np.asarray(p['opacity'],dtype=np.float32)
    opacities = 1. / (1.+np.exp(-np.clip(logits,-80,80)))
    colors = np.clip(.5+.28209479177387814*np.stack([p[f'f_dc_{i}'] for i in range(3)],-1),0,1)
    result=dict(means=means,scales=scales,quats=quats,opacities=opacities,colors=colors)
    if not all(np.isfinite(v).all() for v in result.values()):
        raise ValueError('Gaussian PLY contains non-finite parameters')
    return result


def transform_gaussians(gs, transform):
    A, t = transform[:3,:3], transform[:3,3]
    result = dict(gs)
    result['means'] = (gs['means']@A.T+t).astype(np.float32)
    rotations=Rotation.from_quat(gs['quats'][:,[1,2,3,0]]).as_matrix()
    lengths=np.linalg.norm(A,axis=0)
    if np.allclose(lengths,lengths[0],rtol=1e-6) and np.allclose(A.T@A,np.eye(3)*lengths[0]**2,atol=1e-6):
        rotations=np.einsum('ij,njk->nik',A/lengths[0],rotations)
        result['scales']=(gs['scales']*lengths[0]).astype(np.float32)
    else:
        L=np.einsum('ij,njk->nik',A,rotations*gs['scales'][:,None,:])
        cov=L@L.transpose(0,2,1)
        values,rotations=np.linalg.eigh(cov)
        rotations[:,:,0]*=np.linalg.det(rotations)[:,None]
        result['scales']=np.sqrt(np.maximum(values,1e-20)).astype(np.float32)
    result['quats']=Rotation.from_matrix(rotations).as_quat()[:,[3,0,1,2]].astype(np.float32)
    return result


def load_scene(run):
    run=Path(run)
    inputs=json.loads((run/'inputs.json').read_text())
    with np.load(run/'da3/da3_output.npz',allow_pickle=False) as d:
        E=np.array(d['extrinsics'],dtype=float)
        K=np.array(d['intrinsics'],dtype=float)
        image_names=[Path(str(p)).stem for p in d['image_files']]
        h,w=d['depth'].shape[-2:]
        process_res=int(d['process_res'])
    if E.shape[-2:]==(3,4):
        E=np.concatenate([E,np.broadcast_to([0,0,0,1],(len(E),1,4))],axis=1)
    with np.load(run/'reconstruction/params.npz',allow_pickle=False) as p:
        scale=np.asarray(p['scale'],dtype=float).reshape(-1)
        if len(scale)==1: scale=np.repeat(scale,3)
        if len(scale)!=3 or (scale<=0).any(): raise ValueError('Invalid object scale')
        R=quat_matrix(p['rotation'])
        t=np.asarray(p['translation'],dtype=float).reshape(3)
    # Upstream PyTorch3D Transform3d.scale().rotate(R).translate(t) uses row vectors.
    pose=affine(R.T@np.diag(scale),t)
    cv_from_p3d=affine(np.diag([-1.,-1.,1.]))
    canonical_to_world=np.linalg.inv(E[0])@cv_from_p3d@pose
    s=float(np.cbrt(np.prod(scale)))
    world_rotation=canonical_to_world[:3,:3]@np.diag(1/scale)
    U=CANONICAL_TO_GLB@world_rotation.T/s
    world_to_display=affine(U,-U@canonical_to_world[:3,3])
    gaussian_transform=world_to_display@canonical_to_world
    mesh_transform=gaussian_transform@affine(CANONICAL_TO_GLB.T)
    raw=load_gaussians(run/'reconstruction/result.ply')
    gs=transform_gaussians(raw,gaussian_transform)
    rows={r['name']:r for r in inputs['images']}
    if set(rows)!=set(image_names):
        raise ValueError('DA3 camera image IDs do not match this run input manifest')
    cameras=[]
    for i,name in enumerate(image_names):
        # Convert a similarity-transformed w2c back to rigid camera coordinates.
        v=E[i]@np.linalg.inv(world_to_display)
        v[:3,:]/=s
        if not np.allclose(v[:3,:3]@v[:3,:3].T,np.eye(3),atol=2e-3):
            raise ValueError('DA3 camera rotation is not orthonormal')
        cameras.append(dict(id=name,viewmat=v.astype(np.float32),K=K[i].astype(np.float32),width=w,height=h,image=rows[name]['image'],mask=rows[name]['mask']))
    # Canonical object centre, not the (possibly asymmetric) Gaussian centroid.
    center=np.zeros(3)
    keep=gs['opacities']>.05
    radius=float(np.quantile(np.linalg.norm(gs['means'][keep],axis=1),.995))
    return dict(run=run,gaussians=gs,observed=cameras,center=center,radius=radius,
                gaussian_transform=gaussian_transform,mesh_transform=mesh_transform,
                world_to_display=world_to_display,process_res=process_res)


def make_candidates(scene):
    obs=scene['observed']; center=scene['center']
    positions=np.array([camera_center(c['viewmat']) for c in obs])
    radius=float(np.median(np.linalg.norm(positions-center,axis=1)))
    if not np.isfinite(radius) or radius<=0: raise ValueError('Invalid camera distance')
    directions=(positions-center)/np.linalg.norm(positions-center,axis=1,keepdims=True)
    first=directions[0]
    az0=float(np.arctan2(first[0],first[2]))
    out=[]; excluded=[]
    for elevation in (0,20,40):
        el=np.deg2rad(elevation)
        for i in range(24):
            az=az0+2*np.pi*i/24
            d=np.array([np.cos(el)*np.sin(az),np.sin(el),np.cos(el)*np.cos(az)])
            ident=f'e{elevation:02d}_a{i*15:03d}'
            if float(np.max(directions@d))>np.cos(np.deg2rad(5)):
                excluded.append(dict(id=ident,reason='within_5_degrees_of_observed'))
                continue
            pos=center+radius*d
            out.append(dict(id=ident,viewmat=look_at(pos,center).astype(np.float32),K=obs[0]['K'],width=obs[0]['width'],height=obs[0]['height'],position=pos.tolist(),target=center.tolist(),up=[0.,1.,0.],azimuth_degrees=i*15,elevation_degrees=elevation))
    return out,excluded


def preview_manifest(run,scene=None,recommendation=None,message='尚未计算补拍建议'):
    run=Path(run)
    if scene is None:
        gt=affine(CANONICAL_TO_GLB); mt=np.eye(4); radius=.7
    else:
        gt=scene['gaussian_transform']; mt=scene['mesh_transform']; radius=scene['radius']
    return dict(schema_version=1,run_id=run.name,
        assets=dict(glb=dict(url=file_url(run/'reconstruction/result.glb'),transform=matrix_list(mt)),
                    gaussian=dict(url=file_url(run/'reconstruction/result.ply'),transform=matrix_list(gt))),
        display=dict(center=[0.,0.,0.],radius=radius,up=[0.,1.,0.]),
        recommendation=recommendation,status='complete' if recommendation else 'unavailable',message=message)


def ensure_preview(run):
    run=Path(run); path=run/'cover/preview.json'
    if path.is_file(): return path
    try: scene=load_scene(run)
    except Exception: scene=None
    write_json(path,preview_manifest(run,scene))
    return path


def image_for_camera(path,camera,process_res,mask=False):
    """DA3 upper_bound_resize -> nearest multiple of 14 -> batch centre crop."""
    from PIL import Image
    image=Image.open(path)
    image=image.getchannel('A') if mask else image.convert('RGB')
    ow,oh=image.size
    k=process_res/max(ow,oh)
    w,h=max(1,round(ow*k)),max(1,round(oh*k))
    def multiple(x):
        lo=(x//14)*14; hi=lo+14
        return max(1,hi if hi-x<=x-lo else lo)
    w,h=multiple(w),multiple(h)
    image=image.resize((w,h),Image.Resampling.NEAREST if mask else Image.Resampling.BILINEAR)
    tw,th=camera['width'],camera['height']
    left,top=(w-tw)//2,(h-th)//2
    if left<0 or top<0: raise ValueError('Unexpected DA3 image crop')
    return image.crop((left,top,left+tw,top+th))
