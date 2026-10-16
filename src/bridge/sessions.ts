import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../log.ts";

const log = createLogger("sessions");

/** 一个 QQ 会话（单聊/群/子频道）对应的持久化信息 */
export interface SessionRecord {
  threadId?: string;
  /** 这个会话用过的线程，最近的在前 */
  history?: string[];
  model?: string;
  effort?: string;
  cwd?: string;
  updatedAt: number;
}

/** 把“QQ 会话 → Codex 线程”的映射保存在 JSON 文件里，重启后可以接着聊。 */
export class SessionStore {
  #file: string;
  #data: Record<string, SessionRecord> = {};
  #timer: NodeJS.Timeout | undefined;

  constructor(file: string) {
    this.#file = file;
    try {
      this.#data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`读取 ${file} 失败，将重新开始`, err);
    }
  }

  get(key: string): SessionRecord | undefined {
    return this.#data[key];
  }

  update(key: string, patch: Partial<SessionRecord>): void {
    this.#data[key] = { ...this.#data[key], ...patch, updatedAt: Date.now() };
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.flush(), 500).unref();
  }

  flush(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.#data, null, 2));
      fs.renameSync(tmp, this.#file);
    } catch (err) {
      log.error(`保存 ${this.#file} 失败`, err);
    }
  }
}
