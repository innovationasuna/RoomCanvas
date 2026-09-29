"""Full-mesh room layout regressions, including overlapping bounds but open cavities."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
import trimesh
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.testclient import TestClient
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from layouts import validate_layout, LayoutsMiddleware
from dimensions import read_dimensions


def box(size,center):
    m=trimesh.creation.box(size);m.apply_translation(center);return m

class LayoutTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.rooms=self.root/'rooms';p=self.rooms/'route1_office_room_v1';p.mkdir(parents=True)
        self.env=patch.dict(os.environ,{'VIEWFORGE_ROOMS_ROOT':str(self.rooms)});self.env.start()
        structure=dict(meta=dict(units='meter'),floor_z=0,wall_height=3,walls={'Wall0':{'length':10}},floor={'Floor0':{'polygon_xz':[[-5,-5],[5,-5],[5,5],[-5,5]],'area_m2':100}})
        (p/'room_structure.json').write_text(json.dumps(structure))
        scene=trimesh.Scene()
        for i,(size,pos) in enumerate([([.1,3,10],[-5.05,1.5,0]),([.1,3,10],[5.05,1.5,0]),([10,3,.1],[0,1.5,-5.05]),([10,3,.1],[0,1.5,5.05])]):scene.add_geometry(box(size,pos),node_name=f'Wall{i}')
        scene.export(p/'empty_room.glb')
        table=trimesh.util.concatenate([box([2,.1,2],[0,.95,0])]+[box([.1,.9,.1],[x,.45,z]) for x in [-.95,.95] for z in [-.95,.95]])
        self.table=self.asset('table',table,1)
        self.chair=self.asset('chair',box([.4,.5,.4],[0,.25,0]),.5)
        self.cube=self.asset('cube',box([2,2,2],[0,1,0]),2)
        self.client=TestClient(Starlette(middleware=[Middleware(LayoutsMiddleware,root=self.root)]))
    def tearDown(self):self.env.stop();self.temp.cleanup()
    def asset(self,name,mesh,height):
        run=self.root/'runs'/name;(run/'reconstruction').mkdir(parents=True);mesh.export(run/'reconstruction/result.glb')
        data=read_dimensions(run)
        return dict(id=name,run_id=name,source_key=data['base']['source_key'],calibration=dict(axis='Z',meters=height),user_scale=1,x=0,z=0,yaw=0)
    def layout(self,items,**kw):return dict(room_id='office',room_calibration=None,items=items,**kw)
    def test_chair_under_table_allowed(self):
        result=validate_layout(self.root,self.layout([self.table,self.chair]));self.assertEqual(len(result['items']),2)
    def test_scaled_chair_hits_tabletop(self):
        with self.assertRaisesRegex(ValueError,'碰撞'):validate_layout(self.root,self.layout([self.table,dict(self.chair,user_scale=2)]))
    def test_leg_collision_rejected(self):
        with self.assertRaisesRegex(ValueError,'碰撞'):validate_layout(self.root,self.layout([self.table,dict(self.chair,x=.95,z=.95)]))
    def test_wholly_contained_mesh_rejected(self):
        with self.assertRaisesRegex(ValueError,'碰撞'):validate_layout(self.root,self.layout([self.cube,self.chair]))
    def test_room_boundary_and_ceiling(self):
        for change in [dict(x=5),dict(user_scale=7)]:
            with self.assertRaises(ValueError):validate_layout(self.root,self.layout([dict(self.chair,**change)]))
    def test_rotated_and_negative_origin(self):
        result=validate_layout(self.root,self.layout([dict(self.chair,x=-2,z=-2,yaw=.83)]));self.assertAlmostEqual(result['items'][0]['size'][1],.5)
    def test_room_measurement_and_object_scale_are_independent(self):
        data=self.layout([dict(self.chair,user_scale=1.5)]);data['room_calibration']={'wall':'Wall0','meters':20}
        result=validate_layout(self.root,data);self.assertEqual(result['room_scale'],2);self.assertAlmostEqual(result['items'][0]['size'][1],.75)
    def test_elevation_preserves_void_and_blocks_surface(self):
        validate_layout(self.root,self.layout([self.table,dict(self.chair,elevation=.1)]))
        with self.assertRaisesRegex(ValueError,'碰撞'):
            validate_layout(self.root,self.layout([self.table,dict(self.chair,elevation=.5)]))
        validate_layout(self.root,self.layout([self.table,dict(self.chair,elevation=1.01)]))
        for height in [-.01,2.6]:
            with self.assertRaises(ValueError):validate_layout(self.root,self.layout([dict(self.chair,elevation=height)]))
    def test_auto_place_on_table_and_return_to_floor(self):
        data=self.layout([self.table,self.chair]);data['placement']={'item_id':'chair','support_id':'table'}
        result=validate_layout(self.root,data)
        self.assertAlmostEqual(result['items'][1]['elevation'],1.002,places=3)
        result['items'][1]['x']=3
        result['placement']={'item_id':'chair','support_id':None}
        again=validate_layout(self.root,result)
        self.assertEqual(again['items'][1]['elevation'],0)
    def test_auto_place_uses_seat_not_sofa_bounding_box_top(self):
        sofa=trimesh.util.concatenate([box([2,.5,2],[0,.25,0]),box([2,.7,.2],[0,.85,.9])])
        seat=self.asset('sofa',sofa,1.2)
        data=self.layout([seat,dict(self.chair,z=-.4)])
        data['placement']={'item_id':'chair','support_id':'sofa'}
        result=validate_layout(self.root,data)
        self.assertAlmostEqual(result['items'][1]['elevation'],.502,places=3)
        self.assertAlmostEqual(result['items'][1]['calibration']['meters'],.5)
        data['items']=[dict(seat,yaw=np.pi/2),dict(self.chair,x=-.4)]
        rotated=validate_layout(self.root,data)
        self.assertAlmostEqual(rotated['items'][1]['elevation'],.502,places=3)
    def test_auto_place_rejects_missing_support_and_ceiling(self):
        for support in ['chair','missing']:
            data=self.layout([self.table,self.chair]);data['placement']={'item_id':'chair','support_id':support}
            with self.assertRaises(ValueError):validate_layout(self.root,data)
        data=self.layout([dict(self.table,elevation=2),self.chair]);data['placement']={'item_id':'chair','support_id':'table'}
        with self.assertRaisesRegex(ValueError,'层高'):validate_layout(self.root,data)
        data=self.layout([self.table,dict(self.chair,x=4)]);data['placement']={'item_id':'chair','support_id':'table'}
        with self.assertRaises(ValueError):validate_layout(self.root,data)
    def test_invalid_and_stale_source(self):
        for change in [dict(user_scale=0),dict(x=float('nan')),dict(source_key='stale')]:
            with self.assertRaises(ValueError):validate_layout(self.root,self.layout([dict(self.chair,**change)]))
        with self.assertRaises(ValueError):validate_layout(self.root,self.layout([],room_version='stale'))
    def test_save_restore_and_conflicting_save(self):
        response=self.client.post('/viewforge/layouts/save',json=self.layout([self.table,self.chair]));self.assertEqual(response.status_code,200,response.text)
        ident=response.json()['id'];loaded=self.client.get('/viewforge/layouts/'+ident).json();self.assertEqual(loaded,response.json()['layout'])
        self.assertEqual(self.client.post('/viewforge/layouts/save',json=self.layout([self.cube,self.chair])).status_code,400)
        self.assertEqual(len(list((self.root/'data/layouts').glob('*.json'))),1)
    def test_api_assets_and_origin(self):
        self.assertEqual(self.client.get('/viewforge/layouts/rooms/office.glb').status_code,200)
        self.assertEqual(self.client.get('/viewforge/layouts/assets/chair/result.glb').status_code,200)
        self.assertEqual(self.client.post('/viewforge/layouts/save',json=self.layout([]),headers={'origin':'https://evil.invalid'}).status_code,400)
