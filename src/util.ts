export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 退出码 2：配置、凭据等问题，重启也没用，守护进程不再自动重启 */
export const EXIT_FATAL = 2;

/** 重试解决不了的错误（配置错误、凭据错误、机器人被封禁等） */
export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }
}

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, Math.max(0, max - 1)) + "…" : text;
}

export function shortId(id: string | undefined): string {
  return id ? id.slice(0, 6).toUpperCase() : "?";
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}秒`;
  return `${Math.floor(m / 60)}小时${m % 60}分`;
}

/** 有容量上限的去重集合，超出后淘汰最早加入的元素。 */
export class LruSet {
  #max: number;
  #set = new Set<string>();

  constructor(max: number) {
    this.#max = max;
  }

  /** 加入元素；已存在时返回 false。 */
  add(key: string): boolean {
    if (this.#set.has(key)) return false;
    this.#set.add(key);
    if (this.#set.size > this.#max) {
      const oldest = this.#set.values().next().value;
      if (oldest !== undefined) this.#set.delete(oldest);
    }
    return true;
  }
}

/** 简单信号量，限制同时运行的 Codex 任务数。 */
export class Semaphore {
  #available: number;
  #waiters: Array<() => void> = [];

  constructor(count: number) {
    this.#available = count;
  }

  get waiting(): number {
    return this.#waiters.length;
  }

  async acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available--;
    } else {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next) next();
      else this.#available++;
    };
  }
}

const FENCE = /^\s*(```|~~~)/;

function findCut(text: string, budget: number): number {
  const window = text.slice(0, budget);
  const candidates: Array<[RegExp, number]> = [
    [/\n\s*\n/g, 0.4],
    [/\n/g, 0.3],
    [/[。！？；.!?;](?=\s|$)|[。！？；]/g, 0.3],
    [/\s/g, 0.3],
  ];
  for (const [re, minRatio] of candidates) {
    let best = -1;
    for (const m of window.matchAll(re)) {
      const end = (m.index ?? 0) + m[0].length;
      if (end >= budget * minRatio) best = end;
    }
    if (best > 0) return best;
  }
  let cut = budget;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // 不要切断代理对（emoji 等）
  return cut;
}

/**
 * 把长文本切成多段，每段不超过 maxChars。优先在空行、换行、句号处切分；
 * 如果切点落在代码块里，会在本段末尾补上闭合围栏、在下一段开头重新打开。
 */
export function chunkText(text: string, maxChars: number): string[] {
  const limit = Math.max(50, maxChars);
  const chunks: string[] = [];
  let rest = text.trim();
  let reopen = "";
  while (rest.length > 0) {
    let piece: string;
    if (reopen.length + rest.length <= limit) {
      piece = rest;
      rest = "";
    } else {
      const cut = findCut(rest, limit - reopen.length - 4);
      piece = rest.slice(0, cut).trimEnd();
      rest = rest.slice(cut).replace(/^\n+/, "");
    }
    let chunk = reopen + piece;
    let openFence = "";
    for (const line of chunk.split("\n")) {
      if (FENCE.test(line)) openFence = openFence ? "" : line.trim();
    }
    if (openFence && rest.length > 0) {
      chunk += openFence.startsWith("~~~") ? "\n~~~" : "\n```";
      reopen = openFence + "\n";
    } else {
      reopen = "";
    }
    if (chunk.trim()) chunks.push(chunk);
  }
  return chunks;
}

/** 把 Markdown 转成适合 QQ 纯文本消息阅读的格式（保留代码块原样）。 */
export function markdownToPlain(md: string): string {
  let inFence = false;
  return md
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .replace(/^(\s*)#{1,6}\s+(.+?)\s*#*\s*$/, "$1【$2】")
        .replace(/^(\s*)[-*+]\s+/, "$1• ")
        .replace(/^(\s*)>\s?/, "$1｜")
        .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt: string, url: string) => `[图片${alt ? `:${alt}` : ""}] ${url}`)
        .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, label: string, url: string) => (label === url ? url : `${label}（${url}）`))
        .replace(/\*\*(.+?)\*\*/g, "$1");
    })
    .join("\n");
}

/** QQ 会拦截未报备的链接，发送失败时把链接里的点改成 [.] 再重试。 */
export function defangUrls(text: string): string {
  return text
    .replace(/\bhttps?:\/\/([^\s/?#）)\]]+)/gi, (_m, host: string) => host.replace(/\./g, "[.]"))
    .replace(
      /\b(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|top|ai|dev|app|xyz|me|co|info|tech|cc|tv|edu|gov|site|online|link|cloud)\b/gi,
      (m) => m.replace(/\./g, "[.]"),
    );
}
