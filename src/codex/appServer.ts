import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { createLogger } from "../log.ts";
import { sleep } from "../util.ts";
import type { InitializeResponse } from "./protocol.ts";

const log = createLogger("codex");

export class CodexRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "CodexRpcError";
    this.code = code;
    this.data = data;
  }
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export type NotificationHandler = (method: string, params: any) => void;
export type ServerRequestHandler = (method: string, params: any) => Promise<unknown>;

/**
 * 找到启动 codex 的方式。Windows 上 npm 装的 codex 是 .cmd 包装脚本，
 * 直接用 node 运行其 bin/codex.js，避免经过 cmd.exe。
 */
export function resolveCodexCommand(bin?: string): { command: string; args: string[]; shell: boolean } {
  if (bin) {
    if (/\.[cm]?js$/i.test(bin)) return { command: process.execPath, args: [bin], shell: false };
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) return { command: `"${bin}"`, args: [], shell: true };
    return { command: bin, args: [], shell: false };
  }
  if (process.platform !== "win32") return { command: "codex", args: [], shell: false };
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const codexJs = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(path.join(dir, "codex.cmd")) && existsSync(codexJs)) {
      return { command: process.execPath, args: [codexJs], shell: false };
    }
    const exe = path.join(dir, "codex.exe");
    if (existsSync(exe)) return { command: exe, args: [], shell: false };
  }
  return { command: "codex", args: [], shell: true };
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * 以子进程方式运行 `codex app-server`（stdio 上的 JSON-RPC），
 * 负责请求/响应配对、通知分发、服务端请求应答，以及异常退出后的自动重启。
 */
export class CodexAppServer {
  #bin: string | undefined;
  #clientVersion: string;
  #child: ChildProcessWithoutNullStreams | undefined;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #generation = 0;
  #ready: Promise<void> | undefined;
  #stopping = false;
  #restartAttempt = 0;
  #startedAt = 0;
  #notificationHandlers = new Set<NotificationHandler>();
  #exitHandlers = new Set<(reason: string) => void>();
  #serverRequestHandler: ServerRequestHandler | undefined;
  info: InitializeResponse | undefined;

  constructor(opts: { bin?: string; clientVersion: string }) {
    this.#bin = opts.bin;
    this.#clientVersion = opts.clientVersion;
  }

  /** 每次（重新）启动加一。线程需要在当前 generation 里 resume 过才能使用。 */
  get generation(): number {
    return this.#generation;
  }

  onNotification(handler: NotificationHandler): void {
    this.#notificationHandlers.add(handler);
  }

  /** app-server 意外退出时回调（随后会自动重启）。 */
  onExit(handler: (reason: string) => void): void {
    this.#exitHandlers.add(handler);
  }

  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.#serverRequestHandler = handler;
  }

  start(): Promise<void> {
    this.#stopping = false;
    this.#ready = this.#spawnAndInit();
    return this.#ready;
  }

  async request<T>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    if (!this.#ready) throw new Error("Codex app-server 尚未启动");
    await this.#ready;
    return this.#rawRequest<T>(method, params, timeoutMs);
  }

  notify(method: string, params?: unknown): void {
    this.#write(params === undefined ? { method } : { method, params });
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    if (!child) return;
    child.stdin.end();
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
      sleep(5000).then(() => false),
    ]);
    if (!exited && child.pid) {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGKILL");
    }
  }

  async #spawnAndInit(): Promise<void> {
    const { command, args, shell } = resolveCodexCommand(this.#bin);
    log.info(`启动 Codex app-server：${[command, ...args, "app-server"].join(" ")}`);
    const child = spawn(command, [...args, "app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell,
      windowsHide: true,
      env: process.env,
    });
    this.#child = child;
    this.#generation++;
    this.#startedAt = Date.now();

    child.stdin.on("error", (err) => log.debug(`stdin 写入失败：${err.message}`));
    createInterface({ input: child.stdout }).on("line", (line) => this.#onLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.trim()) log.debug(`[stderr] ${stripAnsi(line)}`);
    });
    child.once("error", (err) => this.#onExit(child, `无法启动 codex：${err.message}`));
    child.once("exit", (code, signal) =>
      this.#onExit(child, `codex app-server 已退出（code=${code}${signal ? ` signal=${signal}` : ""}）`),
    );

    try {
      this.info = await this.#rawRequest<InitializeResponse>(
        "initialize",
        {
          clientInfo: { name: "qqbot_codex", title: "QQ Bot", version: this.#clientVersion },
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
        60_000,
      );
    } catch (err) {
      if (this.#child === child) child.kill();
      throw err;
    }
    this.notify("initialized");
    log.info(`Codex app-server 已就绪：${this.info.userAgent}`);
  }

  #rawRequest<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (!this.#child) return Promise.reject(new Error("Codex app-server 未运行"));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              reject(new Error(`Codex 请求 ${method} 超时`));
            }, timeoutMs)
          : undefined;
      this.#pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      this.#write(params === undefined ? { id, method } : { id, method, params });
    });
  }

  #write(message: object): void {
    const child = this.#child;
    if (!child || child.stdin.destroyed) return;
    child.stdin.write(JSON.stringify(message) + "\n");
  }

  #onLine(line: string): void {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      log.debug(`非 JSON 输出：${line.slice(0, 200)}`);
      return;
    }
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && msg.method === undefined) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new CodexRpcError(msg.error.code ?? -1, `${pending.method}: ${msg.error.message ?? "未知错误"}`, msg.error.data));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (hasId && typeof msg.method === "string") {
      void this.#answerServerRequest(msg.id, msg.method, msg.params);
      return;
    }
    if (typeof msg.method === "string") {
      for (const handler of this.#notificationHandlers) {
        try {
          handler(msg.method, msg.params ?? {});
        } catch (err) {
          log.error(`处理通知 ${msg.method} 出错`, err);
        }
      }
    }
  }

  async #answerServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      if (!this.#serverRequestHandler) throw new CodexRpcError(-32601, `不支持的请求：${method}`);
      const result = await this.#serverRequestHandler(method, params ?? {});
      this.#write({ id, result });
    } catch (err) {
      const code = err instanceof CodexRpcError ? err.code : -32603;
      this.#write({ id, error: { code, message: err instanceof Error ? err.message : String(err) } });
    }
  }

  #onExit(child: ChildProcessWithoutNullStreams, reason: string): void {
    if (child !== this.#child) return;
    this.#child = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
    if (this.#stopping) return;
    log.error(reason);
    for (const handler of this.#exitHandlers) {
      try {
        handler(reason);
      } catch (err) {
        log.error("处理 app-server 退出回调出错", err);
      }
    }
    if (Date.now() - this.#startedAt > 60_000) this.#restartAttempt = 0;
    const delay = Math.min(30_000, 1000 * 2 ** this.#restartAttempt++);
    log.info(`${delay / 1000} 秒后重启 Codex app-server`);
    this.#ready = sleep(delay).then(() => {
      if (this.#stopping) throw new Error("Codex app-server 已停止");
      return this.#spawnAndInit();
    });
    this.#ready.catch((err) => log.error("重启 Codex app-server 失败", err instanceof Error ? err.message : err));
  }
}
