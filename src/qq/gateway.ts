import { createLogger } from "../log.ts";
import { FatalError } from "../util.ts";
import type { QQApi } from "./api.ts";
import type { AccessTokenManager } from "./token.ts";
import type { GatewayPayload } from "./types.ts";

const log = createLogger("qq-gateway");

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** 这些关闭码重试也没用，直接报错退出。 */
const FATAL_CLOSE: Record<number, string> = {
  4001: "无效的 opcode",
  4002: "无效的 payload",
  4010: "无效的 shard",
  4011: "连接需要处理的频道过多，需要分片",
  4012: "无效的 version",
  4013: "无效的 intent",
  4014: "intent 无权限：QQ_INTENTS 里有机器人没开通的事件",
  4914: "机器人已下架，只允许连接沙箱环境",
  4915: "机器人已被封禁",
};

export interface GatewayOptions {
  api: QQApi;
  tokens: AccessTokenManager;
  intents: number;
  onDispatch: (type: string, data: any, eventId: string | undefined) => void;
  onReady?: (user: { id: string; username: string }) => void;
  onFatal?: (reason: string) => void;
}

/** QQ 机器人 WebSocket 网关：鉴权、心跳、断线重连与会话恢复。 */
export class QQGateway {
  #opts: GatewayOptions;
  #ws: WebSocket | undefined;
  #sessionId: string | undefined;
  #seq: number | null = null;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #helloTimer: NodeJS.Timeout | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #ackPending = false;
  #attempt = 0;
  #stopped = true;

  constructor(opts: GatewayOptions) {
    this.#opts = opts;
  }

  start(): void {
    this.#stopped = false;
    void this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimers();
    clearTimeout(this.#reconnectTimer);
    this.#ws?.close(1000, "shutdown");
    this.#ws = undefined;
  }

  async #connect(): Promise<void> {
    this.#reconnectTimer = undefined;
    if (this.#stopped) return;
    let url: string;
    try {
      url = (await this.#opts.api.getGatewayBot()).url;
    } catch (err) {
      if (err instanceof FatalError) return this.#fatal(err.message);
      log.error("获取网关地址失败", err instanceof Error ? err.message : err);
      this.#scheduleReconnect();
      return;
    }
    if (this.#stopped) return;
    log.info(`连接网关 ${url}${this.#sessionId ? "（尝试恢复会话）" : ""}`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      log.error("创建 WebSocket 失败", err);
      this.#scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    this.#helloTimer = setTimeout(() => {
      if (ws === this.#ws) {
        log.warn("30 秒内没有收到 Hello，重新连接");
        ws.close(4000, "hello timeout");
      }
    }, 30_000);
    ws.addEventListener("message", (ev) => this.#onMessage(ws, ev.data));
    ws.addEventListener("close", (ev) => this.#onClose(ws, ev.code, ev.reason));
    ws.addEventListener("error", (ev) => {
      if (ws === this.#ws) log.warn(`WebSocket 错误：${(ev as { message?: string }).message ?? ev.type}`);
    });
  }

  #send(ws: WebSocket, payload: GatewayPayload): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      log.warn("发送网关消息失败", err instanceof Error ? err.message : err);
    }
  }

  #onMessage(ws: WebSocket, raw: unknown): void {
    if (ws !== this.#ws) return;
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer));
    } catch {
      log.warn("无法解析网关消息");
      return;
    }
    switch (payload.op) {
      case OP.HELLO:
        clearTimeout(this.#helloTimer);
        this.#startHeartbeat(ws, Number(payload.d?.heartbeat_interval) || 45_000);
        void this.#authenticate(ws);
        break;
      case OP.DISPATCH:
        if (typeof payload.s === "number") this.#seq = payload.s;
        this.#onDispatch(payload);
        break;
      case OP.HEARTBEAT_ACK:
        this.#ackPending = false;
        break;
      case OP.HEARTBEAT:
        this.#send(ws, { op: OP.HEARTBEAT, d: this.#seq });
        break;
      case OP.RECONNECT:
        log.info("服务端要求重连");
        ws.close(4000, "reconnect requested");
        break;
      case OP.INVALID_SESSION:
        log.warn("会话无效，将重新鉴权");
        this.#sessionId = undefined;
        this.#seq = null;
        ws.close(4000, "invalid session");
        break;
      default:
        log.debug(`未处理的网关 op=${payload.op}`);
    }
  }

  async #authenticate(ws: WebSocket): Promise<void> {
    let token: string;
    try {
      token = await this.#opts.tokens.getToken();
    } catch (err) {
      if (err instanceof FatalError) return this.#fatal(err.message);
      log.error("获取 access_token 失败", err instanceof Error ? err.message : err);
      ws.close(4000, "token error");
      return;
    }
    if (ws !== this.#ws) return;
    if (this.#sessionId && this.#seq !== null) {
      this.#send(ws, { op: OP.RESUME, d: { token: `QQBot ${token}`, session_id: this.#sessionId, seq: this.#seq } });
    } else {
      this.#send(ws, {
        op: OP.IDENTIFY,
        d: {
          token: `QQBot ${token}`,
          intents: this.#opts.intents,
          shard: [0, 1],
          properties: { $os: process.platform, $browser: "qqbot-codex", $device: "qqbot-codex" },
        },
      });
    }
  }

  #onDispatch(p: GatewayPayload): void {
    if (p.t === "READY") {
      this.#sessionId = p.d?.session_id;
      this.#attempt = 0;
      const user = { id: String(p.d?.user?.id ?? ""), username: String(p.d?.user?.username ?? "") };
      log.info(`网关鉴权成功：${user.username} (${user.id})`);
      this.#opts.onReady?.(user);
      return;
    }
    if (p.t === "RESUMED") {
      this.#attempt = 0;
      log.info("网关会话已恢复");
      return;
    }
    try {
      this.#opts.onDispatch(p.t ?? "", p.d, p.id);
    } catch (err) {
      log.error(`处理事件 ${p.t} 出错`, err);
    }
  }

  #startHeartbeat(ws: WebSocket, interval: number): void {
    clearInterval(this.#heartbeatTimer);
    this.#ackPending = false;
    this.#heartbeatTimer = setInterval(() => {
      if (ws !== this.#ws || ws.readyState !== WebSocket.OPEN) return;
      if (this.#ackPending) {
        log.warn("心跳无响应，重新连接");
        ws.close(4000, "heartbeat timeout");
        return;
      }
      this.#ackPending = true;
      this.#send(ws, { op: OP.HEARTBEAT, d: this.#seq });
    }, interval);
  }

  #clearTimers(): void {
    clearInterval(this.#heartbeatTimer);
    clearTimeout(this.#helloTimer);
    this.#heartbeatTimer = undefined;
    this.#helloTimer = undefined;
  }

  #onClose(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.#ws) return;
    this.#clearTimers();
    this.#ws = undefined;
    if (this.#stopped) return;
    const fatal = FATAL_CLOSE[code];
    if (fatal) return this.#fatal(`网关连接被关闭 code=${code}：${fatal}`);
    // 4006/4007 与 49xx 内部错误：会话不能恢复，需要重新 identify
    if (code === 4006 || code === 4007 || (code >= 4900 && code <= 4913)) {
      this.#sessionId = undefined;
      this.#seq = null;
    }
    log.warn(`网关连接断开 code=${code}${reason ? ` ${reason}` : ""}`);
    this.#scheduleReconnect();
  }

  /** 重试解决不了的错误（凭据错误、机器人被封禁等）：不再重连，交给上层退出 */
  #fatal(reason: string): void {
    log.error(reason);
    this.stop();
    this.#opts.onFatal?.(reason);
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.#attempt, 6));
    this.#attempt++;
    log.info(`${Math.round(delay / 1000)} 秒后重连`);
    this.#reconnectTimer = setTimeout(() => void this.#connect(), delay);
  }
}
