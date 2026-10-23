import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * 动图（GIF）怎么给她看。
 *
 * read_image 读 GIF 只给一帧（实测：28 帧的表情包，她看到的是静止画面，
 * 她自己也知道"没法判断原本是动图"）。所以收到多帧 GIF 时顺手转一份 mp4，
 * 塞进 videoFiles——她抽帧那套（ffmpeg -vf fps / -frames:v）就能直接用在上面，
 * 想看第三帧、想描述动作，都有东西可看。
 *
 * 为什么转 mp4 而不是让她直接抽 GIF：GIF 的帧延时经常是 0 或 10ms，
 * fps 抽帧会抽出一堆重复帧；转成视频后时间轴是均匀的，步长才可控。
 */

/** GIF 里"图形控制扩展"出现几次，大致就是几帧（够用，不是精确解析）。 */
export function gifFrameCount(buf) {
  if (!buf || buf.length < 6) return 0;
  if (buf.subarray(0, 3).toString('latin1') !== 'GIF') return 0;
  let n = 0;
  for (let i = 0; i < buf.length - 2; i += 1) {
    if (buf[i] === 0x21 && buf[i + 1] === 0xf9 && buf[i + 2] === 0x04) n += 1;
  }
  return n;
}

export function isAnimatedGif(buf) {
  return gifFrameCount(buf) > 1;
}

/**
 * GIF → mp4。失败就当没这回事（返回 null，不抛）——她少看一段动图，不能拖垮整轮。
 */
export async function gifToMp4({ gifPath, outDir, tag = '', timeoutMs = 20000 }) {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const base = `${String(tag || path.basename(gifPath, path.extname(gifPath))).replace(/[^\w.-]/g, '_').slice(0, 60)}-anim.mp4`;
    const out = path.join(outDir, base);
    const args = [
      '-y', '-loglevel', 'error',
      '-i', gifPath,
      // 宽高取偶数，不然 yuv420p 编不出来
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      out,
    ];
    const ok = await new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      let child;
      try {
        child = spawn('ffmpeg', args, { windowsHide: true, stdio: 'ignore' });
      } catch { finish(false); return; }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* 已经退了 */ } finish(false); }, timeoutMs);
      child.on('error', () => { clearTimeout(timer); finish(false); });
      child.on('exit', (code) => { clearTimeout(timer); finish(code === 0); });
    });
    if (!ok) return null;
    if (!fs.existsSync(out) || !fs.statSync(out).size) return null;
    return out;
  } catch {
    return null;
  }
}
