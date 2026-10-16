import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { configureLogger, createLogger } from "../src/log.ts";
import { EXIT_FATAL, formatDuration, sleep } from "../src/util.ts";

/**
 * 守护进程：运行机器人（src/main.ts），异常退出后自动重启，重启间隔从 5 秒开始翻倍，最长 5 分钟。
 * 机器人正常退出（Ctrl+C）或因配置、凭据错误退出（退出码 2）时不再重启。
 * 用法：node scripts/supervisor.ts [传给 main.ts 的参数]
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = path.join(ROOT, "src", "main.ts");
const MIN_DELAY = 5_000;
const MAX_DELAY = 5 * 60_000;
/** 连续运行超过这么久才退出，算偶发故障，重启间隔从头算 */
const STABLE_RUN = 10 * 60_000;

const log = createLogger("supervisor");
let child: ChildProcess | undefined;
let stopping = false;

/**
 * 日志和机器人写在同一个目录。这里只读取 .env、不写进 process.env：
 * 环境变量的优先级高于 .env，写进去之后子进程会一直继承旧值，改了 .env 再重启也不生效。
 */
function logDir(): string {
  let fileEnv: Record<string, string | undefined> = {};
  try {
    fileEnv = parseEnv(fs.readFileSync(path.join(ROOT, ".env"), "utf8"));
  } catch {
    // 没有 .env 时由机器人自己报错
  }
  const dataDir = process.env.DATA_DIR?.trim() || fileEnv.DATA_DIR?.trim() || "./data";
  return path.join(path.resolve(ROOT, dataDir), "logs");
}

function killTree(proc: ChildProcess): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
  else proc.kill("SIGKILL");
}

function runBot(args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [MAIN, ...args], { cwd: ROOT, stdio: "inherit" });
    child = proc;
    proc.once("error", (err) => {
      log.error("无法启动机器人进程", err);
      resolve({ code: 1, signal: null });
    });
    proc.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function onSignal(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  const proc = child;
  if (!proc) process.exit(0); // 正在等待重启，直接退出
  // Windows 上 Ctrl+C、关闭窗口时子进程在同一个控制台里，会自己收到信号并优雅退出；
  // 其它系统上（例如 kill 守护进程）需要转发给子进程
  if (process.platform !== "win32") proc.kill(signal);
  setTimeout(() => {
    log.warn("机器人 15 秒内没有退出，强制结束");
    killTree(proc);
  }, 15_000).unref();
}

async function supervise(args: string[]): Promise<number> {
  log.info(`守护进程已启动（PID ${process.pid}）：机器人异常退出会自动重启，按 Ctrl+C 停止`);
  let failures = 0;
  for (;;) {
    const startedAt = Date.now();
    const { code, signal } = await runBot(args);
    child = undefined;
    if (stopping) return 0;
    if (code === 0) return 0;
    if (code === EXIT_FATAL) {
      log.error("机器人因重启也解决不了的问题退出（原因见上一条日志），不再自动重启");
      return EXIT_FATAL;
    }
    if (args.includes("--check")) return code ?? 1; // 自检只跑一次
    if (Date.now() - startedAt >= STABLE_RUN) failures = 0;
    const delay = Math.min(MAX_DELAY, MIN_DELAY * 2 ** failures++);
    log.warn(`机器人异常退出（${signal ? `信号 ${signal}` : `退出码 ${code}`}），${formatDuration(delay)}后重启`);
    await sleep(delay);
  }
}

configureLogger({ level: "info", dir: logDir() });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, onSignal);
process.exitCode = await supervise(process.argv.slice(2));
