import type { Point } from '../../shared/types';
export const CATALOG: { id: string; label: string; category: string; path: string; position: Point; rotation: number; color: string }[] = [
  { id: 'sofa', label: '云杉沙发', category: 'SOFA / 01', path: '/models/furniture/sofa.glb', position: { x: 0, y: 0, z: -1.55 }, rotation: 0, color: '#a7b4a0' },
  { id: 'table', label: '橡木茶几', category: 'TABLE / 02', path: '/models/furniture/table.glb', position: { x: 0, y: 0, z: 0.15 }, rotation: 0, color: '#ae835b' },
  { id: 'chair', label: '阅读单椅', category: 'CHAIR / 03', path: '/models/furniture/chair.glb', position: { x: 1.65, y: 0, z: 0.8 }, rotation: -Math.PI / 6, color: '#eee8dc' },
];
