import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { configureLogger } from "../src/log.ts";
import {
  checkImages,
  describeResult,
  MAX_NOTIFY_IMAGES,
  parseNotifyArgs,
  planNotification,
  resolveTarget,
  sendNotification,
  UsageError,
} from "../src/notify.ts";
import { QQApiError, type QQApi } from "../src/qq/api.ts";
import { MAX_IMAGE_BYTES, MessageSender } from "../src/qq/sender.ts";
import { apiError, FakeQQApi } from "./fakeQQApi.ts";

configureLogger({ level: "error" });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 1×1 的 PNG */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-notify-"));

function tempFile(name: string, data: Buffer | string = PNG): string {
  const file = path.join(tempDir(), name);
  fs.writeFileSync(file, data);
  return file;
}

function config(opts: { users?: string[]; groups?: string[]; maxChunkChars?: number; maxChunks?: number } = {}) {
  return {
    dataDir: tempDir(),
    qq: {
      allowedUsers: new Set(opts.users ?? ["U1"]),
      allowedGroups: new Set(opts.groups ?? []),
      maxChunkChars: opts.maxChunkChars ?? 1800,
      maxChunks: opts.maxChunks ?? 5,
    },
  };
}

function setup() {
  const api = new FakeQQApi();
  const sender = new MessageSender({ api: api as unknown as QQApi, markdown: "off" });
  return { api, sender };
}

test("默认发给白名单里唯一的用户，发的是不带 msg_id 的主动消息", async () => {
  const { api, sender } = setup();
  const plan = planNotification(parseNotifyArgs(["明早", "9", "点开会"]), config());
  const result = await sendNotification(sender, plan);
  assert.deepEqual(api.calls, [{ method: "sendC2C", target: "U1", body: { msg_type: 0, content: "明早 9 点开会" } }]);
  assert.deepEqual(result, { texts: 1, images: 0, failures: [] });
  assert.equal(describeResult(plan, result), "已发送到 QQ单聊 U1：文字 1 条");
});

test("发给谁：--to / --group 必须在白名单里，都没填时白名单里要正好一个用户", () => {
  const qq = (users: string[], groups: string[] = []) => ({ allowedUsers: new Set(users), allowedGroups: new Set(groups) });
  assert.deepEqual(resolveTarget({}, qq(["U1"])), { scene: "c2c", id: "U1" });
  assert.deepEqual(resolveTarget({}, qq(["*", "U1"])), { scene: "c2c", id: "U1" });
  assert.deepEqual(resolveTarget({ to: "U2" }, qq(["U1", "U2"])), { scene: "c2c", id: "U2" });
  assert.deepEqual(resolveTarget({ to: "U9" }, qq(["*"])), { scene: "c2c", id: "U9" });
  assert.deepEqual(resolveTarget({ group: "G1" }, qq(["U1"], ["G1"])), { scene: "group", id: "G1" });
  assert.throws(() => resolveTarget({ to: "U2" }, qq(["U1"])), UsageError);
  assert.throws(() => resolveTarget({ to: "U2" }, qq(["U1"])), /用户 U2 不在 QQ_ALLOWED_USERS 里/);
  assert.throws(() => resolveTarget({ group: "G2" }, qq(["U1"], ["G1"])), /群 G2 不在 QQ_ALLOWED_GROUPS 里/);
  assert.throws(() => resolveTarget({ to: "U1", group: "G1" }, qq(["U1"], ["G1"])), /只能选一个/);
  assert.throws(() => resolveTarget({}, qq(["U1", "U2"])), /有 2 个用户，请用 --to 指定/);
  assert.throws(() => resolveTarget({}, qq(["*"])), /允许所有人/);
  assert.throws(() => resolveTarget({}, qq([])), /QQ_ALLOWED_USERS 里没有用户/);
});

test("发到群：走群接口，同样是主动消息", async () => {
  const { api, sender } = setup();
  const plan = planNotification(parseNotifyArgs(["--group", "G1", "今晚停电"]), config({ groups: ["G1"] }));
  await sendNotification(sender, plan);
  assert.deepEqual(api.calls, [{ method: "sendGroup", target: "G1", body: { msg_type: 0, content: "今晚停电" } }]);
});

test("长文字按机器人回复的规则分段；超过条数上限时截断，完整内容存到本机", async () => {
  const { api, sender } = setup();
  const cfg = config({ maxChunkChars: 50, maxChunks: 2 });
  const text = Array.from({ length: 6 }, (_, i) => `第${i + 1}段：${"内容".repeat(15)}`).join("\n\n");
  const plan = planNotification(parseNotifyArgs([text]), cfg, new Date(2026, 9, 16, 9, 5, 7));
  const file = path.join(cfg.dataDir, "replies", "20261016-090507-notify.md");
  assert.equal(plan.texts.length, 2);
  assert.match(plan.texts[0], /^【1\/2】\n第1段：/);
  assert.match(plan.texts[1], /^【2\/2】\n第2段：/);
  assert.ok(plan.texts[1].endsWith(`…（内容太长已截断，完整内容保存在本机：${file}）`));
  assert.ok(!fs.existsSync(file), "整理内容时还不写文件，试运行不留下东西");
  await sendNotification(sender, plan);
  assert.equal(api.calls.length, 2);
  assert.equal(fs.readFileSync(file, "utf8"), text);
});

test("附带图片：文字发完再上传、发送图片，图片也是主动消息", async () => {
  const { api, sender } = setup();
  const plan = planNotification(parseNotifyArgs(["--image", tempFile("chart.png"), "走势图"]), config());
  const result = await sendNotification(sender, plan);
  assert.deepEqual(
    api.calls.map((c) => `${c.method} ${c.target}`),
    ["sendC2C U1", "uploadC2CFile U1", "sendC2C U1"],
  );
  assert.deepEqual(api.calls[2].body, { msg_type: 7, media: { file_info: "info1" } });
  assert.equal(describeResult(plan, result), "已发送到 QQ单聊 U1：文字 1 条，图片 1 张");
});

test("只发图片也可以；图片有问题时直接报错，一条都不发", () => {
  const cfg = config();
  assert.deepEqual(planNotification(parseNotifyArgs(["--image", tempFile("a.png")]), cfg).texts, []);
  assert.throws(() => checkImages([path.join(tempDir(), "missing.png")]), /找不到图片/);
  assert.throws(() => checkImages([tempFile("notes.txt", "hi")]), /只支持 png\/jpg\/gif\/webp/);
  assert.throws(() => checkImages([tempFile("big.png", Buffer.alloc(MAX_IMAGE_BYTES + 1))]), /图片超过 5MB/);
  const tooMany = Array.from({ length: MAX_NOTIFY_IMAGES + 1 }, () => tempFile("x.png"));
  assert.throws(() => checkImages(tooMany), /一次最多附带 3 张图片/);
  assert.throws(() => planNotification(parseNotifyArgs(["  "]), cfg), /没有要发送的内容/);
});

test("参数：--file 读文件，-- 之后都当文字，写错时报 UsageError", () => {
  const file = tempFile("msg.md", "﻿第一行\n第二行");
  assert.equal(parseNotifyArgs(["--file", file]).text, "第一行\n第二行");
  const args = parseNotifyArgs(["--to=U1", "--dry-run", "--", "--不是参数"]);
  assert.equal(args.to, "U1");
  assert.equal(args.dryRun, true);
  assert.equal(args.text, "--不是参数");
  assert.equal(parseNotifyArgs(["-h"]).help, true);
  assert.throws(() => parseNotifyArgs(["--file", file, "多余的文字"]), /消息文字和 --file 只能用一个/);
  assert.throws(() => parseNotifyArgs(["--file", path.join(tempDir(), "missing.md")]), /读取 .+ 失败/);
  assert.throws(() => parseNotifyArgs(["--bogus"]), UsageError);
  assert.throws(() => parseNotifyArgs(["--bogus"]), /不认识的参数：--bogus/);
  assert.throws(() => parseNotifyArgs(["--to"]), /--to 后面要跟一个值/);
  assert.throws(() => parseNotifyArgs(["--image", "--dry-run"]), /--image 后面要跟一个值/);
});

test("文字发送失败就停下并留下原始错误；某张图片失败不影响后面的图片", async () => {
  const first = setup();
  first.api.errors.set("sendC2C", [apiError(11255, "主动消息已关闭")]);
  const failed = await sendNotification(
    first.sender,
    planNotification(parseNotifyArgs(["--image", tempFile("a.png"), "第一条"]), config()),
  );
  assert.equal(failed.texts, 0);
  assert.match(failed.failures[0], /^第 1\/1 条文字发送失败：.*code=11255 主动消息已关闭/);
  assert.ok(failed.error instanceof QQApiError);
  assert.deepEqual(
    first.api.calls.map((c) => c.method),
    ["sendC2C"],
    "文字没发出去就不再发图片",
  );

  const second = setup();
  second.api.errors.set("uploadC2CFile", [apiError(40034001, "上传失败")]);
  const images = [tempFile("a.png"), tempFile("b.png")];
  const result = await sendNotification(
    second.sender,
    planNotification(parseNotifyArgs(["--image", images[0], "--image", images[1]]), config()),
  );
  assert.equal(result.images, 1);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /^图片 a\.png 发送失败：.*code=40034001/);
  assert.equal(result.error, undefined);
});

test("命令行：--help 正常退出；参数写错时退出码 2，不会去读 .env", async () => {
  const run = (args: string[]) => promisify(execFile)(process.execPath, [path.join(ROOT, "scripts", "notify.ts"), ...args]);
  const help = await run(["--help"]);
  assert.match(help.stdout, /^用法：node scripts\/notify\.ts/);
  await assert.rejects(run(["--bogus"]), (err: { code?: number; stderr?: string }) => {
    assert.equal(err.code, 2);
    assert.match(err.stderr ?? "", /不认识的参数：--bogus/);
    return true;
  });
});
