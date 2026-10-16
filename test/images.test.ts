import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { extractReplyImages } from "../src/bridge/images.ts";

/** 建一个临时目录，按 { 相对路径: 字节数 } 创建文件 */
function tempDir(files: Record<string, number>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-images-"));
  for (const [name, size] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(size, 1));
  }
  return dir;
}

test("extractReplyImages 识别绝对路径、相对路径、file://、<路径> 和带括号的路径", () => {
  const dir = tempDir({ "a.png": 10, "sub/b.JPG": 10, "c d.webp": 10, "e.gif": 10, "f (1).jpeg": 10 });
  const text = [
    `折线图：![甲](${path.join(dir, "a.png")})`,
    "![](sub/b.JPG)",
    `![丙](<${path.join(dir, "c d.webp")}> "标题")`,
    `![丁](${pathToFileURL(path.join(dir, "e.gif")).href})`,
    `![戊](${path.join(dir, "f (1).jpeg")})`,
  ].join("\n");
  const res = extractReplyImages(text, { cwd: dir, maxImages: 5, maxBytes: 100 });
  assert.equal(res.text, "折线图：[图片1：甲]\n[图片2：b.JPG]\n[图片3：丙]\n[图片4：丁]\n[图片5：戊]");
  assert.deepEqual(
    res.images.map((i) => i.file),
    ["a.png", path.join("sub", "b.JPG"), "c d.webp", "e.gif", "f (1).jpeg"].map((f) => path.join(dir, f)),
  );
  assert.equal(res.hasText, true);
});

test("extractReplyImages 不动网络图片、普通链接和代码里的图片语法", () => {
  const dir = tempDir({ "a.png": 10 });
  const text = [
    "![logo](https://example.com/logo.png)",
    "[下载](a.png)",
    "行内：`![x](a.png)`",
    "```markdown",
    "![x](a.png)",
    "```",
  ].join("\n");
  const res = extractReplyImages(text, { cwd: dir, maxImages: 3, maxBytes: 100 });
  assert.equal(res.text, text);
  assert.deepEqual(res.images, []);
});

test("extractReplyImages 不碰 Windows 网络路径（不去访问远程共享）", { skip: process.platform !== "win32" }, () => {
  const dir = tempDir({});
  const text = "![a](\\\\server\\share\\a.png) ![b](//cdn.example.com/b.png) ![c](file://server/share/c.png)";
  const res = extractReplyImages(text, { cwd: dir, maxImages: 3, maxBytes: 100 });
  assert.equal(res.text, text);
  assert.deepEqual(res.images, []);
});

test("extractReplyImages 发不了的图片在文字里说明原因和路径，同一张图只发一次", () => {
  const MB = 1024 * 1024;
  const dir = tempDir({ "ok1.png": 10, "ok2.png": 10, "ok3.png": 10, "ok4.png": 10, "big.png": MB + 1, "vector.svg": 10 });
  const p = (name: string) => path.join(dir, name);
  const text = [
    "![一](ok1.png) ![一again](ok1.png)",
    "![不存在](nope.png)",
    "![](vector.svg)",
    "![大图](big.png)",
    "![二](ok2.png) ![三](ok3.png) ![四](ok4.png)",
  ].join("\n");
  const res = extractReplyImages(text, { cwd: dir, maxImages: 3, maxBytes: MB });
  assert.equal(
    res.text,
    [
      "[图片1：一] [图片1：一]",
      `[图片「不存在」无法发送：找不到文件 ${p("nope.png")}]`,
      `[图片无法发送：只支持 png/jpg/gif/webp 格式，文件在 ${p("vector.svg")}]`,
      `[图片「大图」无法发送：超过 1MB，文件在 ${p("big.png")}]`,
      `[图片2：二] [图片3：三] [图片「四」无法发送：一次最多发 3 张，文件在 ${p("ok4.png")}]`,
    ].join("\n"),
  );
  assert.deepEqual(
    res.images.map((i) => i.file),
    [p("ok1.png"), p("ok2.png"), p("ok3.png")],
  );

  const channel = extractReplyImages("![一](ok1.png)", { cwd: dir, maxImages: 3, maxBytes: MB, unsupported: "频道里暂不支持发图片" });
  assert.equal(channel.text, `[图片「一」无法发送：频道里暂不支持发图片，文件在 ${p("ok1.png")}]`);
  assert.deepEqual(channel.images, []);
});

test("extractReplyImages 回复里只有图片时 hasText 为 false", () => {
  const dir = tempDir({ "a.png": 10, "b.png": 10 });
  const only = extractReplyImages("![a](a.png)\n\n![b](b.png)\n", { cwd: dir, maxImages: 3, maxBytes: 100 });
  assert.equal(only.hasText, false);
  assert.equal(only.images.length, 2);
  const withMissing = extractReplyImages("![a](a.png)\n![c](c.png)", { cwd: dir, maxImages: 3, maxBytes: 100 });
  assert.equal(withMissing.hasText, true);
});
