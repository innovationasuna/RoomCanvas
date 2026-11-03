"""Assemble real-GLB material trial renders; never synthesizes object imagery."""
import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--stage', choices=('manual', 'estimated'), required=True)
    parser.add_argument('--font', default='/System/Library/Fonts/Hiragino Sans GB.ttc')
    args = parser.parse_args()
    root, output = args.root.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    def text(draw, xy, value, size=24):
        draw.text(xy, value, font=ImageFont.truetype(args.font, size), fill='#26343e')
    def paste(canvas, path, box, crop=None):
        with Image.open(path) as image:
            picture = image.convert('RGB')
            if crop:
                picture = picture.crop(crop)
            picture = ImageOps.contain(picture, box[2:], Image.Resampling.LANCZOS)
            canvas.paste(picture, (box[0]+(box[2]-picture.width)//2, box[1]+(box[3]-picture.height)//2))
    if args.stage == 'manual':
        kinds = ['baseline', 'manual_roughness', 'procedural_normal', 'manual_combined']
        labels = ['原烘焙 · 固定参数', '人工分区粗糙度', '示意织纹法线', '人工粗糙度＋示意法线']
        title = '固定 MV 几何：分区属性与示意法线对照'
        subtitle = '原颜色贴图和网格不变；参数为人工指定，法线为程序化示意，不代表真实材质恢复'
        filename = '01_人工分区与示意法线.png'
    else:
        kinds = ['baseline', 'manual_roughness', 'estimated_roughness', 'estimated_mr']
        labels = ['原烘焙 · 固定参数', '人工分区粗糙度', '自动粗糙度 · 非金属', '自动粗糙度＋金属度']
        title = '固定 MV 几何：自动材质属性是否更好'
        subtitle = '原颜色贴图、UV 和网格不变；只改变材质属性，模型估计不等于实物真值'
        filename = '02_自动粗糙度与金属度.png'
    rows = [('plush', '玩偶', 'front', (120, 140, 680, 670)),
            ('sofa', '沙发', 'oblique', (80, 180, 730, 650))]
    def figure(detail=False):
        canvas = Image.new('RGB', (1800, 1240), '#f5f5f1')
        draw = ImageDraw.Draw(canvas)
        text(draw, (30, 20), title + (' · 局部细节' if detail else ''), 35)
        text(draw, (30, 77), subtitle, 21)
        for col, label in enumerate(labels):
            text(draw, (30+col*440, 123), label, 24)
        for row, (profile, label, view, crop) in enumerate(rows):
            y = 178+row*480
            text(draw, (30, y), label, 25)
            for col, kind in enumerate(kinds):
                path = root/'renders'/args.stage/profile/f'{kind}-{"detail" if detail else view}.png'
                paste(canvas, path, (30+col*440, y+40, 425, 390),
                      (90, 90, 710, 710) if detail else crop)
        if args.stage == 'manual':
            text(draw, (30, 1150), '全部按非金属布料假设处理；金色区域不因此设成金属。示意法线可能产生重复纹理。', 22)
        else:
            text(draw, (30, 1150), '第 3 列将金属度固定为 0；第 4 列保留模型估计。颜色变化对照单独保存，不混入本图。', 22)
        text(draw, (30, 1190), '真实 GLB 浏览器渲染；保持几何不等于材质更准确，需观察移动光源与参考实物。', 22)
        return canvas
    figure().save(output/filename)
    figure(detail=True).save(output/('03_人工局部细节.png' if args.stage == 'manual' else '04_自动材质局部细节.png'))

    # Four columns: each method pair is lit from the left and right, without environment light.
    selected = ['baseline', 'manual_combined'] if args.stage == 'manual' else ['baseline', 'estimated_mr']
    canvas = Image.new('RGB', (1600, 1130), '#f5f5f1')
    draw = ImageDraw.Draw(canvas)
    text(draw, (30, 20), '移动光源：原烘焙与'+('人工分区＋示意法线' if args.stage == 'manual' else '自动材质属性'), 34)
    text(draw, (30, 76), '模型、相机固定；每组为左侧光／右侧光，关闭环境贴图', 23)
    for col, label in enumerate(['原烘焙 · 左侧光', '原烘焙 · 右侧光', '属性增强 · 左侧光', '属性增强 · 右侧光']):
        text(draw, (30+col*390, 125), label, 24)
    for row, (profile, label, _, _) in enumerate(rows):
        y = 180+row*410
        text(draw, (30, y), label, 25)
        for group, kind in enumerate(selected):
            for side, light in enumerate(['light_left', 'light_right']):
                paste(canvas, root/'renders'/args.stage/profile/f'{kind}-{light}.png',
                      (30+(group*2+side)*390, y+38, 375, 330), (80, 120, 740, 680))
    text(draw, (30, 1040), '受光变化用于验证材质通道；不是质量分数，也不证明已去除颜色中的固定明暗。', 22)
    canvas.save(output/('05_人工属性移动光源.png' if args.stage == 'manual' else '06_自动属性移动光源.png'))
    if args.stage == 'estimated':
        # Changing base colour is an independent experiment, keeping the MR estimate identical.
        canvas = Image.new('RGB', (1280, 1270), '#f5f5f1')
        draw = ImageDraw.Draw(canvas)
        text(draw, (28, 22), '颜色对照：相同自动 MR，是否替换基础色', 34)
        text(draw, (28, 80), '左边保留 MV 烘焙颜色，右边改用材质模型生成的基础色；两边几何相同', 21)
        for col, label in enumerate(['MV 颜色＋自动材质属性', '模型基础色＋自动材质属性']):
            text(draw, (28+col*620, 128), label, 27)
        for row, (profile, label, view, crop) in enumerate(rows):
            y = 185+row*470
            text(draw, (28, y), label, 25)
            for col, kind in enumerate(['estimated_mr', 'estimated_full']):
                paste(canvas, root/'renders'/args.stage/profile/f'{kind}-{view}.png',
                      (28+col*620, y+35, 600, 395), crop)
        text(draw, (28, 1175), '更换基础色可能改变图案及固定明暗，不能将其收益归到粗糙度／金属度。', 22)
        canvas.save(output/'07_基础色独立对照.png')
    print(output/filename)


if __name__ == '__main__':
    main()
