import { createLogger } from "../log.ts";
import type { AccessTokenManager } from "./token.ts";

const log = createLogger("qq-api");

export class QQApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  /** 平台返回的原始错误信息 */
  readonly serverMessage: string;
  readonly traceId: string | undefined;

  constructor(opts: { method: string; path: string; status: number; code?: number; message?: string; traceId?: string }) {
    super(
      `${opts.method} ${opts.path} 失败：HTTP ${opts.status}` +
        (opts.code !== undefined ? ` code=${opts.code}` : "") +
        (opts.message ? ` ${opts.message}` : "") +
        (opts.traceId ? ` (trace ${opts.traceId})` : ""),
    );
    this.name = "QQApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.serverMessage = opts.message ?? "";
    this.traceId = opts.traceId;
  }
}

export interface SendResult {
  id?: string;
  timestamp?: string;
}

/** QQ 机器人 OpenAPI（https://api.bot.qq.com）的最小封装。 */
export class QQApi {
  #base: string;
  #appId: string;
  #tokens: AccessTokenManager;

  constructor(opts: { apiBase: string; appId: string; tokens: AccessTokenManager }) {
    this.#base = opts.apiBase;
    this.#appId = opts.appId;
    this.#tokens = opts.tokens;
  }

  async request<T>(method: string, path: string, body?: unknown, retryAuth = true): Promise<T> {
    const token = await this.#tokens.getToken();
    const res = await fetch(this.#base + path, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        "X-Union-Appid": this.#appId,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let data: any;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (res.status === 401 && retryAuth) {
      log.warn(`${method} ${path} 返回 401，刷新 token 后重试`);
      await this.#tokens.getToken(true);
      return this.request<T>(method, path, body, false);
    }
    const bodyCode = data && typeof data === "object" ? (data.code ?? data.err_code) : undefined;
    const isError = !res.ok || (typeof bodyCode === "number" && bodyCode !== 0 && typeof data.message === "string" && !data.id);
    if (isError) {
      throw new QQApiError({
        method,
        path,
        status: res.status,
        code: typeof bodyCode === "number" ? bodyCode : undefined,
        message: typeof data === "object" ? data?.message : String(data ?? "").slice(0, 200),
        traceId: res.headers.get("x-tps-trace-id") ?? (typeof data === "object" ? data?.trace_id : undefined) ?? undefined,
      });
    }
    return data as T;
  }

  getMe(): Promise<{ id: string; username: string; share_url?: string }> {
    return this.request("GET", "/users/@me");
  }

  getGatewayBot(): Promise<{ url: string; shards: number; session_start_limit?: Record<string, number> }> {
    return this.request("GET", "/gateway/bot");
  }

  sendC2C(openid: string, body: object): Promise<SendResult> {
    return this.request("POST", `/v2/users/${encodeURIComponent(openid)}/messages`, body);
  }

  sendGroup(groupOpenid: string, body: object): Promise<SendResult> {
    return this.request("POST", `/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, body);
  }

  sendChannel(channelId: string, body: object): Promise<SendResult> {
    return this.request("POST", `/channels/${encodeURIComponent(channelId)}/messages`, body);
  }

  sendDms(guildId: string, body: object): Promise<SendResult> {
    return this.request("POST", `/dms/${encodeURIComponent(guildId)}/messages`, body);
  }
}
