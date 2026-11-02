#!/usr/bin/env python
"""把一张多格竖排漫画按格切开，一格一个文件、原尺寸。

为什么要有：联络表一格只有 350 像素，三格竖排的漫画塞进去，每一格只剩
一百来像素高（2026-11-01 实测 k1337：1500x2000，每格约 640px 高，进表后约 117px）
——「最后一格是不是包袱」这种问题，在表上根本看不见那一格。
与其让眼睛在表上猜是第几格，不如先把格切好、一格一张递过去。

怎么认格与格之间的缝（不靠猜，靠量）：
  · 逐行算灰度标准差；一整行几乎是同一个颜色 → 这一行是"平"的；
  · 连续几行都平 → 一段缝，取中线切开；
  · 中间隔两三行过渡像素也算同一段（格框那圈线不是内容）；
  · 贴着上/下边的平段不算切点（那是页边留白）；
  · 一条缝都没有 → 它就是一整张，返回 1 格，不硬切。

实测（2026-11-01，reject 里的三张）：
  · k1337 三格：缝在 y≈638（黑框线+白缝）和 y≈1310（黑线）→ 切出 3 格；
  · k1374 一整张分镜线稿：一条缝都没有 → 1 格，没被硬切；
  · k1412 六格：只有顶部一段平，切不出——它的格缝压在深色底上没有对比，
    这种情况老老实实说 1 格，让调用方退回看原图。

退回去的时候只说量到的数，不猜原因（2026-11-01 修）：
  以前 uneven 的说明写的是"疑心缝落在内容里"。核对 45 张 uneven 时发现这句是
  编的——比如 k0357 是一条推特的截图，切成"图 / 图标行 / 用户名行 / 说明字 / 图"，
  那四条平带是白带，不在任何格的内容里。既然看的是行标准差，就只有行标准差能说，
  所以现在报的是：几条缝、切出几段、高矮差几倍、最宽一条平带多少像素占图高多少。
  拿这些数去判断"该换信号还是该看整张"，比听我讲一个没量过的故事强。

  同时量过两条"看起来像真修复"的改法，都不成立，别再试：
  · 把太宽的平带（>8% 图高）排除出切点：ok 从 17 掉到 14–16（真漫画确实有宽缝），
    uneven 只从 45 降到 41——治的不是这个病；
  · 用"段内平均行标准差"认截图（段太稀就不是格）：ok 里 k0550 最低才 3、k0459 才 11，
    uneven 里 k0357 三段全是 46–56——两边分不开，别拿密度当判据。

  同一天晚些时候又抓到一句假的（too_small）：
  原来退回时写"切出来的段都不到图高的 6%"。把 reject 里 15 张 too_small 逐张量下来，
  15 张全是有且只有 1 段够高，最高那段占图高 87–99%，丢掉的只是顶上一条状态栏那样的薄边。
  也就是说那句话对它描述的每一张都是假的——跟"疑心缝落在内容里"同一种错，只是藏得更深：
  前一句编的是原因，这一句编的是"量到的数"。
  现在报的是：几条缝、切出几段、最高那段多少 px 占图高多少、够高的有几段。

  第四句假的（同一天收尾时核对出来的，最不起眼）：uneven 报"N 条缝切出 M 段"，
  可 M 只是过了 min_h 的段数，缝和段对不上账——45 张 uneven 里 15 张是这样，
  k0357 写着"4 条缝切出 3 段"，而 4 条缝只能切出 5 段，多的两条薄边被 min_h 丢了。
  现在段数用未过滤的 seg_hs_raw（恒等于缝数 + 1），够高的段另说一句。

用法：
  python tools/panel-split.py --file data/stickers/reject/k1337.jpg --out tmp/k1337
  python tools/panel-split.py --files a.jpg b.jpg --outdir tmp/panels --json
  python tools/panel-split.py --file x.jpg --out tmp/x --dry   # 只报切几格，不落盘
  python tools/panel-split.py --selfcheck   # 五张已知结果的图，改完规则先跑这个
"""
import argparse
import json
import os
import re
import sys

from PIL import Image

FLAT_SD = 6.0        # 一行灰度标准差低于这个就算"平"
MERGE = 4            # 平段之间隔这么几行也并成一段
MIN_GAP = 1          # 一段缝至少几行
MIN_PANEL = 0.06     # 一格至少占原图高度的 6%
# 一堆又碎又扁的"缝"，不是漫画格缝，是文字行间的空白（截图、长图、UI）。
# 判据：切点够多（>=5）且中位段高不到图高的 10% → 这压根不是一条分格漫画。
NOT_STRIP_N = 5
NOT_STRIP_RATIO = 0.10

# 回归样本：五张图的正确答案是逐张量出来的，不是猜的（2026-11-01）。
# 规则动一次就跑一遍 --selfcheck。k1337 是唯一一张真切成三格、最后一格还能用的；
# 它要是从 ok 掉成 uneven/not_strip，说明新规则顺手把能用的那张也一起挡了。
# k0357 是推特截图（图 / 图标行 / 用户名 / 说明字 / 图），一条推文不许被切成"格子"。
FIXTURES = [
    ('k1337.jpg', 3, 'ok'),      # 三格，最后一格是包袱（裁出来就是 k1348）
    ('k1391.jpg', 2, 'ok'),      # 上下两格；切得动，但笑点在两格之间，单独拿不出
    ('k1374.jpg', 1, 'no_gap'),  # 一整张分镜线稿，没有缝，本来就不该切
    ('k1412.jpg', 1, '!ok'),     # 六格竖长条，深底上缝没对比，切出来是残的
    ('k0357.jpg', 1, '!ok'),     # 推特截图：白带夹着字，不许当成格
]


def row_sd(im):
    """逐行灰度标准差。先缩到 300 宽算，够用，也快。"""
    w, h = im.size
    scale = min(1.0, 300.0 / max(1, w))
    small = im.convert('L')
    if scale < 1.0:
        small = small.resize((max(1, int(w * scale)), h), Image.BILINEAR)
    px = small.load()
    sw = small.size[0]
    out = []
    for y in range(h):
        row = [px[x, y] for x in range(sw)]
        m = sum(row) / float(sw)
        out.append((sum((v - m) ** 2 for v in row) / sw) ** 0.5)
    return out


def find_bands(sds, h):
    """平段 → [(a, b)]。已经并掉过渡行、剔掉页边留白和太薄的段。"""
    groups, cur = [], None
    for y, sd in enumerate(sds):
        if sd < FLAT_SD:
            if cur is None:
                cur = [y, y]
            else:
                cur[1] = y
        else:
            if cur is not None:
                groups.append(cur)
                cur = None
    if cur is not None:
        groups.append(cur)

    merged = []
    for g in groups:
        if merged and g[0] - merged[-1][1] <= MERGE:
            merged[-1][1] = g[1]
        else:
            merged.append(list(g))

    bands = []
    for a, b in merged:
        if b - a + 1 < MIN_GAP:
            continue
        if a <= 0 or b >= h - 1:          # 页边留白，不是格缝
            continue
        bands.append((a, b))
    return bands


def find_cuts(sds, h):
    """平段 → [(切点, 这条平带有几行)]。

    把平带高度一起交回去，是为了报错时能说"最宽的一条平带多高"——
    手上只有行标准差，能说的就只有行标准差量得出来的东西。
    """
    return [((a + b) // 2, b - a + 1) for a, b in find_bands(sds, h)]


def split_panels(im, detail=None):
    """返回 ([(top, bottom)], reason)。没切的时候要说得清是哪一种：

      ok        —— 切开了；
      no_gap    —— 一条平缝都没有（一整张的分镜稿），本来就不该切；
      not_strip —— 缝多而碎（文字长图 / 截图 / UI），根本不是分格漫画；
      uneven    —— 切开了，但段与段高矮悬殊，这种分配不像分格，退回整张；
      too_small —— 切点挨得太近，有格子够不上 MIN_PANEL。

    分这几种是因为往下该干的事不一样：no_gap 就该直接看原图；
    not_strip 连切都别想，换工具或直接整张看；uneven/too_small 说明切点算法
    在这一张上没认出格缝，值得换信号再试一次。

    detail 给一个 dict 就把量到的数填进去（cut_bands / seg_hs / seg_ratio），
    报错时照着念，别另外猜一个原因。
    """
    w, h = im.size
    found = find_cuts(row_sd(im), h)
    cuts = [c for c, _ in found]
    if detail is not None:
        detail['cut_bands'] = [{'y': c, 'h': bh, 'pct': round(100.0 * bh / h, 1)}
                               for c, bh in found]
    if not cuts:
        return [(0, h)], 'no_gap'
    edges = [0] + cuts + [h]
    # 先排除"这不是漫画"：文字长图 / 截图里，每一行字之间都是一条平缝，
    # 能认出几十条，切出来全是几十像素的横条。这种图交给眼睛看整张才对，
    # 但它跟"多格漫画没切动"是两件事，报错要分开说（2026-11-01，40 张实测：
    # k0343 认出 28 条缝，段高中位数 65px / 1920px，是长图不是分格）。
    # 必须用未过滤的原始段高：min_h 会把扁段先丢掉，正好把这条证据抹掉
    # （k0293 就是这样被切成 6 条 105px 的横带、还报了 ok）。
    raw = sorted(edges[i + 1] - edges[i] for i in range(len(edges) - 1))
    median_raw = raw[len(raw) // 2]
    if detail is not None:
        # 这两笔只为了报错时能照数念：判 not_strip 用的是中位段高，那说的时候就得给出中位段高。
        detail['img_h'] = h
        detail['median_seg_h'] = median_raw
    if len(cuts) >= NOT_STRIP_N and median_raw < h * NOT_STRIP_RATIO:
        return [(0, h)], 'not_strip'
    # 切点定了，raw 就是"这张图被分成几段"的原始账：段数恒等于缝数 + 1。
    # uneven 的说明也得用它：detail['seg_hs'] 只装过了 min_h 的段，拿它当段数
    # 会跟缝数打架（2026-11-01 收尾核对 45 张 uneven，15 张对不上——k0357 就是
    # "4 条缝切出 3 段"，而 4 条缝只能切出 5 段，多的两条薄边被 min_h 丢了）。
    if detail is not None:
        detail['seg_hs_raw'] = raw
    min_h = max(8, int(h * MIN_PANEL))
    boxes = [(edges[i], edges[i + 1]) for i in range(len(edges) - 1)
             if edges[i + 1] - edges[i] >= min_h]
    if len(boxes) <= 1:
        # 零段或一段够高：这张图实际上就是一整张，别的都是被 min_h 丢掉的薄边。
        # （2026-11-01 实测 reject 里 15 张 too_small，15 张都是这种情况：
        #   最高那段占图高 87–99%，剩下的是顶上的状态栏/页边。）
        # 不能算 ok，否则调用方以为"查过了、就是一格"。
        # 报数要报得出来"几段够高、最高那段多高"，见文件头 2026-11-01 第二条。
        if detail is not None:
            detail['n_fit'] = len(boxes)
        return [(0, h)], 'too_small'
    # 段与段高矮悬殊（k1412 六格：深底上格缝没对比，只认出顶上两条，
    # 切出 168/120/1632 三条）。宁可认作一整张，也别递半截给人看。
    #
    # 这里只说"高矮悬殊"，不解释成"缝落在内容里"：那是个没量过的说法，
    # 45 张不均的图里有一大半其实是截图的白带（k0357），跟"内容里的缝"无关。
    hs = [b - a for a, b in boxes]
    if detail is not None:
        detail['seg_hs'] = hs
        detail['seg_ratio'] = round(max(hs) / float(min(hs)), 2)
    if len(hs) > 1 and max(hs) > 2.5 * min(hs):
        return [(0, h)], 'uneven'
    return boxes, 'ok'


def cut_file(p, prefix, max_width, dry=False):
    im = Image.open(p)
    im.seek(0)
    im = im.convert('RGB')
    w, h = im.size
    detail = {}
    boxes, reason = split_panels(im, detail)
    parts = []
    if not dry:
        d = os.path.dirname(os.path.abspath(prefix))
        if d:
            os.makedirs(d, exist_ok=True)
    for i, (top, bot) in enumerate(boxes, 1):
        out = '%s-p%d.png' % (prefix, i)
        if not dry:
            panel = im.crop((0, top, w, bot))
            pw, ph = panel.size
            if pw > max_width:
                panel = panel.resize(
                    (max_width, max(1, int(round(ph * max_width / float(pw))))),
                    Image.LANCZOS)
            panel.save(out)
        parts.append({'n': i, 'top': top, 'bottom': bot, 'w': w, 'h': bot - top,
                      'path': out})
    return {'file': p, 'panels': len(boxes), 'reason': reason,
            'detail': detail, 'parts': parts}


def selfcheck():
    """五张已知结果的图跑一遍。缺图就跳过，不假装验过。"""
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     '..', 'data', 'stickers', 'reject')
    bad = 0
    for name, want_n, want_r in FIXTURES:
        p = os.path.join(d, name)
        if not os.path.exists(p):
            print('跳过 %s：reject 里已经没有这张了' % name)
            continue
        im = Image.open(p)
        im.seek(0)
        detail = {}
        boxes, reason = split_panels(im.convert('RGB'), detail)
        if want_r.startswith('!'):
            r_ok = reason != want_r[1:]
        else:
            r_ok = reason == want_r
        if len(boxes) != want_n or not r_ok:
            bad += 1
            print('不合格 %s：期望 %d 格 / %s，实际 %d 格 / %s'
                  % (name, want_n, want_r, len(boxes), reason))
        else:
            print('过 %s：%d 格 / %s' % (name, len(boxes), reason))
        # 退回说明里那句数也得对账：段数恒等于缝数 + 1（薄边被 min_h 丢了也一样）。
        note = reason_note({'reason': reason, 'detail': detail})
        m = re.search(r'(\d+) 条缝.*?(\d+) 段', note)
        if m and int(m.group(2)) != int(m.group(1)) + 1:
            bad += 1
            print('不合格 %s：说明里的段数跟缝数对不上（%s）' % (name, note.strip()))
    print('自检 %d 项不合格' % bad if bad else '自检全过')
    return 1 if bad else 0


def reason_note(r):
    """退回时念给眼睛听的那一句，只有量到的数。

    跟 src/stickers/screen.mjs 的 uncutNote 是同一个口径（那边给模型看，这边给人看）。
    2026-11-01 收尾核对：20:0x 那轮只改了 mjs，脚本自己 stdout 还在印
    "4 条缝切出 3 段"——同一句话两个渲染处，改一处另一处接着假。
    现在两边都从 seg_hs_raw 取段数，自检里也盯着这条账。
    """
    d = r.get('detail') or {}
    cb = d.get('cut_bands') or []
    raw = d.get('seg_hs_raw') or []
    hs = d.get('seg_hs') or []
    reason = r.get('reason')
    if reason == 'uneven' and hs:
        wid = max(cb, key=lambda b: b['h']) if cb else {'h': 0, 'pct': 0}
        if raw and len(raw) != len(hs):
            head = ('  %d 条缝把图分成 %d 段，够高的 %d 段（其余 %d 段不到门槛）'
                    % (len(cb), len(raw), len(hs), len(raw) - len(hs)))
        else:
            head = '  %d 条缝切出 %d 段' % (len(cb), len(hs))
        return (head + '，高 %d..%d（差 %.1f 倍，门槛 2.5），'
                '最宽一条平带 %dpx 占 %s%% 图高 —— 不切，看整张'
                % (min(hs), max(hs), max(hs) / float(min(hs)), wid['h'], wid['pct']))
    if reason == 'too_small':
        h = int(d.get('img_h') or 0)
        if raw and h > 0:
            hi = max(raw)
            pct = round(100.0 * hi / h, 1)
            if int(d.get('n_fit') or 0) >= 1:
                return ('  %d 条缝切出 %d 段，只有 1 段够高：最高 %dpx 占图高 %s%%'
                        '（门槛 6%%），其余 %d 段都不到'
                        % (len(cb), len(raw), hi, pct, len(raw) - 1))
            return ('  %d 条缝切出 %d 段，最高的才 %dpx 占图高 %s%%（门槛 6%%），一段都不够'
                    % (len(cb), len(raw), hi, pct))
        return '  没切开（too_small），段高没递过来'
    return {'no_gap': '  没平缝，本来就是一整张',
            'not_strip': '  缝多而碎，是文字长图/截图，不是分格漫画'}.get(reason, '')


def main():
    ap = argparse.ArgumentParser(description='多格竖排漫画切成单格')
    ap.add_argument('--file')
    ap.add_argument('--files', nargs='+')
    ap.add_argument('--selfcheck', action='store_true',
                    help='跑五张已知样本，规则改完先跑这个')
    ap.add_argument('--out', help='单文件模式：输出前缀 <前缀>-p1.png')
    ap.add_argument('--outdir', help='多文件模式：每张落成 <outdir>/<stem>-pN.png')
    ap.add_argument('--max-width', type=int, default=900)
    ap.add_argument('--json', action='store_true', help='一行 JSON，给 mjs 读')
    ap.add_argument('--dry', action='store_true', help='只报切几格，不落盘')
    a = ap.parse_args()

    if a.selfcheck:
        return selfcheck()


    files = a.files or ([a.file] if a.file else [])
    if not files:
        print('要给 --file 或 --files')
        return 2

    results = []
    for p in files:
        if not os.path.exists(p):
            results.append({'file': p, 'panels': 0, 'parts': [], 'error': '找不到'})
            continue
        stem = os.path.splitext(os.path.basename(p))[0]
        if a.files or a.outdir:
            prefix = os.path.join(a.outdir or 'tmp', stem)
        else:
            # --dry 只报不落盘，没有 --out 时给个占位前缀，别在输出里印 None-p1.png。
            prefix = a.out or (os.path.join('tmp', stem) if a.dry else None)
        if prefix is None:
            results.append({'file': p, 'panels': 0, 'parts': [],
                            'error': '单文件模式要给 --out'})
            continue
        try:
            results.append(cut_file(p, prefix, a.max_width, a.dry))
        except Exception as e:                      # 一张坏了不拖累别的
            results.append({'file': p, 'panels': 0, 'parts': [], 'error': str(e)[:60]})

    if a.json:
        # note 给探针用（scripts/probe-panel-note.mjs）：同一份 detail，这边怎么念、
        # mjs 的 uncutNote 怎么念，得逐字对得上账。多给一个字段不影响老调用方。
        for r in results:
            if not r.get('error'):
                r['note'] = reason_note(r).strip()
        print(json.dumps(results, ensure_ascii=False))
        return 0
    for r in results:
        if r.get('error'):
            print('%s  切不动：%s' % (r['file'], r['error']))
            continue
        print('%s  %d 格%s' % (r['file'], r['panels'], reason_note(r)))
        for pt in r['parts']:
            print('  p%d  y=%d..%d  %dx%d  %s'
                  % (pt['n'], pt['top'], pt['bottom'], pt['w'], pt['h'], pt['path']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
