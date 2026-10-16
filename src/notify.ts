import fs from "node:fs";
import path from "node:path";
import { IMAGE_EXTS } from "./bridge/images.ts";
import type { Config } from "./config.ts";
import { createLogger } from "./log.ts";
import { createReplyContext, MAX_IMAGE_BYTES, type MessageSender } from "./qq/sender.ts";
import { SCENE_LABEL } from "./qq/types.ts";
import { chunkText, shortId } from "./util.ts";

const log = createLogger("notify");

/** 一次最多附带几张图片，和机器人回复的上限一致 */
export const MAX_NOTIFY_IMAGES = 3;

/** 参数、配置或图片有问题，一条消息都没发 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface NotifyArgs {
  text: string;
  to?: string;
  group?: string;
  images: string[];
  dryRun: boolean;
  help: boolean;
}

export interface NotifyTarget {
  scene: "c2c" | "group";
  id: string;
}

export interface NotifyPlan {
  target: NotifyTarget;
  /** 依次发送的文字，多条时已加上【序号/总数】 */
  texts: string[];
  /** 图片的绝对路径，文字发完后再发 */
  images: string[];
  /** 内容太长被截断时，完整内容存到这个文件 */
  fullText?: { file: string; text: string };
}

export interface NotifyResult {
  texts: number;
  images: number;
  /** 没发出去的内容和原因 */
  failures: string[];
  /** 文字发送失败时的原始错误；文字失败后不再发后面的内容 */
  error?: unknown;
}

type NotifyConfig = {
  dataDir: string;
  qq: Pick<Config["qq"], "allowedUsers" | "allowedGroups" | "maxChunkChars" | "maxChunks">;
};

const VALUE_OPTIONS = new Set(["--to", "--group", "--image", "--file"]);

/** 解析命令行参数。消息文字直接写在参数里，或者用 --file 从文件读（内容多行、带引号时更方便）。 */
export function parseNotifyArgs(argv: string[], cwd = process.cwd()): NotifyArgs {
  const args: NotifyArgs = { text: "", images: [], dryRun: false, help: false };
  const words: string[] = [];
  let file: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      words.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!VALUE_OPTIONS.has(name)) throw new UsageError(`不认识的参数：${arg}（用 --help 查看用法）`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (!value || (eq === -1 && value.startsWith("--"))) throw new UsageError(`${name} 后面要跟一个值`);
    if (name === "--to") args.to = value;
    else if (name === "--group") args.group = value;
    else if (name === "--image") args.images.push(value);
    else file = value;
  }
  if (file === undefined) {
    args.text = words.join(" ");
  } else {
    if (words.length) throw new UsageError("消息文字和 --file 只能用一个");
    try {
      args.text = fs.readFileSync(path.resolve(cwd, file), "utf8").replace(/^﻿/, "");
    } catch (err) {
      throw new UsageError(`读取 ${file} 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return args;
}

/** 决定发给谁：--to / --group 必须在白名单里；都没填时发给白名单里唯一的用户。 */
export function resolveTarget(
  args: Pick<NotifyArgs, "to" | "group">,
  qq: Pick<Config["qq"], "allowedUsers" | "allowedGroups">,
): NotifyTarget {
  if (args.to && args.group) throw new UsageError("--to 和 --group 只能选一个");
  if (args.group) {
    if (!qq.allowedGroups.has("*") && !qq.allowedGroups.has(args.group)) {
      throw new UsageError(`群 ${shortId(args.group)} 不在 QQ_ALLOWED_GROUPS 里，不能发送`);
    }
    return { scene: "group", id: args.group };
  }
  if (args.to) {
    if (!qq.allowedUsers.has("*") && !qq.allowedUsers.has(args.to)) {
      throw new UsageError(`用户 ${shortId(args.to)} 不在 QQ_ALLOWED_USERS 里，不能发送`);
    }
    return { scene: "c2c", id: args.to };
  }
  const users = [...qq.allowedUsers].filter((id) => id !== "*");
  if (users.length === 1) return { scene: "c2c", id: users[0] };
  if (qq.allowedUsers.has("*")) throw new UsageError("QQ_ALLOWED_USERS 允许所有人（*），请用 --to 指定发给谁");
  throw new UsageError(
    users.length === 0
      ? "QQ_ALLOWED_USERS 里没有用户，不知道发给谁：先给机器人发 /whoami 拿到 ID，填进 .env"
      : `QQ_ALLOWED_USERS 里有 ${users.length} 个用户，请用 --to 指定发给谁`,
  );
}

/** 检查要附带的图片，返回绝对路径。有一张发不了就报错，免得发出去的消息缺图。 */
export function checkImages(files: string[], cwd = process.cwd()): string[] {
  if (files.length > MAX_NOTIFY_IMAGES) throw new UsageError(`一次最多附带 ${MAX_NOTIFY_IMAGES} 张图片`);
  return files.map((f) => {
    const file = path.resolve(cwd, f);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new UsageError(`找不到图片：${file}`);
    }
    if (!stat.isFile()) throw new UsageError(`不是文件：${file}`);
    if (!IMAGE_EXTS.has(path.extname(file).toLowerCase())) throw new UsageError(`只支持 png/jpg/gif/webp 格式的图片：${file}`);
    if (stat.size > MAX_IMAGE_BYTES) throw new UsageError(`图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB：${file}`);
    return file;
  });
}

function stamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 整理要发的内容：长文字按机器人回复的规则分段，超过条数上限时截断，完整内容存到本机。 */
export function planNotification(args: NotifyArgs, config: NotifyConfig, now = new Date()): NotifyPlan {
  const target = resolveTarget(args, config.qq);
  const images = checkImages(args.images);
  const text = args.text.trim();
  if (!text && images.length === 0) throw new UsageError("没有要发送的内容：把文字写在参数里，或者用 --file / --image");
  const { maxChunkChars, maxChunks } = config.qq;
  let chunks = text ? chunkText(text, maxChunkChars) : [];
  let fullText: NotifyPlan["fullText"];
  if (chunks.length > maxChunks) {
    fullText = { file: path.join(config.dataDir, "replies", `${stamp(now)}-notify.md`), text };
    chunks = chunks.slice(0, maxChunks);
    chunks[maxChunks - 1] += `\n\n…（内容太长已截断，完整内容保存在本机：${fullText.file}）`;
  }
  const texts = chunks.map((c, i) => (chunks.length > 1 ? `【${i + 1}/${chunks.length}】\n${c}` : c));
  return { target, texts, images, fullText };
}

export function targetLabel(target: NotifyTarget): string {
  return `${SCENE_LABEL[target.scene]} ${shortId(target.id)}`;
}

/** 试运行时显示会发给谁、发什么 */
export function describePlan(plan: NotifyPlan): string {
  const lines = [`（试运行，没有真的发送）发给：${targetLabel(plan.target)}`];
  for (const [i, text] of plan.texts.entries()) lines.push("", `—— 第 ${i + 1} 条，${text.length} 字 ——`, text);
  for (const file of plan.images) lines.push("", `—— 图片：${file}（${Math.ceil(fs.statSync(file).size / 1024)}KB）`);
  if (plan.fullText) lines.push("", `完整内容会保存到：${plan.fullText.file}`);
  return lines.join("\n");
}

export function describeResult(plan: NotifyPlan, result: NotifyResult): string {
  const parts = [result.texts && `文字 ${result.texts} 条`, result.images && `图片 ${result.images} 张`].filter(Boolean);
  return parts.length ? `已发送到 ${targetLabel(plan.target)}：${parts.join("，")}` : `没有发出任何内容（发给 ${targetLabel(plan.target)}）`;
}

function errText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err.cause as { code?: string } | undefined)?.code; // fetch failed 的具体原因，如 ENOTFOUND
  return cause ? `${err.message}（${cause}）` : err.message;
}

/** 发送：先发文字再发图片，没有 msg_id，都是主动消息。文字发送失败就停下；某张图片失败不影响后面的图片。 */
export async function sendNotification(sender: MessageSender, plan: NotifyPlan): Promise<NotifyResult> {
  if (plan.fullText) {
    try {
      fs.mkdirSync(path.dirname(plan.fullText.file), { recursive: true });
      fs.writeFileSync(plan.fullText.file, plan.fullText.text);
    } catch (err) {
      log.warn(`保存完整内容失败：${plan.fullText.file}`, errText(err));
    }
  }
  const ctx = createReplyContext(plan.target.scene, plan.target.id, {});
  const result: NotifyResult = { texts: 0, images: 0, failures: [] };
  for (const text of plan.texts) {
    try {
      await sender.send(ctx, text);
    } catch (err) {
      const sent = result.texts ? `（前 ${result.texts} 条已发出）` : "";
      result.failures.push(`第 ${result.texts + 1}/${plan.texts.length} 条文字发送失败${sent}：${errText(err)}`);
      result.error = err;
      return result;
    }
    result.texts++;
  }
  for (const file of plan.images) {
    try {
      await sender.sendImage(ctx, file);
      result.images++;
    } catch (err) {
      result.failures.push(`图片 ${path.basename(file)} 发送失败：${errText(err)}`);
    }
  }
  return result;
}
