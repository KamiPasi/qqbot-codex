import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configureLogger } from "../src/log.ts";
import type { QQApi } from "../src/qq/api.ts";
import { createReplyContext, MAX_IMAGE_BYTES, MessageSender } from "../src/qq/sender.ts";
import { apiError, FakeQQApi } from "./fakeQQApi.ts";

configureLogger({ level: "error" });

/** 1×1 的 PNG */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function setup(markdown: "auto" | "on" | "off" = "off") {
  const api = new FakeQQApi();
  const sender = new MessageSender({ api: api as unknown as QQApi, markdown });
  return { api, sender };
}

function tempFile(name: string, data: Buffer = PNG): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-sender-")), name);
  fs.writeFileSync(file, data);
  return file;
}

test("发图片：单聊先用 file_data 上传，再被动回复 msg_type=7", async () => {
  const { api, sender } = setup();
  const ctx = createReplyContext("c2c", "U1", { msgId: "m1" });
  await sender.send(ctx, "图来了");
  await sender.sendImage(ctx, tempFile("chart.png"));
  assert.deepEqual(
    api.calls.map((c) => `${c.method} ${c.target}`),
    ["sendC2C U1", "uploadC2CFile U1", "sendC2C U1"],
  );
  const { file_data, ...upload } = api.calls[1].body;
  assert.deepEqual(upload, { file_type: 1, srv_send_msg: false, file_name: "chart.png" });
  assert.deepEqual(Buffer.from(file_data, "base64"), PNG);
  assert.deepEqual(api.calls[2].body, { msg_type: 7, media: { file_info: "info1" }, msg_id: "m1", msg_seq: 2 });
  assert.equal(ctx.passiveCount, 2);
});

test("发图片：群聊用群接口，被动回复用完后改发主动消息", async () => {
  const { api, sender } = setup();
  const ctx = createReplyContext("group", "G1", { msgId: "g1" });
  api.errors.set("sendGroup", [apiError(40034128, "被动回复时间或次数超限")]);
  await sender.sendImage(ctx, tempFile("photo.jpg"));
  assert.deepEqual(
    api.calls.map((c) => `${c.method} ${c.target}`),
    ["uploadGroupFile G1", "sendGroup G1", "sendGroup G1"],
  );
  assert.deepEqual(api.calls[1].body, { msg_type: 7, media: { file_info: "info1" }, msg_id: "g1", msg_seq: 1 });
  // 主动消息不带 msg_id，复用同一个 file_info，不重新上传
  assert.deepEqual(api.calls[2].body, { msg_type: 7, media: { file_info: "info1" } });
  assert.ok(ctx.passiveExhausted);
});

test("发图片：频道不支持、超过 5MB 不上传、上传失败时抛出平台的错误", async () => {
  const { api, sender } = setup();
  await assert.rejects(sender.sendImage(createReplyContext("channel", "C1", { msgId: "c1" }), tempFile("a.png")), /频道暂不支持/);
  const big = tempFile("big.png", Buffer.alloc(MAX_IMAGE_BYTES + 1));
  await assert.rejects(sender.sendImage(createReplyContext("c2c", "U1", { msgId: "m1" }), big), /超过 5MB/);
  assert.equal(api.calls.length, 0);

  api.errors.set("uploadC2CFile", [apiError(850031, "上传文件超过大小限制")]);
  await assert.rejects(sender.sendImage(createReplyContext("c2c", "U1", { msgId: "m1" }), tempFile("a.png")), /上传文件超过大小限制/);
  assert.deepEqual(api.calls.map((c) => c.method), ["uploadC2CFile"]);
});

test("发文字：没有 Markdown 权限时退回纯文本，之后直接发纯文本", async () => {
  const { api, sender } = setup("auto");
  const ctx = createReplyContext("c2c", "U1", { msgId: "m1" });
  api.errors.set("sendC2C", [apiError(11253, "no permission")]);
  await sender.send(ctx, "**你好**");
  await sender.send(ctx, "**再见**");
  assert.deepEqual(
    api.calls.map((c) => c.body),
    [
      { msg_type: 2, markdown: { content: "**你好**" }, msg_id: "m1", msg_seq: 1 },
      { msg_type: 0, content: "你好", msg_id: "m1", msg_seq: 2 },
      { msg_type: 0, content: "再见", msg_id: "m1", msg_seq: 3 },
    ],
  );
});

test("发文字：链接被拦截时处理后重发，被动回复不可用时改发主动消息", async () => {
  const { api, sender } = setup();
  const ctx = createReplyContext("group", "G1", { msgId: "g1" });
  api.errors.set("sendGroup", [apiError(304003, "url not allowed"), apiError(40034128)]);
  assert.equal(await sender.send(ctx, "见 https://a.com/x"), true);
  assert.deepEqual(
    api.calls.map((c) => c.body),
    [
      { msg_type: 0, content: "见 https://a.com/x", msg_id: "g1", msg_seq: 1 },
      { msg_type: 0, content: "见 a[.]com/x", msg_id: "g1", msg_seq: 2 },
      { msg_type: 0, content: "见 a[.]com/x" },
    ],
  );
  // 进度提示这类可有可无的消息，不发主动消息
  assert.equal(await sender.send(ctx, "⏳ 处理中", { allowActive: false }), false);
  assert.equal(api.calls.length, 3);
});
