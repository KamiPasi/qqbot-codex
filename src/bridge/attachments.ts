import fs from "node:fs";
import path from "node:path";
import type { UserInput } from "../codex/protocol.ts";
import type { QQAttachment } from "../qq/types.ts";

const MAX_BYTES = 30 * 1024 * 1024;

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
};

function normalizeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url.replace(/^\/+/, "")}`;
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(-120) || "file";
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("文件超过 30MB");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("文件超过 30MB");
  await fs.promises.writeFile(dest, buf);
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * 把 QQ 消息里的附件转成 Codex 能用的输入：图片下载后作为 localImage，
 * 其他文件下载到本地并在文字里告诉 Codex 路径，语音使用平台的识别文字。
 */
export async function prepareAttachments(
  list: QQAttachment[],
  dir: string,
  msgId: string,
): Promise<{ inputs: UserInput[]; notes: string[] }> {
  const inputs: UserInput[] = [];
  const notes: string[] = [];
  if (list.length === 0) return { inputs, notes };
  await fs.promises.mkdir(dir, { recursive: true });
  const prefix = `${Date.now()}-${safeName(msgId).slice(-10)}`;
  for (const [i, att] of list.entries()) {
    const type = (att.content_type ?? "").toLowerCase();
    if (type === "voice") {
      notes.push(att.asr_refer_text ? `[语音转文字] ${att.asr_refer_text}` : "[用户发送了一条语音，没有识别出文字]");
      continue;
    }
    if (!att.url) continue;
    const url = normalizeUrl(att.url);
    if (type.startsWith("image")) {
      const file = path.join(dir, `${prefix}-${i}${EXT_BY_TYPE[type] ?? ".jpg"}`);
      try {
        await download(url, file);
        inputs.push({ type: "localImage", path: file });
        notes.push(`[图片已保存到 ${file}]`);
      } catch (err) {
        notes.push(`[用户发送了一张图片，但下载失败：${errText(err)}]`);
      }
      continue;
    }
    if (type.startsWith("video")) {
      notes.push(`[用户发送了一个视频${att.filename ? `（${att.filename}）` : ""}，暂不支持查看]`);
      continue;
    }
    const name = att.filename || "file";
    const file = path.join(dir, `${prefix}-${i}-${safeName(name)}`);
    try {
      await download(url, file);
      notes.push(`[用户发送了文件「${name}」，已保存到 ${file}]`);
    } catch (err) {
      notes.push(`[用户发送了文件「${name}」，但下载失败：${errText(err)}]`);
    }
  }
  return { inputs, notes };
}
