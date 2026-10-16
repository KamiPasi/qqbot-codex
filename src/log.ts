import fs from "node:fs";
import path from "node:path";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = "info";
let logDir: string | undefined;

export function configureLogger(opts: { level?: string; dir?: string }): void {
  if (opts.level && opts.level in ORDER) minLevel = opts.level as Level;
  if (opts.dir) {
    fs.mkdirSync(opts.dir, { recursive: true });
    logDir = opts.dir;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

function timestamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatExtra(extra: unknown): string {
  if (extra instanceof Error) return extra.stack ?? extra.message;
  if (typeof extra === "string") return extra;
  try {
    return JSON.stringify(extra);
  } catch {
    return String(extra);
  }
}

function write(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const now = new Date();
  let line = `${timestamp(now)} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra !== undefined) line += ` ${formatExtra(extra)}`;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
  if (logDir) {
    const file = path.join(logDir, `bot-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.log`);
    try {
      fs.appendFileSync(file, line + "\n");
    } catch {
      // 写日志失败不影响主流程
    }
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (msg, extra) => write("debug", scope, msg, extra),
    info: (msg, extra) => write("info", scope, msg, extra),
    warn: (msg, extra) => write("warn", scope, msg, extra),
    error: (msg, extra) => write("error", scope, msg, extra),
  };
}
