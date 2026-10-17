"""Score a completed MV-SAM3D run with the pinned COVER formula."""
import argparse
from contextlib import nullcontext
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import time
import numpy as np
from cover_scene import (load_scene,make_candidates,preview_manifest,write_json,image_for_camera)


def torch_gaussians(scene,device='cuda:0'):
    import torch
    return {k:torch.as_tensor(v,dtype=torch.float32,device=device) for k,v in scene['gaussians'].items()}


def projection_check(scene,gs,out):
    """Sanity check only; mask overlap is not a geometric-accuracy estimate."""
    import torch
    from gsplat import rasterization
    from PIL import Image,ImageDraw
    from scipy.ndimage import binary_erosion
    tiles=[]; records=[]
    for camera in scene['observed']:
        with torch.no_grad():
            rgb,alpha,_=rasterization(means=gs['means'],quats=gs['quats'],scales=gs['scales'],
                opacities=gs['opacities'],colors=gs['colors'],
                viewmats=torch.as_tensor(camera['viewmat'],device=gs['means'].device)[None],
                Ks=torch.as_tensor(camera['K'],device=gs['means'].device)[None],
                width=camera['width'],height=camera['height'],packed=False,sh_degree=None,
                render_mode='RGB',rasterize_mode='classic')
        a=alpha[0,...,0].detach().cpu().numpy(); rendered=rgb[0].detach().cpu().numpy()
        image=np.asarray(image_for_camera(camera['image'],camera,scene['process_res'])).copy()
        target=np.asarray(image_for_camera(camera['mask'],camera,scene['process_res'],mask=True))>0
        pred=a>.2
        inter=int((pred&target).sum()); union=int((pred|target).sum())
        iou=inter/union if union else 0.
        center_depth=float((camera['viewmat']@np.r_[scene['center'],1])[2])
        records.append(dict(id=camera['id'],mask_iou=iou,rendered_pixels=int(pred.sum()),target_pixels=int(target.sum()),center_in_front=center_depth>0))
        overlay=image.copy()
        overlay[target&~binary_erosion(target,iterations=2)]=[240,40,190]
        overlay[pred&~binary_erosion(pred,iterations=2)]=[0,235,150]
        composed=rendered+(1-a[...,None])*.94
        tile=Image.new('RGB',(camera['width']*2,camera['height']+26),'white')
        tile.paste(Image.fromarray(overlay),(0,26))
        tile.paste(Image.fromarray((np.clip(composed,0,1)*255).astype('uint8')),(camera['width'],26))
        ImageDraw.Draw(tile).text((6,5),f"View {camera['id']} | magenta: input mask; green: projected GS | IoU {iou:.3f}",fill='black')
        tiles.append(tile)
        print(f"PROJECTION {camera['id']} IoU={iou:.4f}",flush=True)
    contact=Image.new('RGB',(max(t.width for t in tiles),sum(t.height for t in tiles)),'white')
    y=0
    for t in tiles:contact.paste(t,(0,y));y+=t.height
    contact.save(out/'projection-contact.jpg',quality=90)
    # These deliberately coarse thresholds detect broken axes/pose, not reconstruction quality.
    passed=all(r['center_in_front'] and r['mask_iou']>=.10 for r in records) and float(np.median([r['mask_iou'] for r in records]))>=.25
    report=dict(status='passed' if passed else 'failed',purpose='coordinate_projection_sanity_only',
                thresholds=dict(min_view_mask_iou=.10,median_mask_iou=.25,center_in_front=True),views=records)
    write_json(out/'projection.json',report)
    return report


def run_cover(run,check_only=False,export_parity=False):
    from cover_core import score_cameras
    import torch
    started=time.monotonic(); run=Path(run).resolve(); directory=run/'cover'
    attempt=directory/'attempts'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S_%f')
    attempt.mkdir(parents=True,exist_ok=False)
    scene=None
    try:
        scene=load_scene(run)
        gs=torch_gaussians(scene)
        projection=projection_check(scene,gs,attempt)
        if projection['status']!='passed':
            raise ValueError('相机与模型投影检查未通过，暂不提供补拍方向；模型仍可预览')
        candidates,excluded=make_candidates(scene)
        if export_parity:
            pack={k:scene['gaussians'][k] for k in ('means','quats','scales','opacities')}
            for prefix,cams in [('observed',scene['observed']),('candidate',candidates[:3])]:
                pack[prefix+'_viewmats']=np.stack([c['viewmat'] for c in cams])
                pack[prefix+'_Ks']=np.stack([c['K'] for c in cams])
                pack[prefix+'_widths']=np.array([c['width'] for c in cams])
                pack[prefix+'_heights']=np.array([c['height'] for c in cams])
                pack[prefix+'_ids']=np.array([c['id'] for c in cams])
            np.savez(attempt/'parity-input.npz',**pack)
        if check_only:
            print(json.dumps(dict(status='projection_passed',attempt=str(attempt)),ensure_ascii=False),flush=True)
            return
        print(f'COVER scoring {len(candidates)} candidates, {len(gs["means"])} Gaussians',flush=True)
        with torch.no_grad():
            scores=score_cameras(gs,scene['observed'],candidates)
        valid=[r for r in scores['scores'] if r['valid']]
        if not valid:raise ValueError('当前候选视角均无有效物体投影，暂不提供补拍方向')
        best=min(valid,key=lambda r:r['raw_score']); cam=next(c for c in candidates if c['id']==best['id'])
        rec={k:cam[k] for k in ('id','position','target','up')}
        rec.update(score=best['raw_score'],fov_y=float(2*np.arctan(cam['height']/(2*cam['K'][1,1]))))
        result=dict(status='complete',run_id=run.name,method=scores['metadata'],
            projection=projection,excluded=excluded,scores=scores['scores'],best=rec,
            candidates=[{k:c[k] for k in ('id','position','target','up','azimuth_degrees','elevation_degrees')} for c in candidates],
            attempt=str(attempt.relative_to(run)),elapsed_seconds=time.monotonic()-started,
            scoring_resolution=[cam['width'],cam['height']],peak_allocated_gib=torch.cuda.max_memory_allocated()/2**30)
        write_json(attempt/'result.json',result);write_json(directory/'result.json',result)
        write_json(directory/'preview.json',preview_manifest(run,scene,rec,'建议从箭头所在方向补拍'))
        print(json.dumps(dict(status='complete',best=rec,elapsed_seconds=result['elapsed_seconds']),ensure_ascii=False),flush=True)
    except Exception as exc:
        result=dict(status='failed',run_id=run.name,error=str(exc),attempt=str(attempt.relative_to(run)))
        write_json(attempt/'result.json',result);write_json(directory/'result.json',result)
        write_json(directory/'preview.json',preview_manifest(run,scene,message=str(exc)))
        raise


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--run-dir',type=Path,required=True)
    p.add_argument('--lock-held',action='store_true')
    p.add_argument('--check-projection',action='store_true')
    p.add_argument('--export-parity-input',action='store_true')
    args=p.parse_args()
    if not os.environ.get('CUDA_VISIBLE_DEVICES') or ',' in os.environ['CUDA_VISIBLE_DEVICES']:
        raise ValueError('Set exactly one authorized GPU in CUDA_VISIBLE_DEVICES')
    lockpath=Path(os.environ.get('VIEWFORGE_GPU_LOCK',str(Path(os.environ['VIEWFORGE_ROOT'])/'cache/gpu.lock')))
    lockpath.parent.mkdir(parents=True,exist_ok=True)
    with (nullcontext() if args.lock_held else lockpath.open('a')) as lock:
        if lock is not None:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        run_cover(args.run_dir,args.check_projection,args.export_parity_input)

if __name__=='__main__':main()
