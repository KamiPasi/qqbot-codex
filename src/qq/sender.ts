import fs from "node:fs";
import path from "node:path";
import type { MarkdownMode } from "../config.ts";
import { createLogger } from "../log.ts";
import { defangUrls, markdownToPlain, sleep } from "../util.ts";
import { QQApiError, type QQApi } from "./api.ts";
import { SCENE_LABEL, type Scene } from "./types.ts";

const log = createLogger("qq-send");

/** 被动回复的有效期与每条消息可回复次数（见“消息收发概述”文档）。 */
const PASSIVE_RULES: Record<Scene, { windowMs: number; maxReplies: number }> = {
  c2c: { windowMs: 60 * 60_000, maxReplies: 4 },
  group: { windowMs: 5 * 60_000, maxReplies: 5 },
  channel: { windowMs: 5 * 60_000, maxReplies: Infinity },
  dms: { windowMs: 5 * 60_000, maxReplies: Infinity },
};
/** 留一点余量，避免压线发送时刚好过期 */
const PASSIVE_MARGIN_MS = 15_000;

/** 被动回复过期 / 次数用完 / msg_id 无效：改发主动消息 */
const PASSIVE_UNAVAILABLE = new Set([304103, 40034005, 40034024, 40034025, 40034026, 40034027, 40034128]);
/** 没有 Markdown 权限 */
const MARKDOWN_DENIED = new Set([11253, 304014, 304036, 40034124, 40034127, 50037, 50056, 50057]);
const DEDUPED = 40054005;
/** 富媒体转存失败，文档建议重试 */
const MEDIA_TRANSFER_FAILED = 40034004;
/** 上传超时、上传通道异常，文档建议稍后重试 */
const UPLOAD_RETRYABLE = new Set([850027, 40093001]);

/** 用 file_data 直接上传时，单个文件不能超过 5MB（见“单聊/群聊富媒体上传”文档） */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 一条入站消息（或事件）对应的回复上下文，记录被动回复的使用情况。 */
export interface ReplyContext {
  scene: Scene;
  /** c2c: user_openid；group: group_openid；channel: channel_id；dms: guild_id */
  targetId: string;
  msgId?: string;
  eventId?: string;
  receivedAt: number;
  seq: number;
  passiveCount: number;
  passiveExhausted: boolean;
}

export function createReplyContext(scene: Scene, targetId: string, ref: { msgId?: string; eventId?: string }): ReplyContext {
  return { scene, targetId, ...ref, receivedAt: Date.now(), seq: 0, passiveCount: 0, passiveExhausted: false };
}

export function canReplyPassively(ctx: ReplyContext, now = Date.now()): boolean {
  const rule = PASSIVE_RULES[ctx.scene];
  return (
    Boolean(ctx.msgId || ctx.eventId) &&
    !ctx.passiveExhausted &&
    ctx.passiveCount < rule.maxReplies &&
    now - ctx.receivedAt < rule.windowMs - PASSIVE_MARGIN_MS
  );
}

/** 剩余可用的被动回复次数（已过期则为 0）。 */
export function passiveRemaining(ctx: ReplyContext): number {
  return canReplyPassively(ctx) ? PASSIVE_RULES[ctx.scene].maxReplies - ctx.passiveCount : 0;
}

function isRateLimited(err: QQApiError): boolean {
  const code = err.code ?? 0;
  return err.status === 429 || code === 22009 || code === 50002 || (code >= 504000 && code <= 504999);
}

function isUrlBlocked(err: QQApiError): boolean {
  return err.code === 304003 || /url|链接/i.test(err.serverMessage);
}

/** 只有单聊和群聊能发图片（msg_type=7），频道和频道私信暂不支持。 */
export function canSendMedia(scene: Scene): boolean {
  return scene === "c2c" || scene === "group";
}

/** 负责把消息发到 QQ：被动回复优先，过期后自动改发主动消息；Markdown 不可用时退回纯文本；图片先上传再发送。 */
export class MessageSender {
  #api: QQApi;
  #markdownMode: MarkdownMode;
  #markdownDenied = new Set<Scene>();
  #markdownFailures = new Map<Scene, number>();

  constructor(opts: { api: QQApi; markdown: MarkdownMode }) {
    this.#api = opts.api;
    this.#markdownMode = opts.markdown;
  }

  #wantMarkdown(scene: Scene): boolean {
    if (scene === "dms") return false;
    if (this.#markdownMode === "off") return false;
    return this.#markdownMode === "on" || !this.#markdownDenied.has(scene);
  }

  /**
   * 发送一条消息。text 按 Markdown 书写，纯文本模式下会自动转换。
   * allowActive=false 时，被动回复不可用就放弃发送（用于进度提示等可有可无的消息）。
   */
  async send(ctx: ReplyContext, text: string, opts: { allowActive?: boolean } = {}): Promise<boolean> {
    let useMarkdown = this.#wantMarkdown(ctx.scene);
    let content = text;
    let defanged = false;
    const sent = await this.#deliver(ctx, {
      allowActive: opts.allowActive ?? true,
      build: (passive) => this.#buildBody(ctx, useMarkdown ? content : markdownToPlain(content), useMarkdown, passive),
      retry: (err) => {
        if (!defanged && isUrlBlocked(err)) {
          log.info("消息含未报备链接被拦截，处理链接后重试");
          defanged = true;
          content = defangUrls(content);
          return true;
        }
        if (useMarkdown && !isRateLimited(err)) {
          useMarkdown = false;
          this.#noteMarkdownFailure(ctx.scene, err.code ?? -1, err);
          return true;
        }
        return false;
      },
      describe: () => `${useMarkdown ? "Markdown" : "纯文本"}，${content.length} 字`,
    });
    if (sent && useMarkdown) this.#markdownFailures.set(ctx.scene, 0);
    return sent;
  }

  /**
   * 发送一张本地图片：先用 file_data 上传拿到 file_info，再发 msg_type=7 的富媒体消息。
   * 和文字一样被动回复优先，用完后改发主动消息。只支持单聊和群聊，失败时抛出异常。
   */
  async sendImage(ctx: ReplyContext, file: string): Promise<void> {
    if (!canSendMedia(ctx.scene)) throw new Error(`${SCENE_LABEL[ctx.scene]}暂不支持发送图片`);
    const data = await fs.promises.readFile(file);
    if (data.length > MAX_IMAGE_BYTES) throw new Error(`图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`);
    const name = path.basename(file);
    const fileInfo = await this.#upload(ctx, {
      file_type: 1,
      srv_send_msg: false,
      file_name: name,
      file_data: data.toString("base64"),
    });
    let retried = false;
    await this.#deliver(ctx, {
      allowActive: true,
      build: (passive) => this.#withReplyRef(ctx, { msg_type: 7, media: { file_info: fileInfo } }, passive),
      retry: (err) => {
        if (err.code !== MEDIA_TRANSFER_FAILED || retried) return false;
        retried = true;
        return true;
      },
      describe: () => `图片 ${name}，${Math.ceil(data.length / 1024)}KB`,
    });
  }

  /** 上传富媒体，返回 file_info。被限频或平台提示重试时，等一会儿再试。 */
  async #upload(ctx: ReplyContext, body: Record<string, unknown>): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res =
          ctx.scene === "group"
            ? await this.#api.uploadGroupFile(ctx.targetId, body)
            : await this.#api.uploadC2CFile(ctx.targetId, body);
        if (!res?.file_info) throw new Error("上传接口没有返回 file_info");
        return res.file_info;
      } catch (err) {
        const retryable = err instanceof QQApiError && (isRateLimited(err) || UPLOAD_RETRYABLE.has(err.code ?? -1));
        if (!retryable || attempt >= 2) throw err;
        await sleep(1500 * (attempt + 1));
      }
    }
  }

  /**
   * 发送循环：被动回复优先，不可用时改发主动消息；被限频时等一会儿重试。
   * build 按本次是否被动回复生成请求体；retry 可以根据错误调整内容，返回 true 表示调整后重发。
   * allowActive=false 时，被动回复不可用就放弃发送，返回 false。
   */
  async #deliver(
    ctx: ReplyContext,
    opts: {
      allowActive: boolean;
      build: (passive: boolean) => Record<string, unknown>;
      retry?: (err: QQApiError) => boolean;
      describe: () => string;
    },
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const passive = canReplyPassively(ctx);
      if (!passive && !opts.allowActive) return false;
      try {
        await this.#post(ctx, opts.build(passive));
        if (passive) ctx.passiveCount++;
        log.debug(`已发送 ${ctx.scene}:${ctx.targetId}（${passive ? "被动" : "主动"}，${opts.describe()}）`);
        return true;
      } catch (err) {
        if (!(err instanceof QQApiError)) throw err;
        const code = err.code ?? -1;
        if (passive && PASSIVE_UNAVAILABLE.has(code)) {
          log.debug(`被动回复不可用（code=${code}），改发主动消息`);
          ctx.passiveExhausted = true;
          continue;
        }
        if (opts.retry?.(err)) continue;
        if (code === DEDUPED) continue;
        if (isRateLimited(err)) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw new Error("发送消息重试次数过多");
  }

  /** 单聊里显示“对方正在输入”。失败不影响主流程。 */
  async sendTyping(ctx: ReplyContext, seconds = 60): Promise<void> {
    if (ctx.scene !== "c2c" || !ctx.msgId || !canReplyPassively(ctx)) return;
    try {
      await this.#api.sendC2C(ctx.targetId, {
        msg_type: 6,
        input_notify: { input_type: 1, input_second: Math.min(60, seconds) },
        msg_id: ctx.msgId,
        msg_seq: ++ctx.seq,
      });
    } catch (err) {
      log.debug(`发送“正在输入”失败：${err instanceof Error ? err.message : err}`);
    }
  }

  #noteMarkdownFailure(scene: Scene, code: number, err: QQApiError): void {
    const failures = (this.#markdownFailures.get(scene) ?? 0) + 1;
    this.#markdownFailures.set(scene, failures);
    if (this.#markdownMode === "auto" && (MARKDOWN_DENIED.has(code) || failures >= 2)) {
      this.#markdownDenied.add(scene);
      log.warn(`${scene} 场景发送 Markdown 失败（${err.serverMessage || code}），之后改用纯文本`);
    } else {
      log.warn(`Markdown 发送失败，本条改用纯文本：${err.message}`);
    }
  }

  #buildBody(ctx: ReplyContext, content: string, markdown: boolean, passive: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    const v2 = ctx.scene === "c2c" || ctx.scene === "group";
    if (markdown) {
      if (v2) body.msg_type = 2;
      body.markdown = { content };
    } else {
      if (v2) body.msg_type = 0;
      body.content = content;
    }
    return this.#withReplyRef(ctx, body, passive);
  }

  /** 被动回复要带上 msg_id（或 event_id），单聊和群聊还要带递增的 msg_seq。 */
  #withReplyRef(ctx: ReplyContext, body: Record<string, unknown>, passive: boolean): Record<string, unknown> {
    if (passive) {
      if (ctx.msgId) body.msg_id = ctx.msgId;
      else body.event_id = ctx.eventId;
      if (ctx.scene === "c2c" || ctx.scene === "group") body.msg_seq = ++ctx.seq;
    }
    return body;
  }

  #post(ctx: ReplyContext, body: Record<string, unknown>): Promise<unknown> {
    switch (ctx.scene) {
      case "c2c":
        return this.#api.sendC2C(ctx.targetId, body);
      case "group":
        return this.#api.sendGroup(ctx.targetId, body);
      case "channel":
        return this.#api.sendChannel(ctx.targetId, body);
      case "dms":
        return this.#api.sendDms(ctx.targetId, body);
    }
  }
}
