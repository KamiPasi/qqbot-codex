import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { acquireInstanceLock } from "../src/lock.ts";

const dir = os.tmpdir();

test("实例锁：同名锁只能拿到一次，释放后可以重新获取", async () => {
  const name = `qqbot-codex-test-${process.pid}`;
  const first = await acquireInstanceLock(name, dir);
  assert.ok(first);
  assert.equal(await acquireInstanceLock(name, dir), undefined);
  const other = await acquireInstanceLock(`${name}-other`, dir);
  assert.ok(other, "不同名字的锁互不影响");
  other.close();
  await new Promise((resolve) => first.close(resolve));
  const again = await acquireInstanceLock(name, dir);
  assert.ok(again);
  again.close();
});

test("实例锁：另一个进程拿不到同名锁", async () => {
  const name = `qqbot-codex-test-cross-${process.pid}`;
  const held = await acquireInstanceLock(name, dir);
  assert.ok(held);
  const lockUrl = pathToFileURL(path.resolve(import.meta.dirname, "../src/lock.ts")).href;
  const script = [
    `const { acquireInstanceLock } = await import(${JSON.stringify(lockUrl)});`,
    `const server = await acquireInstanceLock(${JSON.stringify(name)}, ${JSON.stringify(dir)});`,
    `console.log(server ? "acquired" : "locked");`,
  ].join("\n");
  const run = () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", script]);
  assert.equal((await run()).stdout.trim(), "locked");
  held.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await run()).stdout.trim(), "acquired");
});
