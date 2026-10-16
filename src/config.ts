import fs from "node:fs";
import path from "node:path";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "never" | "on-request" | "untrusted";
export type MarkdownMode = "auto" | "on" | "off";

export interface Config {
  rootDir: string;
  dataDir: string;
  logLevel: string;
  qq: {
    appId: string;
    appSecret: string;
    apiBase: string;
    tokenUrl: string;
    intents: number;
    intentNames: string[];
    /** 允许的用户 openid；包含 "*" 表示所有人 */
    allowedUsers: Set<string>;
    /** 允许的群 openid；包含 "*" 表示所有群 */
    allowedGroups: Set<string>;
    markdown: MarkdownMode;
    progress: boolean;
    groupSession: "shared" | "user";
    maxChunkChars: number;
    maxChunks: number;
  };
  codex: {
    bin?: string;
    cwd: string;
    model?: string;
    effort?: string;
    sandbox?: SandboxMode;
    approvalPolicy: ApprovalPolicy;
    extraInstructions: string;
    maxConcurrent: number;
    turnTimeoutMs: number;
  };
}

/** QQ 网关事件订阅位，见 https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html */
export const INTENTS: Record<string, number> = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C_EVENT: 1 << 25,
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  FORUMS_EVENT: 1 << 28,
  AUDIO_ACTION: 1 << 29,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
};

export function parseIntents(value: string): { bits: number; names: string[] } {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const bits = Number(trimmed);
    return { bits, names: Object.keys(INTENTS).filter((k) => (bits & INTENTS[k]) !== 0) };
  }
  let bits = 0;
  const names: string[] = [];
  for (const raw of trimmed.split(/[\s,|]+/)) {
    if (!raw) continue;
    const name = raw.toUpperCase();
    if (!(name in INTENTS)) {
      throw new Error(`未知的 intent: ${raw}（可选：${Object.keys(INTENTS).join(", ")}）`);
    }
    bits |= INTENTS[name];
    names.push(name);
  }
  if (bits === 0) throw new Error("QQ_INTENTS 不能为空");
  return { bits, names };
}

export function parseIdList(value: string | undefined): string[] {
  return (value ?? "").split(/[\s,，]+/).filter(Boolean);
}

function list(value: string | undefined): Set<string> {
  return new Set(parseIdList(value));
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} 必须是正数，当前值：${value}`);
  return Math.floor(n);
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], name: string): T | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`${name} 只能是 ${allowed.join(" | ")}，当前值：${v}`);
  }
  return v as T;
}

export function loadConfig(rootDir: string): Config {
  const envFile = path.join(rootDir, ".env");
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;

  const appId = env.QQ_APP_ID?.trim();
  const appSecret = env.QQ_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new Error("缺少 QQ_APP_ID / QQ_APP_SECRET，请在 .env 中填写（参考 .env.example）");
  }

  const apiBase = (env.QQ_API_BASE?.trim() || "https://api.bot.qq.com").replace(/\/+$/, "");
  const intents = parseIntents(env.QQ_INTENTS || "GROUP_AND_C2C_EVENT,PUBLIC_GUILD_MESSAGES");
  const resolve = (p: string) => path.resolve(rootDir, p);

  return {
    rootDir,
    dataDir: resolve(env.DATA_DIR?.trim() || "./data"),
    logLevel: env.LOG_LEVEL?.trim() || "info",
    qq: {
      appId,
      appSecret,
      apiBase,
      tokenUrl: env.QQ_TOKEN_URL?.trim() || `${apiBase}/app/getAppAccessToken`,
      intents: intents.bits,
      intentNames: intents.names,
      allowedUsers: list(env.QQ_ALLOWED_USERS),
      allowedGroups: list(env.QQ_ALLOWED_GROUPS),
      markdown: oneOf(env.QQ_MARKDOWN, ["auto", "on", "off"] as const, "QQ_MARKDOWN") ?? "auto",
      progress: bool(env.QQ_PROGRESS, true),
      groupSession: oneOf(env.QQ_GROUP_SESSION, ["shared", "user"] as const, "QQ_GROUP_SESSION") ?? "shared",
      maxChunkChars: int(env.QQ_MAX_CHUNK_CHARS, 1800, "QQ_MAX_CHUNK_CHARS"),
      maxChunks: int(env.QQ_MAX_CHUNKS, 5, "QQ_MAX_CHUNKS"),
    },
    codex: {
      bin: env.CODEX_BIN?.trim() || undefined,
      cwd: resolve(env.CODEX_CWD?.trim() || "./workspace"),
      model: env.CODEX_MODEL?.trim() || undefined,
      effort: env.CODEX_EFFORT?.trim() || undefined,
      sandbox: oneOf(env.CODEX_SANDBOX, ["read-only", "workspace-write", "danger-full-access"] as const, "CODEX_SANDBOX"),
      approvalPolicy:
        oneOf(env.CODEX_APPROVAL_POLICY, ["never", "on-request", "untrusted"] as const, "CODEX_APPROVAL_POLICY") ?? "never",
      extraInstructions: (env.CODEX_INSTRUCTIONS ?? "").replace(/\\n/g, "\n").trim(),
      maxConcurrent: int(env.CODEX_MAX_CONCURRENT, 3, "CODEX_MAX_CONCURRENT"),
      turnTimeoutMs: int(env.CODEX_TURN_TIMEOUT_MIN, 30, "CODEX_TURN_TIMEOUT_MIN") * 60_000,
    },
  };
}
