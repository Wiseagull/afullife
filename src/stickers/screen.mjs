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

const INSTRUCTIONS = `你现在的活：一张一张看图，判断它能不能当表情包收藏。

判断标准：
- sticker：画面本身就在表达情绪或态度（撒娇、无语、翻白眼、笑、生气、得意、装可怜……），或者能拿来接话的梗图。抠图小人、手绘、电影/动画定格配字、猫狗动物表情都算。
- screenshot：这张图的信息主体是"内容"而不是"情绪"。游戏结算/抽卡/段位/背包、聊天记录、股票账户、直播画面、商品页、文档、地图、代码、网页——都算。
- other：真人自拍、随手拍的实景、看不出想表达什么的图。

注意：有些图底子是截图但被做成了梗（比如游戏结算里配了字，本身是个笑话），这种算 sticker。

输出规矩：先在心里判断，最后只输出一行 JSON，别的什么都别写：
{"verdict":"sticker","tags":["撒娇","得意"],"when":"他想被夸的时候"}
- tags 最多 3 个，用中文，写"这张图表达什么情绪/什么场合发"，不要描述画面内容
- when 一句话，写"什么场合该发它"
- verdict 是 screenshot 或 other 时，tags 和 when 给空数组和空字符串`;

/** 从模型输出里抠出那行 JSON */
function parseVerdict(text) {
  const m = String(text || '').match(/\{[\s\S]*?\}/g);
  if (!m) return null;
  for (const raw of m.reverse()) {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v.verdict === 'string') return v;
    } catch { /* 下一个 */ }
  }
  return null;
}

/**
 * 过一遍候选池。
 * @returns {{checked:number, kept:number, rejected:number, skipped:number}}
 */
export async function screenStickers({ brain, stickers, logger = () => {}, maxOps = 4 } = {}) {
  const pending = (await stickers.pendingAll()).slice(0, maxOps);
  if (!pending.length) return { checked: 0, kept: 0, rejected: 0, skipped: 0 };

  const out = { checked: 0, kept: 0, rejected: 0, skipped: 0 };
  for (const it of pending) {
    out.checked += 1;
    const prompt = [
      INSTRUCTIONS,
      '',
      `这张图的路径（用 read_image 打开它）：${it.abs}`,
      it.ctx ? `收进来时旁边说的话：${it.ctx}` : '',
      it.from ? `是谁发的：${it.from}` : '',
    ].filter(Boolean).join('\n');

    let v = null;
    try {
      const r = await brain.run({ prompt });
      v = parseVerdict(r?.text);
    } catch (e) {
      logger('sticker', `看 ${it.id} 出错：${e?.message ?? e}`);
      out.skipped += 1;
      continue;
    }

    if (!v) {
      logger('sticker', `${it.id} 没给出判断，留着下轮再看`);
      out.skipped += 1;
      continue;
    }

    if (v.verdict === 'sticker') {
      await stickers.approve(it.id, {
        tags: Array.isArray(v.tags) ? v.tags.slice(0, 3).map(String) : [],
        when: String(v.when || ''),
      });
      out.kept += 1;
      logger('sticker', `${it.id} 收下：${(v.tags || []).join('/')}`);
    } else {
      await stickers.reject(it.id, String(v.verdict));
      out.rejected += 1;
      logger('sticker', `${it.id} 退回（${v.verdict}）`);
    }
  }
  return out;
}
