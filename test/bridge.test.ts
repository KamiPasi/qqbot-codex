import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Bridge } from "../src/bridge/bridge.ts";
import type { CodexAppServer } from "../src/codex/appServer.ts";
import type { Config } from "../src/config.ts";
import { configureLogger } from "../src/log.ts";
import type { MessageSender, ReplyContext } from "../src/qq/sender.ts";

configureLogger({ level: "error" });

class FakeCodex {
  generation = 1;
  calls: Array<{ method: string; params: any }> = [];
  #handlers: Array<(method: string, params: any) => void> = [];
  #turn = 0;

  onNotification(handler: (method: string, params: any) => void): void {
    this.#handlers.push(handler);
  }
  onExit(): void {}
  setServerRequestHandler(): void {}

  #threads = 0;

  async request(method: string, params: any): Promise<unknown> {
    this.calls.push({ method, params });
    const thread = (id: string) => ({ id, name: null, preview: `问题-${id}`, cwd: `/w/${id}`, createdAt: 1, updatedAt: Date.now() / 1000 });
    const session = (id: string) => ({ thread: thread(id), model: "gpt-test", reasoningEffort: "medium", cwd: `/w/${id}`, sandbox: { type: "x" } });
    switch (method) {
      case "thread/start":
        return session(`t${++this.#threads}`);
      case "thread/resume":
        return session(params.threadId);
      case "thread/read":
        return { thread: thread(params.threadId) };
      case "thread/list":
        return { data: [thread("desk1"), thread("t1")] };
      case "thread/turns/list":
        return {
          data: [
            {
              id: "old",
              items: [
                { type: "userMessage", content: [{ type: "text", text: "旧问题" }] },
                { type: "agentMessage", phase: "final_answer", text: "旧回答" },
              ],
            },
          ],
        };
      case "turn/start":
        this.#turn++;
        return { turn: { id: `turn${this.#turn}`, status: "inProgress", items: [], error: null } };
      default:
        return {};
    }
  }

  emit(method: string, params: any): void {
    for (const h of this.#handlers) h(method, params);
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

class FakeSender {
  sent: Array<{ to: string; text: string }> = [];
  async send(ctx: ReplyContext, text: string): Promise<boolean> {
    this.sent.push({ to: ctx.msgId ?? "", text });
    return true;
  }
  async sendTyping(): Promise<void> {}
  texts(): string[] {
    return this.sent.map((s) => s.text);
  }
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-test-"));
  const config: Config = {
    rootDir: dir,
    dataDir: dir,
    logLevel: "error",
    qq: {
      appId: "1",
      appSecret: "s",
      apiBase: "",
      tokenUrl: "",
      intents: 0,
      intentNames: [],
      allowedUsers: new Set(["U1"]),
      allowedGroups: new Set(["G1"]),
      markdown: "off",
      progress: true,
      groupSession: "shared",
      maxChunkChars: 1800,
      maxChunks: 5,
    },
    codex: { cwd: dir, approvalPolicy: "never", extraInstructions: "", maxConcurrent: 2, turnTimeoutMs: 60_000 },
  };
  const codex = new FakeCodex();
  const sender = new FakeSender();
  const bridge = new Bridge({
    config,
    codex: codex as unknown as CodexAppServer,
    sender: sender as unknown as MessageSender,
  });
  return { codex, sender, bridge };
}

const c2c = (id: string, user: string, content: string) => ["C2C_MESSAGE_CREATE", { id, author: { user_openid: user }, content }] as const;

test("单聊：新建线程、转发进度和最终回答", async () => {
  const { codex, sender, bridge } = setup();
  bridge.handleEvent(...c2c("m1", "U1", "你好"), "e1");
  await waitFor(() => codex.count("turn/start") === 1);
  const start = codex.calls.find((c) => c.method === "thread/start")!;
  assert.match(start.params.developerInstructions, /QQ/);
  assert.equal(codex.calls.find((c) => c.method === "turn/start")!.params.input[0].text, "你好");

  codex.emit("item/completed", { threadId: "t1", turnId: "turn1", item: { type: "agentMessage", id: "a", text: "我先看看", phase: "commentary" } });
  codex.emit("item/completed", { threadId: "t1", turnId: "turn1", item: { type: "agentMessage", id: "b", text: "答案是 42", phase: "final_answer" } });
  codex.emit("turn/completed", { threadId: "t1", turn: { id: "turn1", status: "completed", error: null, items: [] } });
  await waitFor(() => sender.texts().includes("答案是 42"));
  assert.deepEqual(sender.texts(), ["⏳ 我先看看", "答案是 42"]);

  // 同一会话继续聊：复用线程
  bridge.handleEvent(...c2c("m2", "U1", "再来"), "e2");
  await waitFor(() => codex.count("turn/start") === 2);
  assert.equal(codex.count("thread/start"), 1);
});

test("重复推送的消息只处理一次", async () => {
  const { codex, bridge } = setup();
  bridge.handleEvent(...c2c("dup", "U1", "hi"), "e1");
  bridge.handleEvent(...c2c("dup", "U1", "hi"), "e1");
  await waitFor(() => codex.count("turn/start") === 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(codex.count("turn/start"), 1);
});

test("未授权用户被拒绝，并告知 ID", async () => {
  const { codex, sender, bridge } = setup();
  bridge.handleEvent(...c2c("m1", "U9", "hi"), "e1");
  await waitFor(() => sender.sent.length === 1);
  assert.match(sender.texts()[0], /没有使用权限[\s\S]*U9/);
  assert.equal(codex.calls.length, 0);
  // /whoami 任何人都能用
  bridge.handleEvent(...c2c("m2", "U9", "/whoami"), "e2");
  await waitFor(() => sender.sent.length === 2);
  assert.match(sender.texts()[1], /U9/);
});

test("白名单群里任何人都能用，消息带发送者标记", async () => {
  const { codex, bridge } = setup();
  bridge.handleEvent("GROUP_AT_MESSAGE_CREATE", { id: "g1", group_openid: "G1", author: { member_openid: "ABCDEF123" }, content: " 查一下 " }, "e");
  await waitFor(() => codex.count("turn/start") === 1);
  assert.equal(codex.calls.find((c) => c.method === "turn/start")!.params.input[0].text, "[群成员 ABCDEF] 查一下");
});

test("任务进行中追加消息走 turn/steer，回复改用最新消息", async () => {
  const { codex, sender, bridge } = setup();
  bridge.handleEvent(...c2c("m1", "U1", "第一句"), "e1");
  await waitFor(() => codex.count("turn/start") === 1);
  bridge.handleEvent(...c2c("m2", "U1", "补充一句"), "e2");
  await waitFor(() => codex.count("turn/steer") === 1);
  assert.equal(codex.calls.find((c) => c.method === "turn/steer")!.params.expectedTurnId, "turn1");
  codex.emit("item/completed", { threadId: "t1", turnId: "turn1", item: { type: "agentMessage", id: "b", text: "好的", phase: "final_answer" } });
  codex.emit("turn/completed", { threadId: "t1", turn: { id: "turn1", status: "completed", error: null, items: [] } });
  await waitFor(() => sender.sent.length === 1);
  assert.deepEqual(sender.sent[0], { to: "m2", text: "好的" });
});

test("/stop 中断任务，/new 换新线程", async () => {
  const { codex, sender, bridge } = setup();
  bridge.handleEvent(...c2c("m1", "U1", "做个大任务"), "e1");
  await waitFor(() => codex.count("turn/start") === 1);
  bridge.handleEvent(...c2c("m2", "U1", "/stop"), "e2");
  await waitFor(() => codex.count("turn/interrupt") === 1);
  codex.emit("turn/completed", { threadId: "t1", turn: { id: "turn1", status: "interrupted", error: null, items: [] } });
  await waitFor(() => sender.texts().includes("⏹ 已停止当前任务。"));

  bridge.handleEvent(...c2c("m3", "U1", "/new"), "e3");
  await waitFor(() => sender.texts().includes("🆕 已开启新会话。"));
  bridge.handleEvent(...c2c("m4", "U1", "新问题"), "e4");
  await waitFor(() => codex.count("turn/start") === 2);
  assert.equal(codex.count("thread/start"), 2);
});

test("/threads 列出本会话线程，/switch 切回旧线程并回显上次对话", async () => {
  const { codex, sender, bridge } = setup();
  const finish = (turnId: string, threadId: string) => {
    codex.emit("item/completed", { threadId, turnId, item: { type: "agentMessage", id: turnId, text: "ok", phase: "final_answer" } });
    codex.emit("turn/completed", { threadId, turn: { id: turnId, status: "completed", error: null, items: [] } });
  };
  bridge.handleEvent(...c2c("m1", "U1", "第一个话题"), "e1");
  await waitFor(() => codex.count("turn/start") === 1);
  assert.equal(codex.calls.find((c) => c.method === "thread/name/set")!.params.name, "QQ·第一个话题");
  finish("turn1", "t1");
  await waitFor(() => sender.sent.length === 1);

  bridge.handleEvent(...c2c("m2", "U1", "/新会话 第二个话题"), "e2");
  await waitFor(() => codex.count("turn/start") === 2);
  finish("turn2", "t2");
  await waitFor(() => sender.sent.length === 2);

  bridge.handleEvent(...c2c("m3", "U1", "/threads"), "e3");
  await waitFor(() => sender.sent.length === 3);
  const listing = sender.texts()[2];
  assert.match(listing, /1\. 问题-t2 · 刚刚 ◀ 当前/);
  assert.match(listing, /2\. 问题-t1 · 刚刚/);

  bridge.handleEvent(...c2c("m4", "U1", "/切换 2"), "e4");
  await waitFor(() => sender.sent.length === 4);
  assert.equal(codex.calls.filter((c) => c.method === "thread/resume").at(-1)!.params.threadId, "t1");
  assert.match(sender.texts()[3], /已切换到：问题-t1[\s\S]*上次问：旧问题[\s\S]*上次答：旧回答/);

  bridge.handleEvent(...c2c("m5", "U1", "继续聊"), "e5");
  await waitFor(() => codex.count("turn/start") === 3);
  assert.equal(codex.calls.filter((c) => c.method === "turn/start").at(-1)!.params.threadId, "t1");
});

test("单聊可以 /threads all 切到本机其他线程，群聊不行", async () => {
  const { codex, sender, bridge } = setup();
  bridge.handleEvent(...c2c("m1", "U1", "/threads all"), "e1");
  await waitFor(() => sender.sent.length === 1);
  assert.match(sender.texts()[0], /本机最近的 Codex 线程[\s\S]*1\. 问题-desk1 · desk1/);
  bridge.handleEvent(...c2c("m2", "U1", "/switch 1"), "e2");
  await waitFor(() => sender.sent.length === 2);
  assert.match(sender.texts()[1], /已切换到：问题-desk1[\s\S]*不是在 QQ 里创建的/);

  bridge.handleEvent("GROUP_AT_MESSAGE_CREATE", { id: "g1", group_openid: "G1", author: { member_openid: "M1" }, content: "/threads all" }, "e3");
  await waitFor(() => sender.sent.length === 3);
  assert.match(sender.texts()[2], /只能在单聊里用/);
  bridge.handleEvent("GROUP_AT_MESSAGE_CREATE", { id: "g2", group_openid: "G1", author: { member_openid: "M1" }, content: "/switch desk1" }, "e4");
  await waitFor(() => sender.sent.length === 4);
  assert.match(sender.texts()[3], /没找到这个线程/);
});

test("拼错的指令直接提示，不交给 Codex；不像指令的 /xxx 照常转给 Codex", async () => {
  const { codex, sender, bridge } = setup();
  bridge.handleEvent(...c2c("m1", "U1", "/treads all"), "e1");
  await waitFor(() => sender.sent.length === 1);
  assert.equal(sender.texts()[0], "没有 /treads 这个指令，你是不是想用 /threads all？");
  bridge.handleEvent(...c2c("m2", "U1", "/stauts"), "e2");
  await waitFor(() => sender.sent.length === 2);
  assert.match(sender.texts()[1], /\/status？$/);
  assert.equal(codex.count("turn/start"), 0);

  bridge.handleEvent(...c2c("m3", "U1", "/usr/bin/python 是什么"), "e3");
  await waitFor(() => codex.count("turn/start") === 1);
});

test("失败的 turn 会把错误告诉用户", async () => {
  const { codex, sender, bridge } = setup();
  bridge.handleEvent(...c2c("m1", "U1", "hi"), "e1");
  await waitFor(() => codex.count("turn/start") === 1);
  codex.emit("turn/completed", {
    threadId: "t1",
    turn: { id: "turn1", status: "failed", error: { message: "usage limit", codexErrorInfo: null, additionalDetails: null }, items: [] },
  });
  await waitFor(() => sender.sent.length === 1);
  assert.match(sender.texts()[0], /Codex 执行失败：usage limit/);
});
