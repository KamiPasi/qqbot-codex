import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 把 skills/ 下的 skill 装进 Codex：复制到 $CODEX_HOME/skills/<名字>/（默认 ~/.codex/skills），
 * 模板里的 {{NOTIFY_SCRIPT}} 换成本机 scripts/notify.ts 的路径。仓库换了位置、skill 有更新时，重新运行一次即可。
 * 用法：node scripts/install-skill.ts
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = path.join(ROOT, "skills");
const target = path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"), "skills");
const notifyScript = path.join(ROOT, "scripts", "notify.ts");

for (const name of fs.readdirSync(SKILLS)) {
  const src = path.join(SKILLS, name, "SKILL.md");
  if (!fs.existsSync(src)) continue;
  const dest = path.join(target, name, "SKILL.md");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, fs.readFileSync(src, "utf8").replaceAll("{{NOTIFY_SCRIPT}}", notifyScript));
  console.log(`已安装 ${name}：${dest}`);
}
