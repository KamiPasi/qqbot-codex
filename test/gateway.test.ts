import assert from "node:assert/strict";
import { after, test } from "node:test";
import { configureLogger } from "../src/log.ts";
import type { QQApi } from "../src/qq/api.ts";
import { QQGateway } from "../src/qq/gateway.ts";
import type { AccessTokenManager } from "../src/qq/token.ts";

configureLogger({ level: "error" });

/** 模拟半死的连接：close() 之后停在 CLOSING，再也不触发 close 事件 */
class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  binaryType = "blob";
  sent: Array<{ op: number; d?: any }> = [];
  closeCalls = 0;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closeCalls++;
    if (this.readyState === FakeWebSocket.OPEN) this.readyState = FakeWebSocket.CLOSING;
  }

  /** 服务端发来一条网关消息 */
  receive(payload: object): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
}

const RealWebSocket = globalThis.WebSocket;
(globalThis as any).WebSocket = FakeWebSocket;
after(() => {
  globalThis.WebSocket = RealWebSocket;
});

function createGateway(): QQGateway {
  return new QQGateway({
    api: { getGatewayBot: async () => ({ url: "wss://gateway.test", shards: 1 }) } as unknown as QQApi,
    tokens: { getToken: async () => "token" } as unknown as AccessTokenManager,
    intents: 1 << 25,
    onDispatch: () => {},
  });
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 等第 n 个连接建立，完成 Hello（心跳间隔 30ms）和鉴权 */
async function handshake(n: number): Promise<FakeWebSocket> {
  await waitFor(() => FakeWebSocket.instances.length >= n);
  const ws = FakeWebSocket.instances[n - 1];
  ws.receive({ op: 10, d: { heartbeat_interval: 30 } });
  await waitFor(() => ws.sent.some((p) => p.op === 2 || p.op === 6));
  return ws;
}

test("网关：连接卡在 CLOSING、收不到 close 事件时，心跳会丢弃它并恢复会话", async () => {
  FakeWebSocket.instances = [];
  const gateway = createGateway();
  gateway.start();
  try {
    const first = await handshake(1);
    first.receive({ op: 0, t: "READY", s: 1, d: { session_id: "s1", user: { id: "1", username: "bot" } } });
    first.readyState = FakeWebSocket.CLOSING; // 对端已经断开，但 close 事件一直不来

    const second = await handshake(2);
    const auth = second.sent.find((p) => p.op === 2 || p.op === 6);
    assert.equal(auth?.op, 6, "应该恢复会话（RESUME），而不是重新鉴权");
    assert.equal(auth?.d.session_id, "s1");
    assert.equal(auth?.d.seq, 1);
  } finally {
    gateway.stop();
  }
});

test("网关：心跳没有回应时直接重连，不等关闭握手", async () => {
  FakeWebSocket.instances = [];
  const gateway = createGateway();
  gateway.start();
  try {
    const first = await handshake(1);
    first.receive({ op: 0, t: "READY", s: 1, d: { session_id: "s1", user: { id: "1", username: "bot" } } });
    // 不回 HEARTBEAT_ACK
    await waitFor(() => FakeWebSocket.instances.length === 2);
    assert.ok(first.closeCalls > 0, "旧连接应该被关闭");
    assert.equal(first.readyState, FakeWebSocket.CLOSING, "旧连接的 close 事件始终没来，也照样重连了");
  } finally {
    gateway.stop();
  }
});
