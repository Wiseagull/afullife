// 筛表情：把"候选"过一遍，决定哪张真的能当表情包收着。
//
// 为什么不按大小/来源判：截图也是一个 PNG、也不大，
// 但游戏结算、股票、直播、聊天记录这些收着没用，发出去也不像话。
// 她能看图（headless 也能，read_image 实测能读出画面），所以这件事交给眼睛，
// 不交给"文件多大"。
//
// 判定只有三档：
//   sticker    = 能单独表达情绪、能用来接话的梗图/表情 → 进收藏
//   screenshot = 游戏结算、聊天记录、股票、直播、商品、文档、地图这类信息截图 → 退回 reject/
//   other      = 说不清的（照片、随手拍）→ 退回 reject/
//
// 2026-10-28 改成一次看一整批。
// 原来是一张一次 brain.run，日志实测单张 5.7 万 token——其中几乎全是系统提示词和
// 工具定义，图片本身才几千。一轮四张就是四次 5.7 万，等于同一份说明读了四遍。
// 现在一次给四张、一次读一份说明，图片增量很小；顺带同批能互相参照（一眼看出
// 哪张是截图、哪张是梗图），判得比以前稳。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../config.mjs';

// 全角空格。用转义写，不写那个字本身——eslint 的 no-irregular-whitespace 会拦字面量，
// 而这行确实是"排给模型看的对齐分隔"（id、说明、路径三栏别挤成一坨），不是误输入。
const GAP = '\u3000';

/**
 * 把这一批拼成一张联络表。
 *
 * 逐张 read_image，一轮四张就是四张图；拼成一张之后一次看完，同批还能互相参照。
 * 格子 384 像素——2026-10-28 实测这个尺寸下格子里的字还读得出来（她的原话：
 * 「卡住的不是我的眼睛，是画布」）。小图会放大填满，不留白。
 *
 * 拼不成（没装 PIL、python 不在 PATH）就返回 null，调用方退回逐张。
 *
 * 返回 { path, thin }。thin 是脚本自己量出来的「缩得太狠、格子里小字已经糊了」那几张。
 * 2026-11-01：这个提示一直在脚本里算、一直往 stdout 打，然后被这里丢掉——
 * 也就是说系统知道哪几张该单看，却没告诉看图的模型。现在带出去拼进提示词。
 */
export function makeSheet(list, outPath) {
  if (!Array.isArray(list) || !list.length) return null;
  const py = process.env.QAD_PYTHON || 'python';
  const script = path.join(ROOT, 'tools', 'pending-sheet.py');
  if (!fs.existsSync(script)) return null;
  try {
    const r = spawnSync(
      py,
      [script, '--files', ...list.map((i) => i.abs), '--out', outPath, '--cell', '384'],
      { encoding: 'utf8', timeout: 60000, windowsHide: true },
    );
    if (r.status !== 0 || !fs.existsSync(outPath)) return null;
    // 脚本的提示是「  k1337.jpg  5.7x」这种两行缩进行，按文件名对回 pending 里的 id。
    const thin = [];
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const m = line.match(/^\s{2}(\S+)\s+([\d.]+)x\s*$/);
      if (!m) continue;
      const it = list.find((i) => path.basename(i.abs) === m[1]);
      if (it) thin.push({ id: it.id, abs: it.abs, ratio: Number(m[2]) });
    }
    return { path: outPath, thin };
  } catch {
    return null;
  }
}

const VERDICTS = new Set(['sticker', 'screenshot', 'other']);

const INSTRUCTIONS = `你现在的活：看图，判断它们能不能当表情包收藏。我会给你一批，每张都有 id。

判断标准：
- sticker：画面本身就在表达情绪或态度（撒娇、无语、翻白眼、笑、生气、得意、装可怜……），或者能拿来接话的梗图。抠图小人、手绘、电影/动画定格配字、猫狗动物表情都算。
- screenshot：这张图的信息主体是"内容"而不是"情绪"。游戏结算/抽卡/段位/背包、聊天记录、股票账户、直播画面、商品页、文档、地图、代码、网页——都算。
- other：真人自拍、随手拍的实景、看不出想表达什么的图。

注意：有些图底子是截图但被做成了梗（比如游戏结算里配了字，本身是个笑话），这种算 sticker。
多格漫画（三联、四联、长条）：整张不能收——发出去是一段故事，群里没人接得住。唯一的例外是「包袱格」：某一格自己就是一个完整的笑话或一句完整的态度，单独拿出来、不看别的格也能笑能接话（最常见的是最后一格）。这种才 verdict 写 other、when 写「可裁：第 N 格」。如果笑点要靠格与格对照才成立（前后反差、铺垫转反转、上下两格互文），那是梗在格与格之间，哪一格都别标——裁出来一定残。

输出规矩：先在心里判断，最后每一张图输出一行 JSON，一张一行，别的什么都别写。
每行的 id 必须照抄我给你的那个 id，一个都不能少，也不能多：
{"id":"k1069","verdict":"sticker","tags":["撒娇","得意"],"when":"他想被夸的时候"}
- tags 最多 3 个，用中文，写"这张图表达什么情绪/什么场合发"，不要描述画面内容
- when 一句话，写"什么场合该发它"
- verdict 是 screenshot 时，tags 给空数组、when 给空字符串
- verdict 是 other 时 tags 也给空数组；when 只有一种情况要写：多格漫画里某一格是能自己站住的包袱格，就写「可裁：第 N 格」，别的一句都别写。拿不准它单拿出去还成不成话，就当不成，不标`;

/**
 * 从模型输出里抠出所有判断，按 id 收成表。
 * 一图一行 JSON；某一行坏了只丢那一张（那张会留着下轮再看），不连累别的。
 */
export function parseVerdicts(text) {
  const out = new Map();
  const m = String(text || '').match(/\{[\s\S]*?\}/g) || [];
  for (const raw of m) {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v.verdict === 'string' && v.id !== undefined) out.set(String(v.id), v);
    } catch { /* 这一行坏了，跳过 */ }
  }
  return out;
}

/** 拼这一批的提示词：一张一段，id 和路径都写清楚。 */
export function batchPrompt(pending = [], sheet = '') {
  const lines = [INSTRUCTIONS, '', `要看的图（一共 ${pending.length} 张）：`];
  const sheetPath = typeof sheet === 'string' ? sheet : (sheet?.path || '');
  const thin = Array.isArray(sheet?.thin) ? sheet.thin : [];

  // 拼得成联络表就只给一个路径：一次 read_image 看完一批，格子角上印着 id。
  if (sheetPath) {
    lines.push('');
    lines.push(`我把这一批拼成了一张联络表：${sheetPath}`);
    lines.push('  用 read_image 打开它。一格一张，格子左下角印着这张的 id。');
    lines.push('  按格子里的 id 输出判断，一个都不能少，也别漏掉任何一格。');
    for (const it of pending) {
      const bits = [`  · ${it.id}`];
      if (it.ctx) bits.push(`收进来时旁边说的话：${it.ctx}`);
      if (it.from) bits.push(`是谁发的：${it.from}`);
      lines.push(bits.join(GAP));
    }
    if (thin.length) {
      lines.push('');
      lines.push('  下面这几张塞进格子时缩得太狠，格子里的小字已经糊了——在表上看不出它是不是多格、哪一格能单拿。要判它们，先 read_image 原图；别的格子不用开：');
      for (const t of thin) lines.push(`  · ${t.id}${GAP}缩了 ${t.ratio} 倍${GAP}原图 ${t.abs}`);
    }
    const panels = Array.isArray(sheet?.panels) ? sheet.panels : [];
    if (panels.length) {
      lines.push('');
      lines.push('  另外这几张是多格竖排的，表上每一格都被压成一条横带，数不出第几格。我先把它们按格切开了，一格一个文件、原尺寸——判「哪一格能单拿」看下面这些，别在表上数：');
      for (const p of panels) {
        for (const part of p.parts) lines.push(`  · ${p.id} 第 ${part.n} 格${GAP}${part.path}`);
      }
    }
    const uncut = Array.isArray(sheet?.uncut) ? sheet.uncut : [];
    if (uncut.length) {
      // 切过、没切开。这里只说量到的数，不替脚本猜原因（它以前猜过一次，猜错了）。
      lines.push('');
      lines.push('  还有这几张我试过按格切，没切开——它们在表上是被压成一条的横带，别在表上数格子，也别拿横带猜；要判就读原图：');
      for (const u of uncut) lines.push(`  · ${u.id}${GAP}${uncutNote(u)}${GAP}原图 ${u.abs}`);
    }
    return lines.join('\n');
  }

  pending.forEach((it, i) => {
    lines.push('');
    lines.push(`第 ${i + 1} 张 · id=${it.id}`);
    lines.push(`  路径（用 read_image 打开它）：${it.abs}`);
    if (it.ctx) lines.push(`  收进来时旁边说的话：${it.ctx}`);
    if (it.from) lines.push(`  是谁发的：${it.from}`);
  });
  return lines.join('\n');
}

/**
 * 把这一批里能切的多格图按格切开，一格一个原尺寸文件。
 *
 * 为什么：联络表一格 350 像素，三格竖排的漫画进表之后每一格只剩一百来像素高，
 * 「最后一格写得什么」在表上根本看不见（2026-11-01 实测 k1337：每格约 117px，
 * 切开之后 900 宽，「约会改到下周可以吗」才读得出来）。
 * 所以不在表上让眼睛数格子，先切成一格一张，再把路径递过去。
 *
 * 切不动（一条缝都没有、或者切出来高矮悬殊）就不切，那一张照旧看原图。
 *
 * 返回 { cut: [{ id, abs, parts: [{n, path}] }], uncut: [{ id, abs, reason, detail }] }。
 * cut 只含真的切开（≥2 格）的；uncut 是"试过但没切开"的，带脚本量到的数。
 * 脚本跑不起来才返回 null。
 *
 * 2026-11-01：uncut 这一支以前是被丢掉的——脚本明明量出了「几条缝、切出几段、
 * 高矮差几倍」，出了 JSON 就没人接，模型只看见表上一条压扁的横带，不知道这张
 * 是被切过、被放弃的。跟 makeSheet 的 thin 一样：算出来却不说，等于没算。
 * （reject 里 200 张实测：就 12 张切得开，uneven 28 + too_small 9 全落在这条静默的路上。）
 */
export function panelize(list, dirPath) {
  if (!Array.isArray(list) || !list.length) return { cut: [], uncut: [] };
  const py = process.env.QAD_PYTHON || 'python';
  const script = path.join(ROOT, 'tools', 'panel-split.py');
  if (!fs.existsSync(script)) return null;
  try {
    // PYTHONIOENCODING：Windows 上 python 默认按控制台代码页（cp936）往管道里写，
    // 这边用 utf8 解就是一片问号——说明里的数照样能读（都是 ASCII），但文件名一有中文
    // 就会对不上 list.find(i => i.abs === row.file)。给它钉死 utf-8。
    const r = spawnSync(py, [script, '--files', ...list.map((i) => i.abs),
      '--outdir', dirPath, '--json'], {
      encoding: 'utf8',
      timeout: 90000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    if (r.status !== 0) return null;
    const rows = JSON.parse(String(r.stdout || '[]').trim());
    const cut = [];
    const uncut = [];
    for (const row of rows) {
      if (!row || row.error) continue;
      const it = list.find((i) => i.abs === row.file);
      if (!it) continue;
      if (Array.isArray(row.parts) && row.parts.length >= 2) {
        cut.push({ id: it.id, abs: it.abs, parts: row.parts.map((p) => ({ n: p.n, path: p.path })) });
      } else if (row.reason && row.reason !== 'no_gap') {
        // no_gap = 没缝，人家本来就是一整张，没什么要提醒的。
        uncut.push({ id: it.id, abs: it.abs, reason: row.reason, detail: row.detail || {} });
      }
    }
    return { cut, uncut };
  } catch {
    return null;
  }
}

/**
 * 没切开的那些，念给它听的就只有量到的数——跟脚本 stdout 里那行同一个口径。
 * 不说"缝落在内容里"，因为那是编的（见 tools/panel-split.py 文件头 2026-11-01 那段）。
 */
export function uncutNote(row) {
  const d = (row && row.detail) || {};
  const bands = Array.isArray(d.cut_bands) ? d.cut_bands : [];
  const hs = Array.isArray(d.seg_hs) ? d.seg_hs : [];
  const reason = String(row && row.reason);
  if (reason === 'uneven' && hs.length) {
    const lo = Math.min(...hs);
    const hi = Math.max(...hs);
    const ratio = d.seg_ratio ?? Number((hi / lo).toFixed(2));
    const wid = bands.reduce((a, b) => (b.h > a.h ? b : a), { h: 0, pct: 0 });
    const raw = Array.isArray(d.seg_hs_raw) ? d.seg_hs_raw : [];
    // 段数要用未过滤的那份：seg_hs 只装够高的段，拿它配缝数就是两本账
    // （2026-11-01 收尾核对：45 张里 15 张出现"4 条缝切出 3 段"这种对不上的话）。
    const head = raw.length && raw.length !== hs.length
      ? `${bands.length} 条缝把图分成 ${raw.length} 段，够高的 ${hs.length} 段（其余 ${raw.length - hs.length} 段不到门槛）`
      : `${bands.length} 条缝切出 ${hs.length} 段`;
    return `${head}，高 ${lo}..${hi}（差 ${ratio} 倍，门槛 2.5），`
      + `最宽一条平带 ${wid.h}px 占 ${wid.pct}% 图高`;
  }
  if (reason === 'too_small') {
    // 以前这里写"切出来的段都不到图高的 6%"。15 张实测里 15 张都有 1 段够高（87–99%），
    // 丢掉的只是薄边——那句话是假的，所以现在照数量念。
    const raw = Array.isArray(d.seg_hs_raw) ? d.seg_hs_raw : [];
    const h = Number(d.img_h || 0);
    if (raw.length && h > 0) {
      const hi = Math.max(...raw);
      const pct = (100 * hi / h).toFixed(1);
      if (Number(d.n_fit) >= 1) {
        return `${bands.length} 条缝切出 ${raw.length} 段，只有 1 段够高：`
          + `最高 ${hi}px 占图高 ${pct}%（门槛 6%），其余 ${raw.length - 1} 段都不到`;
      }
      return `${bands.length} 条缝切出 ${raw.length} 段，最高的才 ${hi}px 占图高 ${pct}%（门槛 6%），一段都不够`;
    }
    return '没切开（too_small），段高没递过来——这条别当数看';
  }
  if (reason === 'not_strip') {
    const med = Number(d.median_seg_h || 0);
    const h = Number(d.img_h || 0);
    const pct = h ? (100 * med / h).toFixed(1) : '?';
    return `${bands.length} 条缝切出 ${bands.length + 1} 段，段高中位数 ${med}px（图高 ${h} 的 ${pct}%，门槛 10%）——`
      + '像文字长图/截图，不像分格';
  }
  if (reason === 'ok') return '按格切开了';
  return `没切开（${reason || '没给原因'}）`;
}

/**
 * 退回时写进档案的理由：档名，后面跟上模型写在 when 里的那半句。
 *
 * when 本来只留给"收下的图"当使用说明，但退回的图也可能带着一句有用的话——
 * 多格漫画的「可裁：第 2 格」就是。以前这一支只写档名，于是那张整图的档案里
 * 只剩一个类型词（k1337 的 reason 是 `comic-strip-3panels`，when 是空的，
 * 因为当时的说明书还写着 other 一律空 when，两条规矩互相打架，裁不裁得动没人知道）。
 * 现在这句话跟着理由进 reject-*.jsonl，回头 grep「可裁」就能把能裁的挑回来。
 */
function rejectReason(v) {
  const verdict = String(v.verdict);
  const note = String(v.when || '').trim();
  return note ? `${verdict}｜${note}` : verdict;
}

/**
 * 过一遍候选池。
 * @returns {{checked:number, kept:number, rejected:number, skipped:number}}
 */
export async function screenStickers({ brain, stickers, logger = () => {}, maxOps = 16 } = {}) {
  const pending = (await stickers.pendingAll()).slice(0, maxOps);
  if (!pending.length) return { checked: 0, kept: 0, rejected: 0, skipped: 0 };

  const out = { checked: pending.length, kept: 0, rejected: 0, skipped: 0 };

  // 先试着拼一张联络表：一张图看完一批，比逐张读省得多。
  const sheetPath = path.join(ROOT, 'tmp', `sticker-pending-${Date.now()}.png`);
  const sheet = makeSheet(pending, sheetPath);
  const sheetPathUsed = sheet?.path || '';
  // 多格的先切成一格一张：表上那条横带看不清，切开才读得出格子里的字。
  let uncutN = 0;
  if (sheet) {
    const dir = path.join(ROOT, 'tmp', `sticker-panels-${Date.now()}`);
    const panels = panelize(pending, dir);
    if (panels?.cut?.length) sheet.panels = panels.cut;
    if (panels?.uncut?.length) {
      sheet.uncut = panels.uncut;
      uncutN = panels.uncut.length;
    }
  }
  logger('sticker', sheet
    ? `这一批 ${pending.length} 张拼成一张联络表，一次看完${sheet.thin.length ? `（其中 ${sheet.thin.length} 张缩糊了，让它单看原图）` : ''}${uncutN ? `（${uncutN} 张按格切不开，量到的数已写进提示词）` : ''}`
    : `这一批 ${pending.length} 张拼不成联络表（python/PIL 不在？），逐张看`);

  let verdicts = new Map();
  try {
    const r = await brain.run({ prompt: batchPrompt(pending, sheet || '') });
    verdicts = parseVerdicts(r?.text);
  } catch (e) {
    logger('sticker', `这一批没看成：${e?.message ?? e}`);
    // 没看成的时候别把联络表删掉：那会儿它是唯一能说明「这一批长什么样」的东西。
    // （2026-10-29：CLI 没配，三张候选连拼好的表一起没了，只剩一句错误。）
    if (sheetPathUsed) logger('sticker', `联络表留在 ${sheetPathUsed}`);
    out.skipped = pending.length;
    return out;
  } finally {
    // 看成了才删；没看成的走上面那条，表留着给下一次或我自己看。
    if (sheetPathUsed && out.skipped === 0) {
      try { fs.rmSync(sheetPathUsed, { force: true }); } catch { /* 删不掉就算了 */ }
    }
  }

  for (const it of pending) {
    const v = verdicts.get(String(it.id));
    if (!v) {
      logger('sticker', `${it.id} 没给出判断，留着下轮再看`);
      out.skipped += 1;
      continue;
    }
    try {
      if (v.verdict === 'sticker') {
        await stickers.approve(it.id, {
          tags: Array.isArray(v.tags) ? v.tags.slice(0, 3).map(String) : [],
          when: String(v.when || ''),
        });
        out.kept += 1;
        logger('sticker', `${it.id} 收下：${(v.tags || []).join('/')}`);
      } else if (VERDICTS.has(String(v.verdict))) {
        await stickers.reject(it.id, rejectReason(v));
        out.rejected += 1;
        logger('sticker', `${it.id} 退回（${v.verdict}）`);
      } else {
        // 三档以外的判断（2026-10-31 真出现过 "comic-strip-3panels"）。
        // 以前这一支和 screenshot 走同一条路：原词直接当理由写进 reject。
        // 结果 reject 档案里多出一个看着像"类别"的东西，回头翻会以为自己有一整套分类，
        // 其实那只是一行 else 的兜底。理由里写清"没认出来"，别让它冒充判断。
        // when 里的话照样留着——原词是编的，那半句说明可能是真的。
        const note = String(v.when || '').trim();
        await stickers.reject(it.id, `未识别判断：${String(v.verdict)}${note ? `｜${note}` : ''}`);
        out.rejected += 1;
        logger('sticker', `${it.id} 退回（判断不在三档里：${v.verdict}）`);
      }
    } catch (e) {
      logger('sticker', `${it.id} 落库没成：${e?.message ?? e}`);
      out.skipped += 1;
    }
  }
  return out;
}
