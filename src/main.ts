import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { Bridge } from "./bridge/bridge.ts";
import { CodexAppServer } from "./codex/appServer.ts";
import { loadConfig, parseIdList, type Config } from "./config.ts";
import { acquireInstanceLock } from "./lock.ts";
import { configureLogger, createLogger } from "./log.ts";
import { QQApi } from "./qq/api.ts";
import { QQGateway } from "./qq/gateway.ts";
import { MessageSender } from "./qq/sender.ts";
import { AccessTokenManager } from "./qq/token.ts";
import { EXIT_FATAL, FatalError } from "./util.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION: string = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const log = createLogger("main");

function warnIfNobodyAllowed(config: Config): void {
  if (config.qq.allowedUsers.size === 0 && config.qq.allowedGroups.size === 0) {
    log.warn("白名单为空，目前没有人能使用 Codex。给机器人发 /whoami 拿到 ID，填进 .env 的 QQ_ALLOWED_USERS（保存后自动生效）");
  } else if (config.qq.allowedUsers.has("*") || config.qq.allowedGroups.has("*")) {
    log.warn("白名单包含 *：任何能给机器人发消息的人都可以让 Codex 在本机执行操作，请确认这是你想要的");
  }
}

/** 修改 .env 里的白名单后无需重启。 */
function watchAllowlist(config: Config): void {
  const envFile = path.join(config.rootDir, ".env");
  if (!fs.existsSync(envFile)) return;
  fs.watchFile(envFile, { interval: 2000 }, () => {
    try {
      const env = parseEnv(fs.readFileSync(envFile, "utf8"));
      for (const [set, value] of [
        [config.qq.allowedUsers, env.QQ_ALLOWED_USERS],
        [config.qq.allowedGroups, env.QQ_ALLOWED_GROUPS],
      ] as const) {
        set.clear();
        for (const id of parseIdList(value)) set.add(id);
      }
      log.info(`白名单已更新：用户 ${config.qq.allowedUsers.size} 个，群 ${config.qq.allowedGroups.size} 个`);
      warnIfNobodyAllowed(config);
    } catch (err) {
      log.warn("重新读取 .env 失败", err instanceof Error ? err.message : err);
    }
  });
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  let config: Config;
  try {
    config = loadConfig(ROOT);
  } catch (err) {
    // 配置没读成功也把错误写进日志文件，开机自启失败后能查到原因
    configureLogger({ dir: path.join(path.resolve(ROOT, process.env.DATA_DIR?.trim() || "./data"), "logs") });
    throw new FatalError(`配置有误：${err instanceof Error ? err.message : String(err)}`);
  }
  configureLogger({ level: config.logLevel, dir: checkOnly ? undefined : path.join(config.dataDir, "logs") });
  fs.mkdirSync(config.codex.cwd, { recursive: true });
  log.info(`qqbot-codex v${VERSION} 启动（AppID ${config.qq.appId}，订阅 ${config.qq.intentNames.join(" | ")}）`);
  // 自检不连网关，可以和正在运行的实例同时进行
  if (!checkOnly && !(await acquireInstanceLock(`qqbot-codex-${config.qq.appId}`, config.dataDir))) {
    throw new FatalError("这个机器人已经有一个实例在运行（可能是开机自启的那个），本次不再启动");
  }

  const tokens = new AccessTokenManager(config.qq);
  const api = new QQApi({ apiBase: config.qq.apiBase, appId: config.qq.appId, tokens });
  const me = await api.getMe();
  log.info(`QQ 机器人：${me.username}（${me.id}）`);
  warnIfNobodyAllowed(config);

  const codex = new CodexAppServer({ bin: config.codex.bin, clientVersion: VERSION });
  await codex.start();
  const sender = new MessageSender({ api, markdown: config.qq.markdown });
  const bridge = new Bridge({ config, codex, sender });
  await bridge.init();

  if (checkOnly) {
    const gw = await api.getGatewayBot();
    const limit = gw.session_start_limit;
    log.info(`网关地址：${gw.url}${limit ? `（今日剩余连接次数 ${limit.remaining}/${limit.total}）` : ""}`);
    await codex.stop();
    log.info("自检通过 ✅");
    return;
  }

  let stopping = false;
  const gateway = new QQGateway({
    api,
    tokens,
    intents: config.qq.intents,
    onDispatch: (type, data, eventId) => bridge.handleEvent(type, data, eventId),
    onFatal: (reason) => void shutdown(EXIT_FATAL, reason),
  });

  async function shutdown(code: number, reason?: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    log.info(`正在退出${reason ? `：${reason}` : ""}`);
    gateway.stop();
    bridge.shutdown();
    await codex.stop();
    process.exit(code);
  }

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void shutdown(0));
  }
  gateway.start();
  watchAllowlist(config);
}

process.on("unhandledRejection", (err) => log.error("未处理的异常", err));
process.on("uncaughtException", (err) => {
  // 写进日志文件再退出，守护进程会重启
  log.error("未捕获的异常，进程退出", err);
  process.exit(1);
});
// 退出码：0 正常退出；2 配置/凭据等重试也没用的错误，守护进程不再重启；其它（如网络不通）会被重启
main().catch((err) => {
  const cause = err?.cause?.code ?? err?.cause?.message; // fetch failed 的具体原因，如 ENOTFOUND（开机时网络还没好）
  log.error(`启动失败：${err instanceof Error ? err.message : String(err)}${cause ? `（${cause}）` : ""}`);
  process.exit(err instanceof FatalError ? EXIT_FATAL : 1);
});
