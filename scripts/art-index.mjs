// data/art 索引生成器：只读文件，不改图。
// 用法：node scripts/art-index.mjs [输出路径]
import fs from "node:fs";
import path from "node:path";

const ROOT = "E:/DSHwork/Code/qagent-dsh";
const ART = path.join(ROOT, "data/art");
const OUT = process.argv[2] || path.join(ART, "索引.md");

function pngSize(file) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(26);
  fs.readSync(fd, buf, 0, 26, 0);
  fs.closeSync(fd);
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function role(name) {
  if (/-v\d+\.png$/i.test(name)) return "版本";
  if (/(联|联络表)/.test(name)) return "联图";
  if (/\.mp4$/i.test(name)) return "视频";
  return "成品";
}

const files = fs.readdirSync(ART)
  .filter((f) => /\.(png|mp4)$/i.test(f))
  .map((f) => {
    const full = path.join(ART, f);
    const st = fs.statSync(full);
    const m = f.match(/^(\d{4}-\d{2}-\d{2})/);
    const day = m ? m[1] : st.mtime.toISOString().slice(0, 10);
    const size = /\.png$/i.test(f) ? pngSize(full) : null;
    return {
      name: f,
      day,
      dim: size ? `${size.w}×${size.h}` : "—",
      kb: Math.round(st.size / 1024),
      role: role(f),
    };
  })
  .sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name, "zh"));

const days = [...new Set(files.map((f) => f.day))].sort();
let md = `# data/art 索引

自动生成（scripts/art-index.mjs），只读文件不改图。日期取文件名前缀，没有前缀的用文件修改日期；
角色按文件名判：\`-v数字\`=版本，含「联 / 联络表」=联图，mp4=视频，其余=成品。

`;
for (const d of days) {
  md += `\n## ${d}\n\n| 文件 | 尺寸 | 大小 | 角色 |\n| --- | --- | --- | --- |\n`;
  for (const f of files.filter((x) => x.day === d)) {
    md += `| ${f.name} | ${f.dim} | ${f.kb} KB | ${f.role} |\n`;
  }
}
md += `\n共 ${files.length} 个文件。\n`;
fs.writeFileSync(OUT, md, "utf8");
console.log(`wrote ${OUT} (${files.length} files, ${days.length} days)`);
