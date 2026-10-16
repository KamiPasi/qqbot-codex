import { createLogger } from "../log.ts";
import { FatalError } from "../util.ts";

const log = createLogger("qq-token");

const AUTH_ERRORS: Record<number, string> = {
  100001: "请求过于频繁",
  100007: "AppID 无效，或机器人已被封禁/删除",
  100016: "AppID 或 AppSecret 不正确",
  10004: "机器人不存在",
};

/**
 * 管理 QQ 机器人的 access_token。
 * 平台规则：有效期内重复获取会拿到同一个 token；只有在过期前 60 秒内获取才会换新 token（旧 token 在这 60 秒内仍可用）。
 */
export class AccessTokenManager {
  #appId: string;
  #secret: string;
  #url: string;
  #token: string | undefined;
  #expiresAt = 0;
  #lastFetchAt = 0;
  #inflight: Promise<string> | undefined;

  constructor(opts: { appId: string; appSecret: string; tokenUrl: string }) {
    this.#appId = opts.appId;
    this.#secret = opts.appSecret;
    this.#url = opts.tokenUrl;
  }

  async getToken(forceRefresh = false): Promise<string> {
    const now = Date.now();
    if (this.#token && !forceRefresh) {
      if (now < this.#expiresAt - 50_000) return this.#token;
      // 临近过期时刷新，但 5 秒内不重复请求
      if (now < this.#expiresAt && now - this.#lastFetchAt < 5_000) return this.#token;
    }
    this.#inflight ??= this.#fetch().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  async #fetch(): Promise<string> {
    this.#lastFetchAt = Date.now();
    const res = await fetch(this.#url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.#appId, clientSecret: this.#secret }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let body: { access_token?: string; expires_in?: string | number; code?: number; message?: string };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`获取 access_token 失败：HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    if (!body.access_token) {
      const hint = body.code !== undefined ? AUTH_ERRORS[body.code] : undefined;
      const msg = `获取 access_token 失败：code=${body.code} ${body.message ?? ""}${hint ? `（${hint}）` : ""}`;
      // AppID/密钥错误、机器人不存在：重试没有意义
      throw body.code !== undefined && body.code !== 100001 && hint ? new FatalError(msg) : new Error(msg);
    }
    const expiresIn = Number(body.expires_in) || 7200;
    this.#token = body.access_token;
    this.#expiresAt = Date.now() + expiresIn * 1000;
    log.debug(`access_token 已获取，剩余有效期 ${expiresIn}s`);
    return this.#token;
  }
}
