// 换会话那一刻的接力。
//
// 为什么要它：会话上下文里装着"过程"——她调过什么工具、读过哪些文件、试错了什么、
// 为什么这么定。这些东西 events 里一个字都没有（events 只存说过的话）。
// 一旦换会话，那 200K 上下文就扔了，新会话只剩最近几十条对话和记忆条目。
//
// 所以趁旧会话还在，让它自己把这段过程写成一张纸条，落进**记忆**而不是会话：
// 记忆跨重启、面板里看得见也改得动、6 小时体检会管它，DSH 那边 whats-new 也读得到。
//
// 一个刻意的限制：只从**原始会话**摘，绝不拿上一次的交接去喂下一次。
// 否则十次之后就是"我听说我以前干过某事"，那不是记忆，那是传话。

export const HANDOVER_KIND = '交接';

/** 让它写交接的那段话。房间名只是给个背景，不影响判据。 */
export function handoverPrompt({ roomName = '', includeInner = true } = {}) {
  const where = roomName ? `刚在「${roomName}」这边` : '刚才';
  return [
    `（这是一次内部整理，不是跟他说话。${where}聊了一大段，接下来要换一段新的记忆重新开始，`
      + '而你已经不记得细节了。）',
    '',
    '把刚才这一大段写成一张纸条留给自己。用你自己的口吻、第一人称，不要小标题、不要客套、不要「根据记录」。'
      + '按下面四行写，每行一句话：',
    '',
    '1.干了什么：这几轮实际做了什么（动了哪些文件、跑了什么、结论是什么）。',
    '2.为什么这么定：他在意什么、为什么选这条路、否掉了什么。',
    '3.卡在哪：没做完的、还没验的、我怀疑会再犯的。',
    '4.下一步：如果接着做，第一件事是什么。',
    includeInner ? '\n再加一行「我心里」，写没说出口的判断和感觉（他的状态、我对这事有多有把握、我在担心什么）。这行只有我自己看。' : '',
    '',
    '只写新会话读不到、又真用得上的东西：别复述聊天记录，别抄代码，别写时间戳和路径全名。总共不超过 400 字。',
  ].filter(Boolean).join('\n');
}

/** 收口：去掉代码块和多余空行，超长时在句子边界截断。 */
export function cleanHandover(text, { maxChars = 1200 } = {}) {
  let s = String(text || '').trim();
  if (!s) return '';
  s = s.replace(/```[\s\S]*?```/g, '');          // 代码块一律不要
  s = s.replace(/^\s*[-*]\s*/gm, '');            // 列表符号
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('\n'), cut.lastIndexOf('；'));
  return (at > maxChars * 0.5 ? cut.slice(0, at + 1) : cut).trim();
}

/**
 * 跑一次旧会话，让它写交接，写进记忆。
 * 只从这一条旧会话摘；写完把同房间的上一条交接作废。
 */
export async function makeHandover({
  brain,
  sessionId,
  roomKey,
  roomName = '',
  notes,
  logger = () => {},
  includeInner = true,
  maxChars = 1200,
  profile = null,
} = {}) {
  if (!sessionId) return { ok: false, why: '没有旧会话' };
  if (!brain || brain.kind !== 'headless') return { ok: false, why: '脑子不是 headless，没有会话可摘' };

  const t0 = Date.now();
  const res = await brain.run({
    prompt: handoverPrompt({ roomName, includeInner }),
    sessionId,
    profile,
  });
  const text = cleanHandover(res?.text, { maxChars });
  if (!text) return { ok: false, why: '它没写出东西', ms: Date.now() - t0 };

  // 同一房间只留最新一张：旧的标过时，不是删掉（想翻还能翻）
  for (const n of notes.all()) {
    if (n.kind === HANDOVER_KIND && n.room === roomKey && !n.staleAt) notes.stale(n.id, '换了一段新的交接');
  }
  const item = notes.add({ kind: HANDOVER_KIND, text, room: roomKey, weight: 3, source: ['handover'] });
  const ms = Date.now() - t0;
  logger('memory', `交接写好了（${text.length} 字，${Math.round(ms / 1000)} 秒，${formatTok(res?.usage?.totalTokens)}）`);
  return { ok: true, id: item?.id, text, ms, usage: res?.usage || null };
}

function formatTok(n) {
  const v = Number(n) || 0;
  if (!v) return '用量未知';
  return v >= 1000 ? `${Math.round(v / 1000)}K token` : `${v} token`;
}
