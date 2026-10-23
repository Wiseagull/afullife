// 按文件头认容器格式 —— QQ 下来的东西名字不可信（.png 里装 JPEG 是常态），
// 名字错了工具会拒读，所以宁可自己嗅一遍。
import fs from 'node:fs';

/** 图片：png / jpg / gif / webp，认不出返回 null */
export function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/**
 * 视频：mp4 / mov（都是一个 ftyp 盒子）/ webm / mkv / flv，认不出返回 null。
 * mov 和 mp4 在容器层面是一回事，就统一叫 mp4，播放器都认。
 */
export function sniffVideo(buf) {
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  if (buf.length >= 3 && buf.subarray(0, 3).toString('latin1') === 'FLV') return 'flv';
  return null;
}

/** 只读文件头十几字节就够认了，别整份读进来 */
export function sniffFile(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(16);
    const n = fs.readSync(fd, head, 0, 16, 0);
    return sniffImage(head.subarray(0, n)) || sniffVideo(head.subarray(0, n));
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}
