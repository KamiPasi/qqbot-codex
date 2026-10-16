import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Bridge } from "../src/bridge/bridge.ts";
import type { CodexAppServer } from "../src/codex/appServer.ts";
import type { Config } from "../src/config.ts";
import { configureLogger } from "../src/log.ts";
import type { QQApi } from "../src/qq/api.ts";
import { MessageSender, type ReplyContext } from "../src/qq/sender.ts";
import { FakeQQApi } from "./fakeQQApi.ts";

configureLogger({ level: "error" });

/** 1×1 的 PNG */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

class FakeCodex {
  generation = 1;
  /** thread/start、thread/resume 返回的工作目录；不设置时是假的 /w/线程ID */
  cwd: string | undefined;
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
    const session = (id: string) => ({
      thread: thread(id),
      model: "gpt-test",
      reasoningEffort: "medium",
      cwd: this.cwd ?? `/w/${id}`,
      sandbox: { type: "x" },
    });
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
  /** 发送时会失败的图片 */
  failImages = new Set<string>();
  async send(ctx: ReplyContext, text: string): Promise<boolean> {
    this.sent.push({ to: ctx.msgId ?? "", text });
    return true;
  }
  /** 图片也记在 sent 里，方便检查和文字的先后顺序 */
  async sendImage(ctx: ReplyContext, file: string): Promise<void> {
    if (this.failImages.has(file)) throw new Error("上传失败");
    this.sent.push({ to: ctx.msgId ?? "", text: `<图片 ${file}>` });
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

/** 默认用 FakeSender；也可以传入真正的 MessageSender（配合 FakeQQApi）测到 QQ 接口这一层 */
function setup<S extends object = FakeSender>(sender: S = new FakeSender() as unknown as S) {
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
  const bridge = new Bridge({
    config,
    codex: codex as unknown as CodexAppServer,
    sender: sender as unknown as MessageSender,
  });
  return { codex, sender, bridge, dir };
}

const c2c = (id: string, user: string, content: string) => ["C2C_MESSAGE_CREATE", { id, author: { user_openid: user }, content }] as const;

/** Codex 给出最终回答并结束本轮 */
function finishTurn(codex: FakeCodex, threadId: string, turnId: string, text: string): void {
  codex.emit("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `${turnId}-a`, text, phase: "final_answer" } });
  codex.emit("turn/completed", { threadId, turn: { id: turnId, status: "completed", error: null, items: [] } });
}

test("单聊：新建线程、转发进度和最终回答", async () => {
  const { codex, sender, bridge } = setup();
  bridge.handleEvent(...c2c("m1", "U1", "你好"), "e1");
  await waitFor(() => codex.count("turn/start") === 1);
  const start = codex.calls.find((c) => c.method === "thread/start")!;
  assert.match(start.params.developerInstructions, /QQ/);
  assert.match(start.params.developerInstructions, /`!\[说明\]\(图片的绝对路径\)`/);
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

test("收到图片：下载到 data/attachments，作为 localImage 交给 Codex", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/a.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(PNG);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { codex, bridge, dir } = setup();
  bridge.handleEvent(
    "C2C_MESSAGE_CREATE",
    {
      id: "m1",
      author: { user_openid: "U1" },
      content: "图里写了什么",
      attachments: [
        { content_type: "image/png", filename: "a.png", url: `${base}/a.png` },
        { content_type: "image/jpeg", filename: "gone.jpg", url: `${base}/gone.jpg` },
      ],
    },
    "e1",
  );
  await waitFor(() => codex.count("turn/start") === 1);
  const [text, ...images] = codex.calls.find((c) => c.method === "turn/start")!.params.input;
  assert.equal(images.length, 1);
  assert.equal(images[0].type, "localImage");
  assert.equal(path.dirname(images[0].path), path.join(dir, "attachments"));
  assert.equal(path.extname(images[0].path), ".png");
  assert.deepEqual(fs.readFileSync(images[0].path), PNG);
  assert.equal(text.text, `图里写了什么\n[图片已保存到 ${images[0].path}]\n[用户发送了一张图片，但下载失败：HTTP 404]`);
});

test("回复里引用本机图片：先发文字，再逐张发图片，文字里换成说明", async () => {
  const { codex, sender, bridge, dir } = setup();
  codex.cwd = dir;
  const chart = path.join(dir, "chart.png");
  const pie = path.join(dir, "out", "pie.jpg");
  fs.writeFileSync(chart, PNG);
  fs.mkdirSync(path.dirname(pie));
  fs.writeFileSync(pie, PNG);
  bridge.handleEvent(...c2c("m1", "U1", "画两张图"), "e1");
  await waitFor(() => codex.count("turn/start") === 1);
  // 相对路径基于 Codex 的工作目录；同一张图只发一次
  finishTurn(codex, "t1", "turn1", `趋势：\n![销售趋势](${chart})\n占比：![](out/pie.jpg)\n再看一次：![销售趋势](${chart})`);
  await waitFor(() => sender.sent.length === 3);
  assert.deepEqual(sender.texts(), [
    "趋势：\n[图片1：销售趋势]\n占比：[图片2：pie.jpg]\n再看一次：[图片1：销售趋势]",
    `<图片 ${chart}>`,
    `<图片 ${pie}>`,
  ]);
  assert.ok(sender.sent.every((s) => s.to === "m1"));
});

test("回复里的图片不存在或发送失败时，在文字里告诉用户文件路径", async () => {
  const { codex, sender, bridge, dir } = setup();
  const missing = path.join(dir, "missing.png");
  const broken = path.join(dir, "broken.png");
  fs.writeFileSync(broken, PNG);
  sender.failImages.add(broken);
  bridge.handleEvent(...c2c("m1", "U1", "画图"), "e1");
  await waitFor(() => codex.count("turn/start") === 1);
  finishTurn(codex, "t1", "turn1", `图一：![趋势](${missing})\n图二：![占比](${broken})\n语法是 \`![说明](路径)\``);
  await waitFor(() => sender.sent.length === 2);
  assert.deepEqual(sender.texts(), [
    `图一：[图片「趋势」无法发送：找不到文件 ${missing}]\n图二：[图片：占比]\n语法是 \`![说明](路径)\``,
    `⚠️ 图片「占比」发送失败（上传失败），文件在本机：${broken}`,
  ]);
});

test("回复只有图片时不再单独发文字；频道里只给出图片路径", async () => {
  const { codex, sender, bridge, dir } = setup();
  const chart = path.join(dir, "chart.png");
  fs.writeFileSync(chart, PNG);
  bridge.handleEvent("GROUP_AT_MESSAGE_CREATE", { id: "g1", group_openid: "G1", author: { member_openid: "M1" }, content: "画图" }, "e1");
  await waitFor(() => codex.count("turn/start") === 1);
  finishTurn(codex, "t1", "turn1", `![趋势](${chart})`);
  await waitFor(() => sender.sent.length === 1);
  assert.deepEqual(sender.texts(), [`<图片 ${chart}>`]);

  bridge.handleEvent("AT_MESSAGE_CREATE", { id: "c1", channel_id: "C1", author: { id: "U1" }, content: "<@!42> 画图" }, "e2");
  await waitFor(() => codex.count("turn/start") === 2);
  const channelStart = codex.calls.filter((c) => c.method === "thread/start")[1];
  assert.doesNotMatch(channelStart.params.developerInstructions, /!\[说明\]/);
  finishTurn(codex, "t2", "turn2", `![趋势](${chart})`);
  await waitFor(() => sender.sent.length === 2);
  assert.equal(sender.texts()[1], `[图片「趋势」无法发送：频道里暂不支持发图片，文件在 ${chart}]`);
});

test("发图片端到端：真正的 MessageSender 先发文字，再上传图片、发 msg_type=7", async () => {
  const api = new FakeQQApi();
  const { codex, bridge, dir } = setup(new MessageSender({ api: api as unknown as QQApi, markdown: "off" }));
  const chart = path.join(dir, "chart.png");
  fs.writeFileSync(chart, PNG);
  bridge.handleEvent(...c2c("m1", "U1", "画图"), "e1");
  await waitFor(() => codex.count("turn/start") === 1);
  finishTurn(codex, "t1", "turn1", `结果如下：![趋势](${chart})`);
  await waitFor(() => api.calls.some((c) => c.body.msg_type === 7));
  const calls = api.calls.filter((c) => c.body.msg_type !== 6); // 去掉“正在输入”
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.target}`),
    ["sendC2C U1", "uploadC2CFile U1", "sendC2C U1"],
  );
  assert.equal(calls[0].body.content, "结果如下：[图片：趋势]");
  assert.equal(calls[1].body.file_name, "chart.png");
  assert.deepEqual(Buffer.from(calls[1].body.file_data, "base64"), PNG);
  assert.deepEqual(calls[2].body.media, { file_info: "info1" });
  assert.equal(calls[2].body.msg_id, "m1");
});
