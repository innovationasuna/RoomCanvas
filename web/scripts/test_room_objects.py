"""python3 -m unittest discover -s web/scripts"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from room_objects import build  # noqa: E402


def item(id, category, rests_on=None, attached_to=None, support_part=None, placeable=False,
         low=(0, 0, 0), high=(1, 1, 1)):
    return {'id': id, 'category': category, 'handle': id, 'bbox_min': list(low), 'bbox_max': list(high),
            'rests_on': rests_on, 'attached_to': attached_to, 'support_part': support_part,
            'placeable_surface': placeable}


def room(*extra):
    return {'scene': 'test_room', 'objects': [
        item('Floor0', 'floor'), item('Wall0', 'wall'), item('Wall1', 'wall'), item('Ceiling0', 'ceiling'),
        item('Door0', 'door', attached_to='Wall0'),
        item('Bed0', 'bed', rests_on='Floor0', low=(1, 2, -1.5), high=(3, 4, -1)),
        item('Sheet', 'textile', rests_on='Bed0', support_part='Mattress'),
        item('Pillow', 'pillow', rests_on='Sheet'),
        item('Shelf', 'shelf', attached_to='Wall1', placeable=True),
        item('Book', 'book', rests_on='Shelf'),
        item('Socket', 'socket', attached_to='Wall0'),
        item('Lamp', 'light', attached_to='Ceiling0'),
        item('Bulkhead', 'bulkhead', attached_to='Wall0'),
        item('Vent', 'vent', attached_to='Bulkhead'),
        *extra,
    ]}


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.result = build(room())
        self.objects = {record['id']: record for record in self.result['objects']}
        self.groups = {group['id']: group for group in self.result['groups']}

    def test_movable_groups_carry_what_rests_on_them(self):
        self.assertEqual(sorted(self.groups), ['Bed0', 'Shelf'])
        self.assertEqual(self.groups['Bed0']['members'], ['Bed0', 'Sheet', 'Pillow'])
        self.assertEqual(self.groups['Bed0']['mount'], 'floor')
        self.assertEqual(self.groups['Shelf']['members'], ['Shelf', 'Book'])
        self.assertEqual((self.groups['Shelf']['mount'], self.groups['Shelf']['wall']), ('wall', 'Wall1'))

    def test_support_parts_come_from_what_stands_on_them(self):
        self.assertEqual(self.groups['Bed0']['support_parts'], ['Mattress'])
        # Nothing names a part of the shelf, but it is a placeable surface itself.
        self.assertEqual(self.groups['Shelf']['support_parts'], ['Shelf'])

    def test_room_keeps_shell_openings_and_fixtures(self):
        roles = {id: self.objects[id]['role'] for id in ['Floor0', 'Wall0', 'Door0', 'Socket', 'Lamp', 'Bulkhead', 'Vent']}
        self.assertEqual(roles, {'Floor0': 'structure', 'Wall0': 'structure', 'Door0': 'opening',
                                 'Socket': 'fixture', 'Lamp': 'fixture', 'Bulkhead': 'structure', 'Vent': 'fixture'})
        self.assertEqual(self.result['openings'], {'Wall0': ['Door0']})
        self.assertEqual((self.result['floor'], self.result['walls'], self.result['ceiling']), ('Floor0', ['Wall0', 'Wall1'], ['Ceiling0']))

    def test_wall_is_found_through_shell_parts(self):
        self.assertEqual(self.objects['Vent']['wall'], 'Wall0')
        self.assertEqual(self.objects['Socket']['wall'], 'Wall0')
        self.assertIsNone(self.objects['Lamp']['wall'])
        self.assertEqual(self.objects['Lamp']['mount'], 'ceiling')

    def test_bounds_are_converted_to_y_up(self):
        self.assertEqual(self.objects['Bed0']['bbox_min'], [1, -1.5, -4])
        self.assertEqual(self.objects['Bed0']['bbox_max'], [3, -1, -2])
        self.assertEqual(self.result['frame']['up'], 'Y')

    def test_bad_relations_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'unknown object Nowhere'):
            build(room(item('Cup', 'cup', rests_on='Nowhere')))
        with self.assertRaisesRegex(ValueError, 'support cycle'):
            build(room(item('A', 'box', rests_on='B'), item('B', 'box', rests_on='A')))
        with self.assertRaisesRegex(ValueError, 'no node for: Bed0'):
            build(room(), node_names={record['id'] for record in room()['objects']} - {'Bed0'})


if __name__ == '__main__':
    unittest.main()
