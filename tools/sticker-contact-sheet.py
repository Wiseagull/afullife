#!/usr/bin/env python
"""把表情库拼成带编号的联络表，一张 read_image 就能整批看。

为什么要有：read_image 一次只能看一张，299 个表情逐个看是浪费。
拼成 9x9 的格子后，每格角上印 id 后三位，看完照着编号回填 tags。
（2026-10-24 的手工版就是 tmp/sheet.py，这版加了参数。）

用法：
  python tools/sticker-contact-sheet.py                      # 没分过类的
  python tools/sticker-contact-sheet.py --mode pending       # 等他点头的那些
  python tools/sticker-contact-sheet.py --mode all --out tmp/all.png
  python tools/sticker-contact-sheet.py --ids k0466 k0472

注意：pending 的表情图是别人发的，看可以，别拿标签当真——
upkeepStickers 不看图（只按 ctx 猜），这里看到什么也别直接写回库。
"""
import argparse
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(ROOT, 'data', 'stickers', 'library.json')


def load_items(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f).get('items', [])


def pick(items, mode, ids):
    if ids:
        want = set(ids)
        return [i for i in items if i['id'] in want]
    if mode == 'unclassified':
        return [i for i in items if not i.get('tags')]
    if mode == 'pending':
        return [i for i in items if i.get('pending')]
    if mode == 'present':
        return [i for i in items if os.path.exists(os.path.join(ROOT, i['file']))]
    return list(items)


def font(size):
    for p in (r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\consola.ttf'):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return None


def build(items, cols, cell, out):
    rows = (len(items) + cols - 1) // cols
    img_px = cell - 28
    sheet = Image.new('RGB', (cols * cell, max(rows, 1) * cell), (245, 245, 245))
    dr = ImageDraw.Draw(sheet)
    f = font(max(14, cell // 6))
    for n, it in enumerate(items):
        r, c = divmod(n, cols)
        x, y = c * cell, r * cell
        dr.rectangle([x, y, x + cell - 1, y + cell - 1], outline=(200, 200, 200))
        try:
            im = Image.open(os.path.join(ROOT, it['file']))
            im.seek(0)
            im = im.convert('RGB')
            im.thumbnail((img_px, img_px))
            sheet.paste(im, (x + (cell - im.width) // 2, y + 4 + (img_px - im.height) // 2))
        except Exception:
            dr.text((x + 4, y + 4), 'ERR', fill=(255, 0, 0), font=f)
        label = it['id'][-3:]
        dr.text((x + 3, y + cell - (f.size + 6 if f else 14)), label, fill=(0, 0, 160), font=f)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    sheet.save(out)
    return sheet.size


def main():
    ap = argparse.ArgumentParser(description='表情库联络表')
    ap.add_argument('--mode', default='unclassified',
                    choices=['unclassified', 'pending', 'all', 'present'])
    ap.add_argument('--ids', nargs='*', default=None)
    ap.add_argument('--cols', type=int, default=9)
    ap.add_argument('--cell', type=int, default=128)
    ap.add_argument('--lib', default=LIB)
    ap.add_argument('--out', default=None)
    a = ap.parse_args()

    items = pick(load_items(a.lib), a.mode, a.ids)
    items.sort(key=lambda i: i['id'])
    if not items:
        print('没有符合条件的表情')
        return 1
    out = a.out or os.path.join(ROOT, 'tmp', f'sticker-sheet-{a.mode}.png')
    size = build(items, a.cols, a.cell, out)
    print(f'{len(items)} 张 → {out} ({size[0]}x{size[1]})')
    print('编号 = id 后三位，按行读')
    return 0


if __name__ == '__main__':
    sys.exit(main())
