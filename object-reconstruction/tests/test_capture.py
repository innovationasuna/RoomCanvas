import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from import_photos import import_photos, parent_selection
import run


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.obj = self.root/'data/inputs/toy'
        (self.obj/'images').mkdir(parents=True)
        (self.obj/'masks').mkdir()

    def photo(self, name):
        Image.new('RGB',(8,6)).save(self.obj/'images'/f'{name}.png')
        Image.new('RGBA',(8,6),(0,0,0,255)).save(self.obj/'masks'/f'{name}.png')

    def test_original_exif_and_duplicate_names(self):
        source = self.root/'phone.JPG'
        exif = Image.Exif(); exif[274] = 6
        Image.new('RGB',(8,6)).save(source, exif=exif)
        before = source.read_bytes()
        rows = import_photos(self.root, 'toy', [source,source])['images']
        self.assertEqual(len(rows),2)
        self.assertNotEqual(rows[0]['name'],rows[1]['name'])
        for row in rows:
            self.assertEqual(Path(row['original']).read_bytes(),before)
            with Image.open(row['image']) as image:
                self.assertEqual(image.size,(6,8))
                self.assertNotIn(274,image.getexif())

    def test_bad_image_is_not_published(self):
        bad = self.root/'bad.png';bad.write_text('not image')
        result = import_photos(self.root, 'toy', [bad])
        self.assertEqual(len(result['errors']),1)
        self.assertEqual(list((self.obj/'images').iterdir()),[])

    def test_parent_order_aliases_and_lineage(self):
        for name in ['1','3','new']:self.photo(name)
        parent = self.root/'runs/old';(parent/'reconstruction').mkdir(parents=True)
        (parent/'reconstruction/result.glb').touch()
        (parent/'inputs.json').write_text(json.dumps(dict(input_dir=str(self.obj),images=[dict(name='3'),dict(name='1')])))
        (parent/'cover').mkdir()
        (parent/'cover/result.json').write_text(json.dumps({'best':{'id':'candidate-2'}}))
        child = self.root/'runs/child';child.mkdir()
        manifest = run.stage_inputs(self.root,child,'toy',run.input_manifest(self.root,'toy',['new','1','3']),'old')
        self.assertEqual([r['source_name'] for r in manifest['images']],['3','1','new'])
        self.assertEqual([r['name'] for r in manifest['images']],['000001','000002','000003'])
        self.assertEqual(manifest['new_image_ids'],['new'])
        self.assertEqual(manifest['trigger_recommendation_id'],'candidate-2')
        (child/'inputs.json').write_text(json.dumps(manifest))
        (child/'reconstruction').mkdir();(child/'reconstruction/result.glb').touch()
        self.assertEqual(parent_selection(self.root,'child'),('toy',['3','1','new']))
        self.assertEqual(Path(manifest['images'][0]['image']).resolve(),(self.obj/'images/3.png').resolve())

    def test_parent_cannot_drop_anchor(self):
        for name in ['1','3']:self.photo(name)
        parent=self.root/'runs/old';(parent/'reconstruction').mkdir(parents=True)
        (parent/'reconstruction/result.glb').touch()
        (parent/'inputs.json').write_text(json.dumps(dict(input_dir=str(self.obj),images=[dict(name='1'),dict(name='3')])))
        with self.assertRaises(ValueError):
            run.stage_inputs(self.root,self.root/'runs/new','toy',run.input_manifest(self.root,'toy',['3']),'old')

    def test_cover_failure_keeps_completed_reconstruction(self):
        directory=self.root/'runs/run';(directory/'logs').mkdir(parents=True)
        result=dict(status='complete',mesh='reconstruction/result.glb')
        with patch.object(run.subprocess,'run',side_effect=RuntimeError('failed')):
            run.execute_cover(directory,result)
        self.assertEqual(result['status'],'complete')
        self.assertEqual(result['cover_status'],'failed')

if __name__=='__main__':unittest.main()
