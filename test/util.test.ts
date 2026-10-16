import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIntents } from "../src/config.ts";
import { canReplyPassively, createReplyContext } from "../src/qq/sender.ts";
import { chunkText, defangUrls, LruSet, markdownToPlain, Semaphore } from "../src/util.ts";

test("chunkText 短文本原样返回", () => {
  assert.deepEqual(chunkText("hello", 100), ["hello"]);
});

test("chunkText 按段落切分且不超长、不丢内容", () => {
  const text = Array.from({ length: 10 }, (_, i) => `第${i}段：${"内容".repeat(20)}`).join("\n\n");
  const chunks = chunkText(text, 200);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 200, `chunk too long: ${c.length}`);
  assert.equal(chunks.join("").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
});

test("chunkText 在代码块中切分时补齐围栏", () => {
  const code = Array.from({ length: 40 }, (_, i) => `print(${i})`).join("\n");
  const chunks = chunkText(`示例：\n\`\`\`python\n${code}\n\`\`\`\n结束`, 150);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    const fences = c.split("\n").filter((l) => l.trim().startsWith("```")).length;
    assert.equal(fences % 2, 0, `围栏不成对：\n${c}`);
    assert.ok(c.length <= 150);
  }
  assert.ok(chunks[1].startsWith("```python\n"));
});

test("chunkText 超长单行硬切", () => {
  const chunks = chunkText("x".repeat(1000), 300);
  assert.equal(chunks.join(""), "x".repeat(1000));
  assert.ok(chunks.every((c) => c.length <= 300));
});

test("markdownToPlain 转换常见语法、保留代码块", () => {
  const md = "# 标题\n**粗体** 和 [链接](https://a.com)\n- 项目\n```js\n**not bold**\n```";
  assert.equal(markdownToPlain(md), "【标题】\n粗体 和 链接（https://a.com）\n• 项目\n```js\n**not bold**\n```");
});

test("defangUrls 处理链接但不误伤文件名", () => {
  assert.equal(
    defangUrls("见 https://www.example.com/a?b=1 和 docs.qq.com"),
    "见 www[.]example[.]com/a?b=1 和 docs[.]qq[.]com",
  );
  assert.equal(defangUrls("文件 main.py 和 config.toml"), "文件 main.py 和 config.toml");
});

test("parseIntents 支持名称和数字", () => {
  assert.equal(parseIntents("GROUP_AND_C2C_EVENT,PUBLIC_GUILD_MESSAGES").bits, (1 << 25) | (1 << 30));
  assert.equal(parseIntents("33554432").bits, 1 << 25);
  assert.throws(() => parseIntents("NOPE"));
});

test("被动回复的有效期和次数", () => {
  const ctx = createReplyContext("group", "g", { msgId: "m" });
  assert.ok(canReplyPassively(ctx));
  ctx.passiveCount = 5;
  assert.ok(!canReplyPassively(ctx));

  const old = createReplyContext("group", "g", { msgId: "m" });
  old.receivedAt -= 5 * 60_000;
  assert.ok(!canReplyPassively(old));

  const c2c = createReplyContext("c2c", "u", { msgId: "m" });
  c2c.receivedAt -= 30 * 60_000;
  assert.ok(canReplyPassively(c2c));
  assert.ok(!canReplyPassively(createReplyContext("c2c", "u", {})));
});

test("LruSet 去重与淘汰", () => {
  const s = new LruSet(2);
  assert.ok(s.add("a"));
  assert.ok(!s.add("a"));
  assert.ok(s.add("b"));
  assert.ok(s.add("c"));
  assert.ok(s.add("a"));
});

test("Semaphore 限制并发", async () => {
  const sem = new Semaphore(1);
  const r1 = await sem.acquire();
  let got = false;
  const p2 = sem.acquire().then((release) => {
    got = true;
    return release;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(got, false);
  r1();
  (await p2)();
  assert.equal(got, true);
});
