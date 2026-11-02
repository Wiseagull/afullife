#!/usr/bin/env python
"""把一批待筛的图拼成一张联络表，一次 read_image 就整批看完。

为什么要有：筛表情原先一张一次 read_image，一轮四张就是四张图。拼成一张之后
一次就能看完，一格 384 像素时字还读得出来（2026-10-28 实测：格子里印着
「小孩的恐惧 / 大人的恐惧」和枪械面板的分项数值，都没糊）。

和 tools/sticker-contact-sheet.py 的分工：
  · sticker-contact-sheet.py  从 library.json 里挑，看的是已经入库的
  · pending-sheet.py          直接给路径列表，看的是刚收进来、还没入库的
                                所以它不读 library.json，也不需要 id 存在于库里。

用法：
  python tools/pending-sheet.py --files a.png b.png c.png --out tmp/x.png
  python tools/pending-sheet.py --files ... --out ... --cell 512 --cols 4

格子数默认按张数开方（4 张 → 2x2，9 张 → 3x3，12 张 → 3x4）。十二张一格 384
也还认得清是哪张（2026-10-28 实测，k1126 里那行灰色小字都读得到），所以别默认
四张就够。
小图会**放大填满**格子再居中裁切：库里一半的图只有 250~400 像素宽，
按原尺寸 paste 进 512 的格子，四周全是白的，等于白占地方。

边界（脚本会自己报）：真正决定读不读得出的是「字在格子里剩几个像素」，不是倍数。
2026-10-28 拿两组样本量过，一格 384：
  · 白底 22px 干净字：缩到 8.6 倍还读得出「DeepSeek Messages transport failed ¥0.1598」
    ——所以别把倍数当硬指标，倍数大不等于糊；
  · 深底 14px 界面字（真实截图常见的样子）：4 倍还行、5 倍勉强、6 倍没了；
    同一格里那行更小的灰字（11px）3 倍就开始糊。
所以默认倍数到 4 倍就提一句「这几张的字大概率糊，单看」——宁可多说一句，
也别把看不清的东西当成看清了。缩多少由 --warn-ratio 调。
"""
import argparse
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont


def font(size):
    for p in (r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\consola.ttf'):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return None


def cover(im, box):
    """等比放大（或缩小）到刚好盖满 box 的正方形，居中裁切。小图也放大，不留白。"""
    w, h = im.size
    if w <= 0 or h <= 0:
        return im
    s = max(box / float(w), box / float(h))
    nw, nh = max(1, int(round(w * s))), max(1, int(round(h * s)))
    im = im.resize((nw, nh), Image.LANCZOS)
    left, top = (nw - box) // 2, (nh - box) // 2
    return im.crop((left, top, left + box, top + box))


def build(paths, cols, cell, out, warn_ratio=4.0):
    """返回 (画布尺寸, 缩得太狠的那几张 [(名字, 倍数, 原图长边)])。"""
    n = len(paths)
    cols = cols or max(1, int(round(n ** 0.5)))
    rows = (n + cols - 1) // cols
    pad = 4
    inner = cell - pad * 2 - 26          # 底下留一条印编号
    sheet = Image.new('RGB', (cols * cell, max(rows, 1) * cell), (245, 245, 245))
    dr = ImageDraw.Draw(sheet)
    f = font(max(16, cell // 9))
    tiny = []
    for i, p in enumerate(paths):
        r, c = divmod(i, cols)
        x, y = c * cell, r * cell
        dr.rectangle([x, y, x + cell - 1, y + cell - 1], outline=(200, 200, 200))
        try:
            im = Image.open(p)
            im.seek(0)
            im = im.convert('RGB')
            long_side = max(im.size)
            ratio = long_side / float(inner)            # 缩了多少倍才塞进格子
            if ratio >= warn_ratio:
                tiny.append((os.path.basename(p)[:24], ratio, long_side))
            sheet.paste(cover(im, inner), (x + pad, y + pad))
        except Exception as e:                       # 一张坏了只坏一格，不拖累整批
            dr.text((x + pad, y + pad), 'ERR %s' % str(e)[:24], fill=(255, 0, 0), font=f)
        label = os.path.splitext(os.path.basename(p))[0][:16]
        dr.text((x + pad, y + cell - (f.size + 6 if f else 18)), label, fill=(0, 0, 160), font=f)
    d = os.path.dirname(os.path.abspath(out))
    if d:
        os.makedirs(d, exist_ok=True)
    sheet.save(out)
    return sheet.size, tiny


def main():
    ap = argparse.ArgumentParser(description='待筛的图拼成联络表')
    ap.add_argument('--files', nargs='+', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--cell', type=int, default=384)
    ap.add_argument('--cols', type=int, default=0)
    ap.add_argument('--warn-ratio', type=float, default=4.0,
                    help='长边缩到格子内边多少倍以上就提示「字可能糊」')
    a = ap.parse_args()

    paths = [p for p in a.files if os.path.exists(p)]
    missing = len(a.files) - len(paths)
    if not paths:
        print('一张都没找到')
        return 1
    (w, h), tiny = build(paths, a.cols, a.cell, a.out, a.warn_ratio)
    print('%d 张 → %s (%dx%d)' % (len(paths), a.out, w, h))
    if missing:
        print('有 %d 张找不到，已跳过' % missing)
    if tiny:
        tiny.sort(key=lambda t: t[1], reverse=True)
        print('有 %d 张缩了 %.1f 倍以上，格子里的小字会糊，最先该单看的是这几张：'
              % (len(tiny), a.warn_ratio))
        for name, ratio, _ in tiny[:5]:
            print('  %s  %.1fx' % (name, ratio))
        if len(tiny) > 5:
            print('  …还有 %d 张' % (len(tiny) - 5))
        # 换成能读清小字的格子：内边 ≥ 最长边 / warn_ratio，再加回边距和编号条
        need = int(math.ceil(max(t[2] for t in tiny) / a.warn_ratio)) + 34
        if need > a.cell:
            c2 = a.cols or max(1, int(round(len(paths) ** 0.5)))
            r2 = (len(paths) + c2 - 1) // c2
            print('想连小字一起读：--cell 至少 %d（画布会变成 %dx%d，那还不如单看）'
                  % (need, need * c2, need * r2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
