import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../src/config.ts";
import { configureLogger } from "../src/log.ts";
import {
  describePlan,
  describeResult,
  parseNotifyArgs,
  planNotification,
  sendNotification,
  UsageError,
} from "../src/notify.ts";
import { QQApi, QQApiError } from "../src/qq/api.ts";
import { MessageSender } from "../src/qq/sender.ts";
import { AccessTokenManager } from "../src/qq/token.ts";
import { EXIT_FATAL, FatalError } from "../src/util.ts";

/**
 * 用机器人的身份把一条消息主动发到 QQ，给 Codex 计划任务、脚本等用。机器人进程不用开着。
 * 用法：node scripts/notify.ts [选项] <消息文字>，详见 --help
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `用法：node scripts/notify.ts [选项] <消息文字>

用机器人的身份把消息主动发到 QQ，凭据和白名单读机器人目录下的 .env。
文字按 Markdown 写，太长会自动分成多条。

选项：
  --to <openid>     发给这个用户，必须在 QQ_ALLOWED_USERS 里。不填时发给白名单里唯一的用户
  --group <openid>  发到这个群，必须在 QQ_ALLOWED_GROUPS 里
  --image <路径>    附带一张本机图片（png/jpg/gif/webp，不超过 5MB），可以写多次，最多 3 张
  --file <路径>     从 UTF-8 文本文件读消息文字（内容多行或带引号时用）
  --dry-run         只显示会发给谁、发什么，不真的发送
  -h, --help        显示这段帮助

退出码：0 已发送；1 发送失败（可能已经发出一部分）；2 参数或配置有误，什么都没发`;

const PROACTIVE_HINT =
  "提示：如果是主动消息被拒，检查机器人资料卡里的「允许主动发送」有没有关掉，以及今天的主动消息条数是否用完。";

async function main(): Promise<number> {
  const args = parseNotifyArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  let config: Config;
  try {
    config = loadConfig(ROOT);
  } catch (err) {
    throw new UsageError(`配置有误：${err instanceof Error ? err.message : String(err)}`);
  }
  configureLogger({ level: "warn" });
  const plan = planNotification(args, config);
  if (args.dryRun) {
    console.log(describePlan(plan));
    return 0;
  }
  const tokens = new AccessTokenManager(config.qq);
  const api = new QQApi({ apiBase: config.qq.apiBase, appId: config.qq.appId, tokens });
  const result = await sendNotification(new MessageSender({ api, markdown: config.qq.markdown }), plan);
  if (result.texts || result.images) console.log(describeResult(plan, result));
  if (result.failures.length === 0) return 0;
  console.error(result.failures.join("\n"));
  if (result.error instanceof QQApiError) console.error(PROACTIVE_HINT);
  // AppID/AppSecret 不对、机器人被封禁：重试也没用
  return result.error instanceof FatalError ? EXIT_FATAL : 1;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = err instanceof UsageError ? EXIT_FATAL : 1;
}
