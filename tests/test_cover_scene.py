"""Verify coordinate conventions independently of a reconstruction's appearance."""
from pathlib import Path
import sys
import unittest
import numpy as np
from scipy.spatial.transform import Rotation
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from cover_scene import affine,look_at,camera_center,transform_gaussians,CANONICAL_TO_GLB,make_candidates

class Coordinates(unittest.TestCase):
    def test_look_at_projects_target_to_principal_point(self):
        for position in ([1.,0.,2.],[-1.,.5,-2.]):
            V=look_at(position)
            point=V@np.array([0.,0.,0.,1.])
            np.testing.assert_allclose(point[:2],0,atol=1e-14)
            self.assertGreater(point[2],0)
            np.testing.assert_allclose(camera_center(V),position,atol=1e-14)
            np.testing.assert_allclose(V[:3,:3]@V[:3,:3].T,np.eye(3),atol=1e-14)
    def test_gaussian_covariance_follows_nonuniform_affine(self):
        q=Rotation.from_euler('xyz',[.2,.7,-.3]).as_quat()[[3,0,1,2]][None]
        gs=dict(means=np.array([[.2,.4,.8]]),scales=np.array([[.03,.08,.1]]),quats=q,opacities=np.array([.7]))
        A=CANONICAL_TO_GLB@np.diag([2.,.7,1.3]);t=np.array([.4,-.3,.2])
        result=transform_gaussians(gs,affine(A,t))
        old=Rotation.from_quat(q[:,[1,2,3,0]]).as_matrix()[0]
        new=Rotation.from_quat(result['quats'][:,[1,2,3,0]]).as_matrix()[0]
        cov0=old@np.diag(gs['scales'][0]**2)@old.T
        cov1=new@np.diag(result['scales'][0]**2)@new.T
        np.testing.assert_allclose(cov1,A@cov0@A.T,rtol=1e-5,atol=1e-8)
        np.testing.assert_allclose(result['means'][0],A@gs['means'][0]+t,atol=1e-7)
        np.testing.assert_array_equal(result['opacities'],gs['opacities'])
    def test_mesh_export_rotation_and_candidate_exclusion(self):
        # Export maps canonical +z to GLB +y; no second mesh rotation.
        np.testing.assert_array_equal(CANONICAL_TO_GLB@np.array([0,0,1]),[0,1,0])
        cam=dict(id='a',viewmat=look_at([0,0,2]),K=np.eye(3),width=504,height=378)
        candidates,excluded=make_candidates(dict(observed=[cam],center=np.zeros(3)))
        self.assertEqual(len(candidates)+len(excluded),72)
        self.assertEqual(excluded,[dict(id='e00_a000',reason='within_5_degrees_of_observed')])
        for c in candidates:
            self.assertAlmostEqual(np.linalg.norm(c['position']),2.)
            np.testing.assert_allclose((c['viewmat']@np.r_[np.zeros(3),1])[:2],0,atol=1e-6)

if __name__=='__main__':unittest.main()
