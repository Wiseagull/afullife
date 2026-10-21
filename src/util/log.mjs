// 统一的行日志。带时间戳与标签，方便事后在日志里定位。
const pad = (n) => String(n).padStart(2, '0');

export function ts(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function log(tag, ...args) {
  console.log(`[${ts()}] [${tag}]`, ...args);
}

log.warn = (tag, ...args) => console.warn(`[${ts()}] [${tag}]`, ...args);
log.error = (tag, ...args) => console.error(`[${ts()}] [${tag}]`, ...args);
