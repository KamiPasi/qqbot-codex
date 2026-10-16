import fs from "node:fs";
import path from "node:path";
import { CodexRpcError, type CodexAppServer } from "../codex/appServer.ts";
import type { Thread, ThreadItem, ThreadSessionResponse, Turn, UserInput } from "../codex/protocol.ts";
import type { Config } from "../config.ts";
import { createLogger } from "../log.ts";
import { QQApiError } from "../qq/api.ts";
import {
  canSendMedia,
  createReplyContext,
  MAX_IMAGE_BYTES,
  passiveRemaining,
  type MessageSender,
  type ReplyContext,
} from "../qq/sender.ts";
import { SCENE_LABEL, type QQAttachment, type QQMessageEvent, type QQNoticeEvent, type Scene } from "../qq/types.ts";
import { chunkText, formatDuration, LruSet, Semaphore, shortId, truncate } from "../util.ts";
import { prepareAttachments } from "./attachments.ts";
import { extractReplyImages } from "./images.ts";
import { SessionStore } from "./sessions.ts";

const log = createLogger("bridge");

/** 空闲多久后让 app-server 卸载线程（释放 MCP 等资源），下次发消息时自动恢复 */
const IDLE_UNLOAD_MS = 30 * 60_000;
/** 这么久还没有任何回复时，发一条“处理中”提示 */
const SLOW_NOTICE_MS = 40_000;
const PROGRESS_INTERVAL_MS = 30_000;
const MAX_PROGRESS = 3;
/** 发出中断后最多等这么久，等不到 turn/completed 就强制结束 */
const INTERRUPT_GRACE_MS = 30_000;
const UNAUTHORIZED_REPLY_INTERVAL_MS = 10 * 60_000;
/** 每个会话记住最近用过的线程数 / /threads 一次列出的数量 */
const HISTORY_LIMIT = 20;
const LIST_LIMIT = 10;
/** 一次回复最多发几张图片 */
const MAX_REPLY_IMAGES = 3;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** 给用户看的失败原因：QQ 接口错误只保留平台返回的说明 */
const reasonText = (err: unknown) =>
  err instanceof QQApiError ? err.serverMessage || `HTTP ${err.status}` : errText(err);

interface Inbound {
  scene: Scene;
  convKey: string;
  ctx: ReplyContext;
  msgId: string;
  /** 当前场景下的发送者 openid */
  senderId: string;
  /** 发送者所有已知 ID（user_openid / member_openid / union_openid），用于白名单匹配 */
  senderIds: string[];
  groupId?: string;
  text: string;
  attachments: QQAttachment[];
  quoted?: string;
  /** 已构建好的 Codex 输入（附件只下载一次） */
  input?: UserInput[];
}

const attachmentCount = (items: Inbound[]) => items.reduce((n, m) => n + m.attachments.length, 0);

/** 把暂存的几条消息并成一条：文字和回复上下文用最后一条，附件按发送顺序合在一起。 */
function mergeInbound(items: Inbound[]): Inbound {
  const last = items[items.length - 1];
  return items.length === 1 ? last : { ...last, attachments: items.flatMap((m) => m.attachments) };
}

interface Conversation {
  key: string;
  scene: Scene;
  threadId?: string;
  /** 线程已在哪一代 app-server 中加载；与当前 generation 不同就需要 thread/resume */
  loadedGen?: number;
  /** 线程当前实际使用的模型 / 推理强度 / 目录，以及标题 */
  model?: string;
  effort?: string | null;
  cwd?: string;
  title?: string;
  /** 用户通过指令设置的覆盖项（持久化） */
  override: { model?: string; effort?: string; cwd?: string };
  /** 这个会话用过的线程（最近的在前，持久化） */
  history: string[];
  /** 最近一次 /threads 列出的线程，/switch 的序号对应这里 */
  listing?: string[];
  run?: TurnRun;
  starting: boolean;
  /** 没能追加给进行中任务的普通消息，下一轮一起处理 */
  queue: Inbound[];
  /** 用 /queue 发的消息：不追加给进行中的任务，等它做完后一条一轮依次处理 */
  later: Inbound[];
  /** 只发了附件、还在等文字说明的消息，按发送者分开 */
  held: Map<string, { items: Inbound[]; timer: NodeJS.Timeout }>;
  /** 下一次回复前要附带的提示 */
  notice?: string;
  idleTimer?: NodeJS.Timeout;
}

/** 一次 Codex turn 的运行状态 */
class TurnRun {
  readonly conv: Conversation;
  readonly threadId: string;
  readonly release: () => void;
  /** 本轮 Codex 的工作目录，回复里的相对路径基于它 */
  readonly cwd: string;
  readonly startedAt = Date.now();
  /** 回复上下文：任务进行中用户追加消息时会切到最新那条（被动回复额度更新） */
  ctx: ReplyContext;
  turnId: string | undefined;
  finished = false;
  finalText = "";
  untaggedText = "";
  lastText = "";
  errorText = "";
  activity = "";
  progressSent = 0;
  lastProgressAt = 0;
  sentSomething = false;
  /** 被 /new 打断的任务，结束时不再发任何消息 */
  silent = false;
  timedOut = false;
  /** /stop 时顺带取消了什么，附在“已停止”后面 */
  stopNote = "";
  /** 最近一条交给本轮的消息是谁、什么时候发的（判断图片是不是在补充刚发的文字） */
  lastInput?: { senderId: string; receivedAt: number };
  timers: NodeJS.Timeout[] = [];
  sendChain: Promise<void> = Promise.resolve();

  constructor(conv: Conversation, threadId: string, ctx: ReplyContext, release: () => void, cwd: string) {
    this.conv = conv;
    this.threadId = threadId;
    this.ctx = ctx;
    this.release = release;
    this.cwd = cwd;
  }
}

interface ModelInfo {
  id: string;
  displayName: string;
  efforts: string[];
  defaultEffort?: string;
  isDefault: boolean;
}

/** 指令别名（含中文）→ 标准指令名 */
const COMMAND_ALIASES: Record<string, string> = {
  reset: "new",
  新会话: "new",
  新建: "new",
  停止: "stop",
  状态: "status",
  帮助: "help",
  list: "threads",
  ls: "threads",
  history: "threads",
  线程: "threads",
  会话: "threads",
  use: "switch",
  resume: "switch",
  切换: "switch",
  模型: "model",
  排队: "queue",
  later: "queue",
};

function parseCommand(text: string): { name: string; args: string } | undefined {
  const m = /^[/／]\s*([a-zA-Z]+|[一-鿿]+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return undefined;
  const name = m[1].toLowerCase();
  return { name: COMMAND_ALIASES[name] ?? name, args: m[2].trim() };
}

const KNOWN_COMMANDS = ["help", "new", "threads", "switch", "stop", "queue", "status", "model", "effort", "cwd", "whoami"];

/** 编辑距离（相邻字母对调算 1 步） */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** 不认识的 /xxx 如果很像某个指令（比如 /treads），返回那个指令名 */
function suggestCommand(name: string): string | undefined {
  if (!/^[a-z]{3,}$/.test(name)) return undefined;
  let best: string | undefined;
  let bestDist = Infinity;
  for (const cmd of KNOWN_COMMANDS) {
    const dist = editDistance(name, cmd);
    if (dist < bestDist && dist <= Math.max(1, Math.floor(cmd.length / 3))) {
      best = cmd;
      bestDist = dist;
    }
  }
  return best;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Unix 秒 → “3分钟前 / 今天 14:20 / 昨天 09:05 / 10-12 18:30” */
function relTime(sec: number | undefined): string {
  if (!sec) return "";
  const diff = Date.now() / 1000 - sec;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  const d = new Date(sec * 1000);
  const now = new Date();
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}

function threadTitle(t: Pick<Thread, "name" | "preview">): string {
  return truncate((t.name || t.preview || "（无标题）").replace(/\s+/g, " ").trim(), 30);
}

function describeItem(item: ThreadItem | undefined): string {
  switch (item?.type) {
    case "commandExecution":
      return `执行命令：${truncate(item.command ?? "", 80)}`;
    case "fileChange":
      return `修改文件：${(item.changes ?? []).map((c) => path.basename(c.path)).join("、")}`;
    case "mcpToolCall":
      return `调用工具：${item.server}.${item.tool}`;
    case "webSearch":
      return "搜索网页";
    case "reasoning":
      return "思考中";
    case "agentMessage":
      return "撰写回复";
    default:
      return "";
  }
}

function quotedText(d: QQMessageEvent): string | undefined {
  const parts = (d.msg_elements ?? []).map((e) => e.content?.trim()).filter(Boolean);
  return parts.length ? truncate(parts.join("\n"), 800) : undefined;
}

const HELP = [
  "🤖 Codex 助手指令",
  "/new [内容]  开启新会话（可直接带上第一句话）",
  "/threads  列出本会话用过的线程（单聊里 /threads all 列出本机全部）",
  "/switch 序号  切换到列表里的线程，接着聊",
  "/stop  停止当前任务（排队的消息也一起取消）",
  "/queue 内容  排队：等当前任务做完再处理这条",
  "/status  查看会话状态",
  "/model [名称|default]  查看或切换模型",
  "/effort [强度|default]  查看或切换推理强度",
  "/cwd [路径]  查看或切换工作目录",
  "/whoami  查看你的 ID",
  "",
  "直接发消息就是和 Codex 对话。任务进行中再发消息，会插进正在执行的任务（引导）；想等它做完再处理，就用 /queue 发。",
  "中文指令也可以：/新会话 /线程 /切换 2 /停止 /排队 /状态",
].join("\n");

/** QQ 消息 ⇄ Codex 线程/turn 的桥接 */
export class Bridge {
  #cfg: Config;
  #codex: CodexAppServer;
  #sender: MessageSender;
  #store: SessionStore;
  #convs = new Map<string, Conversation>();
  #convByThread = new Map<string, Conversation>();
  /** threadId → 进行中的 turn */
  #runs = new Map<string, TurnRun>();
  #seen = new LruSet(5000);
  #limiter: Semaphore;
  #rejectedAt = new Map<string, number>();
  #defaults: { model?: string; effort?: string } = {};
  #models: ModelInfo[] | undefined;
  #attachDir: string;
  #replyDir: string;

  constructor(opts: { config: Config; codex: CodexAppServer; sender: MessageSender }) {
    this.#cfg = opts.config;
    this.#codex = opts.codex;
    this.#sender = opts.sender;
    this.#store = new SessionStore(path.join(this.#cfg.dataDir, "sessions.json"));
    this.#limiter = new Semaphore(this.#cfg.codex.maxConcurrent);
    this.#attachDir = path.join(this.#cfg.dataDir, "attachments");
    this.#replyDir = path.join(this.#cfg.dataDir, "replies");
    this.#codex.onNotification((method, params) => this.#onNotification(method, params));
    this.#codex.onExit((reason) => this.#onCodexExit(reason));
    this.#codex.setServerRequestHandler((method, params) => this.#onServerRequest(method, params));
  }

  /** 读取 Codex 生效的默认配置（模型、推理强度等），用于展示和恢复默认值。 */
  async init(): Promise<void> {
    try {
      const res = await this.#codex.request<{
        config: { model?: string | null; model_reasoning_effort?: string | null; sandbox_mode?: string | null };
      }>("config/read", { cwd: this.#cfg.codex.cwd });
      this.#defaults = {
        model: this.#cfg.codex.model ?? res.config.model ?? undefined,
        effort: this.#cfg.codex.effort ?? res.config.model_reasoning_effort ?? undefined,
      };
      log.info(
        `Codex 默认：模型 ${this.#defaults.model ?? "（Codex 默认）"}，推理 ${this.#defaults.effort ?? "默认"}，` +
          `沙箱 ${this.#cfg.codex.sandbox ?? res.config.sandbox_mode ?? "默认"}，审批 ${this.#cfg.codex.approvalPolicy}，` +
          `工作目录 ${this.#cfg.codex.cwd}`,
      );
    } catch (err) {
      log.warn(`读取 Codex 配置失败：${errText(err)}`);
    }
  }

  shutdown(): void {
    this.#store.flush();
  }

  // ───────────────────────────── QQ 事件入口 ─────────────────────────────

  handleEvent(type: string, data: any, eventId: string | undefined): void {
    if (type === "FRIEND_ADD" || type === "GROUP_ADD_ROBOT") {
      void this.#welcome(type, data as QQNoticeEvent, eventId);
      return;
    }
    const inb = this.#normalize(type, data as QQMessageEvent);
    if (!inb) {
      log.debug(`忽略事件 ${type}`);
      return;
    }
    if (!this.#seen.add(inb.msgId)) {
      log.debug(`重复推送的消息 ${inb.msgId}，已忽略`);
      return;
    }
    const where = inb.groupId ? `群 ${inb.groupId} ` : "";
    const extra = inb.attachments.length ? ` [附件×${inb.attachments.length}]` : "";
    log.info(`收到${SCENE_LABEL[inb.scene]} ${where}用户 ${inb.senderId}：${truncate(inb.text.replace(/\s+/g, " "), 100)}${extra}`);
    this.#onMessage(inb).catch((err) => log.error("处理消息出错", err));
  }

  #normalize(type: string, d: QQMessageEvent): Inbound | undefined {
    if (!d?.id) return undefined;
    const author = d.author ?? {};
    if (author.bot) return undefined;
    let scene: Scene;
    let senderId: string | undefined;
    let targetId: string | undefined;
    let groupId: string | undefined;
    let text = d.content ?? "";
    switch (type) {
      case "C2C_MESSAGE_CREATE":
        scene = "c2c";
        senderId = author.user_openid ?? author.id;
        targetId = senderId;
        break;
      case "GROUP_AT_MESSAGE_CREATE":
        scene = "group";
        senderId = author.member_openid ?? author.id;
        groupId = d.group_openid ?? d.group_id;
        targetId = groupId;
        break;
      case "AT_MESSAGE_CREATE":
        scene = "channel";
        senderId = author.id;
        targetId = d.channel_id;
        text = text.replace(/<@!?\d+>/g, "");
        break;
      case "DIRECT_MESSAGE_CREATE":
        scene = "dms";
        senderId = author.id;
        targetId = d.guild_id;
        break;
      default:
        return undefined;
    }
    if (!senderId || !targetId) return undefined;
    let convKey: string;
    if (scene === "group") {
      convKey = this.#cfg.qq.groupSession === "user" ? `group:${groupId}:${senderId}` : `group:${groupId}`;
    } else {
      convKey = `${scene}:${targetId}`;
    }
    const senderIds = [author.user_openid, author.member_openid, author.union_openid, author.id].filter(
      (v): v is string => Boolean(v),
    );
    return {
      scene,
      convKey,
      ctx: createReplyContext(scene, targetId, { msgId: d.id }),
      msgId: d.id,
      senderId,
      senderIds,
      groupId,
      text: text.trim(),
      attachments: d.attachments ?? [],
      quoted: quotedText(d),
    };
  }

  async #welcome(type: string, d: QQNoticeEvent, eventId: string | undefined): Promise<void> {
    const group = type === "GROUP_ADD_ROBOT";
    const targetId = group ? d.group_openid : d.openid;
    if (!targetId || !eventId) return;
    log.info(group ? `机器人被加入群 ${targetId}` : `新好友 ${targetId}`);
    const ctx = createReplyContext(group ? "group" : "c2c", targetId, { eventId });
    const text = group
      ? "👋 大家好！@我 并输入问题即可和 Codex 对话，@我 发送 /help 查看指令。"
      : "👋 你好！我是接入了 Codex 的助手，直接发消息就能对话，发送 /help 查看指令。";
    try {
      await this.#sender.send(ctx, text, { allowActive: false });
    } catch (err) {
      log.debug(`发送欢迎语失败：${errText(err)}`);
    }
  }

  #isAllowed(inb: Inbound): boolean {
    const { allowedUsers, allowedGroups } = this.#cfg.qq;
    if (allowedUsers.has("*")) return true;
    if (inb.senderIds.some((id) => allowedUsers.has(id))) return true;
    return Boolean(inb.groupId && (allowedGroups.has("*") || allowedGroups.has(inb.groupId)));
  }

  #whoamiText(inb: Inbound): string {
    const lines = [`你的 ID（${SCENE_LABEL[inb.scene]}）：${inb.senderId}`];
    if (inb.groupId) lines.push(`本群 ID：${inb.groupId}`);
    return lines.join("\n");
  }

  async #reply(inb: Inbound, text: string): Promise<void> {
    try {
      await this.#sender.send(inb.ctx, text);
    } catch (err) {
      log.error(`回复失败（${inb.convKey}）`, errText(err));
    }
  }

  async #onMessage(inb: Inbound): Promise<void> {
    const cmd = parseCommand(inb.text);
    if (cmd?.name === "whoami") {
      await this.#reply(inb, this.#whoamiText(inb));
      return;
    }
    if (!this.#isAllowed(inb)) {
      log.warn(
        `未授权：用户 ${inb.senderId}${inb.groupId ? `（群 ${inb.groupId}）` : ""}。` +
          `允许 TA 使用请把 ID 加到 .env 的 QQ_ALLOWED_USERS${inb.groupId ? "，或把群 ID 加到 QQ_ALLOWED_GROUPS" : ""}`,
      );
      const last = this.#rejectedAt.get(inb.senderId) ?? 0;
      if (Date.now() - last < UNAUTHORIZED_REPLY_INTERVAL_MS) return;
      this.#rejectedAt.set(inb.senderId, Date.now());
      await this.#reply(inb, `⛔ 你还没有使用权限。\n${this.#whoamiText(inb)}\n请把上面的 ID 发给管理员加入白名单。`);
      return;
    }
    const conv = this.#getConv(inb.convKey, inb.scene);
    if (cmd) {
      if (await this.#runCommand(inb, conv, cmd)) return;
      const guess = suggestCommand(cmd.name);
      if (guess) {
        await this.#reply(inb, `没有 /${cmd.name} 这个指令，你是不是想用 /${guess}${cmd.args ? ` ${cmd.args}` : ""}？`);
        return;
      }
      // 其余不认识的 /xxx（比如路径）当作普通消息交给 Codex
    }
    if (!inb.text && inb.attachments.length === 0) {
      await this.#reply(inb, "请直接输入问题，发送 /help 查看指令。");
      return;
    }
    if (this.#holdMedia(conv, inb)) return;
    await this.#submit(conv, this.#withHeld(conv, inb));
  }

  #getConv(key: string, scene: Scene): Conversation {
    let conv = this.#convs.get(key);
    if (!conv) {
      const rec = this.#store.get(key);
      const history = rec?.history ?? (rec?.threadId ? [rec.threadId] : []);
      conv = {
        key,
        scene,
        threadId: rec?.threadId,
        override: { model: rec?.model, effort: rec?.effort, cwd: rec?.cwd },
        history,
        starting: false,
        queue: [],
        later: [],
        held: new Map(),
      };
      this.#convs.set(key, conv);
      if (conv.threadId) this.#convByThread.set(conv.threadId, conv);
    }
    return conv;
  }

  // ───────────────────────────── 指令 ─────────────────────────────

  async #runCommand(inb: Inbound, conv: Conversation, cmd: { name: string; args: string }): Promise<boolean> {
    switch (cmd.name) {
      case "help":
        await this.#reply(inb, HELP);
        return true;
      case "new":
        await this.#cmdNew(inb, conv, cmd.args);
        return true;
      case "threads":
        await this.#cmdThreads(inb, conv, cmd.args);
        return true;
      case "switch":
        await this.#cmdSwitch(inb, conv, cmd.args);
        return true;
      case "stop":
        await this.#cmdStop(inb, conv);
        return true;
      case "queue":
        await this.#cmdQueue(inb, conv, cmd.args);
        return true;
      case "status":
        await this.#reply(inb, this.#statusText(conv));
        return true;
      case "model":
        await this.#cmdModel(inb, conv, cmd.args);
        return true;
      case "effort":
        await this.#cmdEffort(inb, conv, cmd.args);
        return true;
      case "cwd":
        await this.#cmdCwd(inb, conv, cmd.args);
        return true;
      default:
        return false; // 不认识的 /xxx 当作普通消息交给 Codex
    }
  }

  async #cmdNew(inb: Inbound, conv: Conversation, args: string): Promise<void> {
    const run = conv.run;
    if (run) {
      run.silent = true;
      void this.#interrupt(run);
    }
    conv.queue.length = 0;
    const cancelled = conv.later.splice(0).length; // 排队的消息是接着旧会话说的，不带到新会话
    this.#detachThread(conv);
    log.info(`会话 ${conv.key} 已重置`);
    const note = cancelled ? `排队的 ${cancelled} 条消息已取消` : "";
    if (args) {
      if (note) conv.notice = `（${note}）`;
      inb.text = args;
      await this.#submit(conv, this.#withHeld(conv, inb));
    } else {
      await this.#reply(inb, note ? `🆕 已开启新会话，${note}。` : "🆕 已开启新会话。");
    }
  }

  async #cmdStop(inb: Inbound, conv: Conversation): Promise<void> {
    conv.queue.length = 0;
    const dropped = this.#dropPending(conv);
    const run = conv.run;
    if (!run || run.silent) {
      await this.#reply(inb, dropped ? `${dropped}。` : "当前没有进行中的任务。");
      return;
    }
    run.ctx = inb.ctx; // “已停止”用这条消息回复
    run.stopNote = dropped;
    log.info(`用户请求停止 ${conv.key} 的任务`);
    await this.#interrupt(run);
  }

  /** /queue：不追加给进行中的任务，排在后面，等前面的都做完再单独作为一轮处理。 */
  async #cmdQueue(inb: Inbound, conv: Conversation, args: string): Promise<void> {
    if (!args && inb.attachments.length === 0) {
      const lines = [
        "用法：/queue 内容（或 /排队 内容）",
        "任务进行中直接发消息，会插进当前任务；用 /queue 发，会等当前任务做完再单独处理。",
      ];
      if (conv.later.length) lines.push("", ...this.#laterLines(conv));
      await this.#reply(inb, lines.join("\n"));
      return;
    }
    inb.text = args;
    const msg = this.#withHeld(conv, inb);
    const busy = (conv.run && !conv.run.silent) || conv.starting || conv.queue.length > 0 || conv.later.length > 0;
    if (!busy) {
      await this.#submit(conv, msg); // 没有要等的任务，直接处理
      return;
    }
    conv.later.push(msg);
    log.info(`已排队，等当前任务做完再处理（${conv.key}，第 ${conv.later.length} 条）`);
    await this.#reply(inb, `🕒 已排队（第 ${conv.later.length} 条），等当前任务做完再处理。`);
  }

  /** 排队中的消息，给 /status 和 /queue 看 */
  #laterLines(conv: Conversation): string[] {
    return [
      `排队中（当前任务做完后依次处理）：${conv.later.length} 条`,
      ...conv.later.map((m, i) => {
        const extra = m.attachments.length ? ` [附件×${m.attachments.length}]` : "";
        return `${i + 1}. ${truncate(m.text.replace(/\s+/g, " "), 30) || "（无文字）"}${extra}`;
      }),
    ];
  }

  async #cmdThreads(inb: Inbound, conv: Conversation, args: string): Promise<void> {
    const all = /^(all|全部|所有)$/i.test(args);
    if (all && conv.scene !== "c2c") {
      await this.#reply(inb, "为了保护隐私，/threads all 只能在单聊里用。");
      return;
    }
    let threads: Thread[];
    try {
      threads = all ? await this.#listAllThreads() : await this.#listOwnThreads(conv);
    } catch (err) {
      await this.#reply(inb, `获取线程列表失败：${truncate(errText(err), 200)}`);
      return;
    }
    if (threads.length === 0) {
      await this.#reply(inb, all ? "本机还没有 Codex 线程。" : "本会话还没有线程，直接发消息就会自动创建。");
      return;
    }
    conv.listing = threads.map((t) => t.id);
    const lines = [all ? "💻 本机最近的 Codex 线程：" : "📚 本会话用过的线程：", ""];
    threads.forEach((t, i) => {
      const where = all ? ` · ${this.#convByThread.has(t.id) ? "QQ" : path.basename(t.cwd)}` : "";
      const current = t.id === conv.threadId ? " ◀ 当前" : "";
      lines.push(`${i + 1}. ${threadTitle(t)}${where} · ${relTime(t.updatedAt)}${current}`);
    });
    const more = !all && conv.scene === "c2c" ? "　本机全部：/threads all" : "";
    lines.push("", `切换：/switch 序号　新会话：/new${more}`);
    await this.#reply(inb, lines.join("\n"));
  }

  async #listOwnThreads(conv: Conversation): Promise<Thread[]> {
    const ids = conv.history.slice(0, LIST_LIMIT);
    const threads = await Promise.all(
      ids.map((threadId) =>
        this.#codex.request<{ thread: Thread }>("thread/read", { threadId }, 15_000).then(
          (res) => res.thread,
          (err) => {
            log.debug(`读取线程 ${threadId} 失败：${errText(err)}`);
            return undefined;
          },
        ),
      ),
    );
    return threads.filter((t): t is Thread => Boolean(t));
  }

  async #listAllThreads(): Promise<Thread[]> {
    const res = await this.#codex.request<{ data: Thread[] }>("thread/list", { limit: LIST_LIMIT, sortKey: "updated_at" }, 30_000);
    return res.data;
  }

  /** 把“序号 / 线程 ID / ID 前缀”解析成线程 ID。群聊只能切到本群用过的线程。 */
  #resolveThreadRef(conv: Conversation, ref: string): string | undefined {
    const num = /^#?(\d{1,3})$/.exec(ref);
    if (num) return (conv.listing ?? conv.history)[Number(num[1]) - 1];
    const id = ref.toLowerCase();
    const known = conv.scene === "c2c" ? [...(conv.listing ?? []), ...conv.history] : conv.history;
    const hit = known.find((t) => t === id) ?? (id.length >= 6 ? known.find((t) => t.startsWith(id)) : undefined);
    if (hit) return hit;
    if (conv.scene === "c2c" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return id;
    return undefined;
  }

  async #cmdSwitch(inb: Inbound, conv: Conversation, args: string): Promise<void> {
    if (!args) {
      await this.#reply(inb, "用法：/switch 序号（序号见 /threads 列表），也可以直接填线程 ID。");
      return;
    }
    if ((conv.run && !conv.run.silent) || conv.starting) {
      await this.#reply(inb, "当前任务还在进行，请等它完成或先发 /stop。");
      return;
    }
    const threadId = this.#resolveThreadRef(conv, args);
    if (!threadId) {
      await this.#reply(inb, "没找到这个线程，先发 /threads 看看列表。");
      return;
    }
    if (threadId === conv.threadId) {
      await this.#reply(inb, "已经在这个线程里了。");
      return;
    }
    const owner = this.#convByThread.get(threadId);
    if (owner && owner !== conv) {
      await this.#reply(inb, "这个线程正在被另一个 QQ 会话使用，不能切换过去。");
      return;
    }
    let res: ThreadSessionResponse;
    try {
      res = await this.#codex.request<ThreadSessionResponse>("thread/resume", {
        threadId,
        excludeTurns: true,
        ...this.#threadPolicy(),
      });
    } catch (err) {
      await this.#reply(inb, `切换失败：${truncate(errText(err), 200)}`);
      return;
    }
    const createdHere = conv.history.includes(threadId);
    this.#detachThread(conv);
    conv.threadId = threadId;
    conv.override.cwd = undefined; // 工作目录跟着线程走
    this.#noteSession(conv, res);
    this.#convByThread.set(threadId, conv);
    this.#remember(conv, threadId);
    this.#saveOverride(conv);
    this.#scheduleIdleUnload(conv);
    log.info(`会话 ${conv.key} 切换到线程 ${threadId}`);

    const lines = [`✅ 已切换到：${conv.title}`, `目录：${res.cwd}`];
    const recap = await this.#lastExchange(threadId);
    if (recap) lines.push("", recap);
    if (!createdHere) lines.push("", "注意：这个线程不是在 QQ 里创建的，别在 Codex 桌面端和 QQ 里同时操作它。");
    lines.push("", "接下来发的消息都会进入这个线程。");
    await this.#reply(inb, lines.join("\n"));
  }

  /** 线程最后一轮的问答摘要，切换线程后给用户回顾。 */
  async #lastExchange(threadId: string): Promise<string> {
    try {
      const res = await this.#codex.request<{ data: Turn[] }>(
        "thread/turns/list",
        { threadId, limit: 1, sortDirection: "desc" },
        15_000,
      );
      const items = res.data[0]?.items ?? [];
      const asked = items
        .find((i) => i.type === "userMessage")
        ?.content?.map((c) => c.text ?? "")
        .join(" ")
        .trim();
      const answers = items.filter((i) => i.type === "agentMessage" && i.text?.trim());
      const answer = (answers.findLast((i) => i.phase === "final_answer") ?? answers.at(-1))?.text?.trim();
      const lines: string[] = [];
      if (asked) lines.push(`上次问：${truncate(asked.replace(/\s+/g, " "), 80)}`);
      if (answer) lines.push(`上次答：${truncate(answer.replace(/\s+/g, " "), 160)}`);
      return lines.join("\n");
    } catch (err) {
      log.debug(`读取线程 ${threadId} 的最近一轮失败：${errText(err)}`);
      return "";
    }
  }

  #remember(conv: Conversation, threadId: string): void {
    conv.history = [threadId, ...conv.history.filter((id) => id !== threadId)].slice(0, HISTORY_LIMIT);
    this.#store.update(conv.key, { threadId, history: conv.history });
  }

  #statusText(conv: Conversation): string {
    const lines = [`会话：${SCENE_LABEL[conv.scene]}（${conv.key}）`];
    lines.push(
      conv.threadId
        ? `Codex 线程：${conv.title ? `${conv.title}（${conv.threadId}）` : conv.threadId}`
        : "Codex 线程：尚未创建（发消息后自动创建）",
    );
    const model = conv.override.model ?? this.#defaults.model ?? conv.model ?? "默认";
    const effort = this.#effortFor(conv) ?? conv.effort ?? "默认";
    lines.push(`模型：${model}（推理 ${effort}）`);
    lines.push(`工作目录：${conv.override.cwd ?? conv.cwd ?? this.#cfg.codex.cwd}`);
    const run = conv.run;
    if (run && !run.silent) {
      lines.push(`状态：运行中，已 ${formatDuration(Date.now() - run.startedAt)}${run.activity ? `，${run.activity}` : ""}`);
    } else {
      lines.push("状态：空闲");
    }
    if (conv.queue.length) lines.push(`待处理消息：${conv.queue.length} 条`);
    if (conv.later.length) lines.push(...this.#laterLines(conv));
    const held = [...conv.held.values()].reduce((n, h) => n + attachmentCount(h.items), 0);
    if (held) lines.push(`等文字说明的附件：${held} 个`);
    lines.push(`全部会话：进行中 ${this.#runs.size} 个，排队 ${this.#limiter.waiting} 个`);
    return lines.join("\n");
  }

  async #loadModels(): Promise<ModelInfo[]> {
    if (this.#models) return this.#models;
    const res = await this.#codex.request<{
      data: Array<{
        id: string;
        model: string;
        displayName: string;
        isDefault: boolean;
        defaultReasoningEffort?: string;
        supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
      }>;
    }>("model/list", { limit: 100 });
    this.#models = res.data.map((m) => ({
      id: m.model || m.id,
      displayName: m.displayName,
      efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
      defaultEffort: m.defaultReasoningEffort,
      isDefault: m.isDefault,
    }));
    return this.#models;
  }

  /** 本轮应传给 Codex 的推理强度：用户设置 > 切换模型后该模型的默认值 > 全局默认 */
  #effortFor(conv: Conversation): string | undefined {
    if (conv.override.effort) return conv.override.effort;
    if (conv.override.model) {
      return this.#models?.find((m) => m.id === conv.override.model)?.defaultEffort;
    }
    return this.#defaults.effort;
  }

  #saveOverride(conv: Conversation): void {
    this.#store.update(conv.key, { model: conv.override.model, effort: conv.override.effort, cwd: conv.override.cwd });
  }

  async #cmdModel(inb: Inbound, conv: Conversation, args: string): Promise<void> {
    let models: ModelInfo[] = [];
    try {
      models = await this.#loadModels();
    } catch (err) {
      log.warn(`获取模型列表失败：${errText(err)}`);
    }
    const current = conv.override.model ?? this.#defaults.model ?? conv.model;
    if (!args) {
      const list = models.map((m) => `${m.id === current ? "▶" : "·"} ${m.id}${m.displayName && m.displayName !== m.id ? `（${m.displayName}）` : ""}`);
      await this.#reply(
        inb,
        [`当前模型：${current ?? "默认"}`, ...(list.length ? ["可用模型：", ...list] : []), "", "切换：/model 名称　恢复默认：/model default"].join("\n"),
      );
      return;
    }
    if (/^(default|默认|reset)$/i.test(args)) {
      conv.override.model = undefined;
      conv.override.effort = undefined;
      this.#saveOverride(conv);
      await this.#reply(inb, `已恢复默认模型：${this.#defaults.model ?? "Codex 默认"}`);
      return;
    }
    const target = models.find((m) => m.id.toLowerCase() === args.toLowerCase() || m.displayName.toLowerCase() === args.toLowerCase());
    conv.override.model = target?.id ?? args;
    if (conv.override.effort && target && target.efforts.length && !target.efforts.includes(conv.override.effort)) {
      conv.override.effort = undefined; // 新模型不支持原来的推理强度
    }
    this.#saveOverride(conv);
    const warn = target || models.length === 0 ? "" : "\n（不在模型列表里，如果出错请用 /model default 恢复）";
    await this.#reply(inb, `已切换模型：${conv.override.model}，下一条消息生效。${warn}`);
  }

  async #cmdEffort(inb: Inbound, conv: Conversation, args: string): Promise<void> {
    const model = conv.override.model ?? this.#defaults.model;
    let supported: string[] = [];
    try {
      supported = (await this.#loadModels()).find((m) => m.id === model)?.efforts ?? [];
    } catch {
      // 拿不到列表就不校验
    }
    if (!args) {
      await this.#reply(
        inb,
        `当前推理强度：${this.#effortFor(conv) ?? "默认"}` +
          (supported.length ? `\n可选：${supported.join(" / ")}` : "") +
          "\n切换：/effort 强度　恢复默认：/effort default",
      );
      return;
    }
    if (/^(default|默认|reset)$/i.test(args)) {
      conv.override.effort = undefined;
      this.#saveOverride(conv);
      await this.#reply(inb, `已恢复默认推理强度：${this.#effortFor(conv) ?? "默认"}`);
      return;
    }
    const effort = args.toLowerCase();
    if (supported.length && !supported.includes(effort)) {
      await this.#reply(inb, `${model} 不支持 ${effort}，可选：${supported.join(" / ")}`);
      return;
    }
    conv.override.effort = effort;
    this.#saveOverride(conv);
    await this.#reply(inb, `已切换推理强度：${effort}，下一条消息生效。`);
  }

  async #cmdCwd(inb: Inbound, conv: Conversation, args: string): Promise<void> {
    const current = conv.override.cwd ?? conv.cwd ?? this.#cfg.codex.cwd;
    if (!args) {
      await this.#reply(inb, `当前工作目录：${current}\n切换：/cwd 路径　恢复默认：/cwd default`);
      return;
    }
    if (/^(default|默认|reset)$/i.test(args)) {
      conv.override.cwd = undefined;
      this.#saveOverride(conv);
      await this.#reply(inb, `已恢复默认工作目录：${this.#cfg.codex.cwd}（下一条消息生效）`);
      return;
    }
    const target = path.resolve(current, args.replace(/^["']|["']$/g, ""));
    let ok = false;
    try {
      ok = fs.statSync(target).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) {
      await this.#reply(inb, `目录不存在：${target}`);
      return;
    }
    conv.override.cwd = target;
    this.#saveOverride(conv);
    await this.#reply(inb, `已切换工作目录：${target}（下一条消息生效）`);
  }

  // ───────────────────────────── 提交给 Codex ─────────────────────────────

  async #inputFor(inb: Inbound): Promise<UserInput[]> {
    if (inb.input) return inb.input;
    const { inputs, notes } = await prepareAttachments(inb.attachments, this.#attachDir, inb.msgId);
    const lines: string[] = [];
    let first = inb.text;
    if (inb.scene === "group" || inb.scene === "channel") first = `[群成员 ${shortId(inb.senderId)}] ${first}`;
    if (inb.quoted) lines.push(`[引用的消息] ${inb.quoted}`);
    lines.push(first.trim(), ...notes);
    inb.input = [{ type: "text", text: lines.filter(Boolean).join("\n"), text_elements: [] }, ...inputs];
    return inb.input;
  }

  /**
   * 手机 QQ 没法图文一起发，用户常常先发图片、再发文字说明。收到只有附件、没有文字的消息时先暂存起来，
   * 等同一个人的下一条文字一起处理：直接发的文字就一起追加给进行中的任务（或开始新任务），用 /queue 发的就一起排队；
   * 等了 QQ_MEDIA_WAIT_SEC 还没有文字，就直接处理附件。
   * 例外是「先发文字、再补图片」：这个人刚发的文字正在被处理，图片直接追加给当前任务，不用等。
   */
  #holdMedia(conv: Conversation, inb: Inbound): boolean {
    const waitMs = this.#cfg.qq.mediaWaitMs;
    if (!waitMs || inb.text || inb.attachments.length === 0) return false;
    if (inb.attachments.some((a) => a.content_type?.toLowerCase() === "voice")) return false; // 语音带识别文字，当作文字
    const held = conv.held.get(inb.senderId);
    const last = conv.run && !conv.run.silent ? conv.run.lastInput : undefined;
    if (!held && last?.senderId === inb.senderId && Date.now() - last.receivedAt < waitMs) return false;
    clearTimeout(held?.timer);
    const items = [...(held?.items ?? []), inb];
    const timer = setTimeout(() => {
      conv.held.delete(inb.senderId);
      log.info(`没等到文字说明，直接处理 ${attachmentCount(items)} 个附件（${conv.key}）`);
      this.#submit(conv, mergeInbound(items)).catch((err) => log.error("处理消息出错", err));
    }, waitMs);
    timer.unref();
    conv.held.set(inb.senderId, { items, timer });
    log.info(`先暂存附件，等文字说明再一起处理（${conv.key}，最多等 ${Math.round(waitMs / 1000)} 秒）`);
    if (!held) this.#ackHeld(conv, inb, waitMs); // 连发的后几张不再回
    return true;
  }

  /** 暂存附件时先回一句，免得用户以为机器人没收到。 */
  #ackHeld(conv: Conversation, inb: Inbound, waitMs: number): void {
    const image = inb.attachments.every((a) => a.content_type?.toLowerCase().startsWith("image"));
    const ask = inb.scene === "group" || inb.scene === "channel" ? "请接着 @我 发文字说明" : "请接着发文字说明";
    const timeout = `${Math.round(waitMs / 1000)} 秒内没发就直接${image ? "看图" : "处理"}`;
    const busy = (conv.run && !conv.run.silent) || conv.starting;
    const text = busy
      ? `📎 收到${image ? "图片" : "附件"}，${ask}（${timeout}）。当前任务还在进行：直接发会一起插进去，用 /queue 发会一起排队。`
      : `📎 收到${image ? "图片" : "附件"}，${ask}，我等你说完一起处理（${timeout}）。`;
    this.#sender.send(inb.ctx, text, { allowActive: false }).catch((err) => log.debug(`发送“收到附件”提示失败：${errText(err)}`));
  }

  /** 把同一个人暂存的附件并进这条消息；回复用这条消息的上下文，被动回复额度是新的。 */
  #withHeld(conv: Conversation, inb: Inbound): Inbound {
    const held = conv.held.get(inb.senderId);
    if (!held) return inb;
    clearTimeout(held.timer);
    conv.held.delete(inb.senderId);
    return mergeInbound([...held.items, inb]);
  }

  /** /stop：丢弃排队的消息和暂存的附件，返回给用户的说明（什么都没丢时为空）。 */
  #dropPending(conv: Conversation): string {
    const queued = conv.later.splice(0).length;
    let held = 0;
    for (const h of conv.held.values()) {
      clearTimeout(h.timer);
      held += attachmentCount(h.items);
    }
    conv.held.clear();
    const parts: string[] = [];
    if (queued) parts.push(`排队的 ${queued} 条消息已取消`);
    if (held) parts.push(`还在等文字说明的 ${held} 个附件已丢弃`);
    return parts.join("，");
  }

  async #submit(conv: Conversation, inb: Inbound): Promise<void> {
    const run = conv.run;
    if (run && run.turnId && !run.finished && !run.silent) {
      const input = await this.#inputFor(inb);
      if (await this.#steer(run, inb, input)) return;
    }
    conv.queue.push(inb);
    this.#pump(conv);
  }

  /** 把用户新发的消息追加到进行中的 turn。 */
  async #steer(run: TurnRun, inb: Inbound, input: UserInput[]): Promise<boolean> {
    if (run.finished || run.silent || !run.turnId) return false;
    try {
      await this.#codex.request("turn/steer", { threadId: run.threadId, input, expectedTurnId: run.turnId }, 30_000);
    } catch (err) {
      log.info(`无法追加到进行中的任务（${errText(err)}），排队等待`);
      return false;
    }
    run.ctx = inb.ctx;
    run.lastInput = { senderId: inb.senderId, receivedAt: inb.ctx.receivedAt };
    log.info(`已把新消息追加到进行中的任务（${run.conv.key}）`);
    void this.#sender.sendTyping(inb.ctx);
    return true;
  }

  #pump(conv: Conversation): void {
    if (conv.run || conv.starting) return;
    // 没能追加进去的普通消息先处理；/queue 的消息一条一轮
    const batch = conv.queue.length ? conv.queue.splice(0) : conv.later.splice(0, 1);
    if (batch.length) this.#startTurn(conv, batch).catch((err) => log.error("启动任务出错", err));
  }

  #threadPolicy(): { sandbox?: string; approvalPolicy: string } {
    return { sandbox: this.#cfg.codex.sandbox, approvalPolicy: this.#cfg.codex.approvalPolicy };
  }

  #instructions(scene: Scene): string {
    const lines = [
      `你正在通过 QQ 机器人与用户对话（场景：${SCENE_LABEL[scene]}）。`,
      "- 用户在手机或电脑 QQ 上看你的回复：先给结论，简洁清楚，不要贴大段日志、超长代码或宽表格。",
      "- QQ 对 Markdown 支持有限：可以用简单的列表和代码块，不要用表格、HTML 和多级标题。",
      "- 用户看不到你执行的命令和输出，需要时在回复里简要说明做了什么、结果如何。",
      "- 用户发来的图片和文件会先保存到本机，消息里会给出本地路径。",
    ];
    if (canSendMedia(scene)) {
      lines.push(
        "- 想给用户发图片（比如生成的图表、截图），就在最终回复里写 `![说明](图片的绝对路径)`，程序会把图片发到 QQ。" +
          `支持 png/jpg/gif/webp，单张不超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB，一次最多 ${MAX_REPLY_IMAGES} 张。`,
        "- 其他文件暂时不能通过 QQ 直接发送，生成了文件时请告诉用户文件在本机的完整路径。",
      );
    } else {
      lines.push("- 生成了文件时，请告诉用户文件在本机的完整路径（暂时不能通过 QQ 直接发送文件）。");
    }
    if (scene === "group" || scene === "channel") {
      lines.push("- 这是群聊，可能有多人使用同一个会话，每条消息开头的 [群成员 xxx] 标明了发送者。");
    }
    if (this.#cfg.codex.extraInstructions) lines.push("", this.#cfg.codex.extraInstructions);
    return lines.join("\n");
  }

  #noteSession(conv: Conversation, res: ThreadSessionResponse): void {
    conv.loadedGen = this.#codex.generation;
    conv.model = res.model;
    conv.effort = res.reasoningEffort;
    conv.cwd = res.cwd;
    conv.title = threadTitle(res.thread);
  }

  async #ensureThread(conv: Conversation, scene: Scene, firstText: string): Promise<string> {
    if (conv.threadId && conv.loadedGen === this.#codex.generation) return conv.threadId;
    if (conv.threadId) {
      try {
        const res = await this.#codex.request<ThreadSessionResponse>("thread/resume", {
          threadId: conv.threadId,
          excludeTurns: true,
          ...this.#threadPolicy(),
        });
        this.#noteSession(conv, res);
        log.info(`已恢复 Codex 线程 ${conv.threadId}（${conv.key}）`);
        return conv.threadId;
      } catch (err) {
        log.warn(`恢复线程 ${conv.threadId} 失败，改为新建：${errText(err)}`);
        this.#convByThread.delete(conv.threadId);
        conv.notice = "⚠️ 原来的 Codex 会话无法恢复，已自动开启新会话。";
      }
    }
    const res = await this.#codex.request<ThreadSessionResponse>("thread/start", {
      cwd: conv.override.cwd ?? this.#cfg.codex.cwd,
      model: conv.override.model ?? this.#defaults.model,
      ...this.#threadPolicy(),
      developerInstructions: this.#instructions(scene),
    });
    const threadId = res.thread.id;
    conv.threadId = threadId;
    this.#noteSession(conv, res);
    this.#convByThread.set(threadId, conv);
    this.#remember(conv, threadId);
    // 用第一句话命名，方便在 /threads 和 Codex 桌面端里区分
    const name = `${scene === "c2c" ? "QQ" : SCENE_LABEL[scene]}·${truncate(firstText.replace(/\s+/g, " ").trim() || "新会话", 24)}`;
    conv.title = name;
    this.#codex.request("thread/name/set", { threadId, name }).catch(() => {});
    log.info(`新建 Codex 线程 ${threadId}（${conv.key}，模型 ${res.model}）`);
    return threadId;
  }

  async #startTurn(conv: Conversation, batch: Inbound[]): Promise<void> {
    conv.starting = true;
    clearTimeout(conv.idleTimer);
    const last = batch[batch.length - 1];
    let release: (() => void) | undefined;
    let run: TurnRun | undefined;
    try {
      if (this.#limiter.waiting > 0 || this.#runs.size >= this.#cfg.codex.maxConcurrent) {
        void this.#sender.send(last.ctx, `⌛ 当前任务较多，已排队，请稍候…`, { allowActive: false }).catch(() => {});
      }
      release = await this.#limiter.acquire();
      if (conv.override.model && !this.#models) await this.#loadModels().catch(() => undefined);
      const first = batch[0];
      const threadId = await this.#ensureThread(conv, last.scene, first.text || (first.attachments.length ? "附件" : ""));
      const input = (await Promise.all(batch.map((m) => this.#inputFor(m)))).flat();
      run = new TurnRun(conv, threadId, last.ctx, release, conv.override.cwd ?? conv.cwd ?? this.#cfg.codex.cwd);
      run.lastInput = { senderId: last.senderId, receivedAt: last.ctx.receivedAt };
      conv.run = run;
      this.#runs.set(threadId, run);
      void this.#sender.sendTyping(last.ctx);
      const res = await this.#codex.request<{ turn: Turn }>("turn/start", {
        threadId,
        input,
        model: conv.override.model ?? this.#defaults.model,
        effort: this.#effortFor(conv),
        cwd: conv.override.cwd,
      });
      run.turnId ??= res.turn.id;
      log.info(`Codex 开始处理（${conv.key}，turn ${run.turnId}）`);
      this.#armTimers(run);
    } catch (err) {
      log.error(`启动 Codex 任务失败（${conv.key}）`, errText(err));
      if (run) {
        run.finished = true;
        if (this.#runs.get(run.threadId) === run) this.#runs.delete(run.threadId);
        if (conv.run === run) conv.run = undefined;
      }
      release?.();
      await this.#reply(last, `❌ 启动 Codex 任务失败：${truncate(errText(err), 300)}`);
    } finally {
      conv.starting = false;
    }
    if (conv.run) await this.#flushQueue(conv);
    else this.#pump(conv);
  }

  /** turn 启动期间进来的消息，尽量追加进当前 turn。 */
  async #flushQueue(conv: Conversation): Promise<void> {
    while (conv.queue.length && conv.run && !conv.run.finished) {
      const inb = conv.queue[0];
      const input = await this.#inputFor(inb);
      if (!conv.run || !(await this.#steer(conv.run, inb, input))) return;
      conv.queue.shift();
    }
  }

  #armTimers(run: TurnRun): void {
    if (run.finished) return;
    run.timers.push(
      setTimeout(() => {
        if (run.finished || run.sentSomething || run.silent) return;
        run.sentSomething = true;
        this.#queueSend(run, () => this.#sender.send(run.ctx, "⏳ 正在处理，请稍候…", { allowActive: false }));
      }, SLOW_NOTICE_MS).unref(),
      setTimeout(() => {
        if (run.finished) return;
        run.timedOut = true;
        log.warn(`任务超时，自动停止（${run.conv.key}）`);
        void this.#interrupt(run);
      }, this.#cfg.codex.turnTimeoutMs).unref(),
    );
  }

  async #interrupt(run: TurnRun): Promise<void> {
    if (run.finished) return;
    run.timers.push(
      setTimeout(() => {
        if (!run.finished) void this.#finishRun(run, undefined, "interrupted");
      }, INTERRUPT_GRACE_MS).unref(),
    );
    if (!run.turnId) return;
    try {
      await this.#codex.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId }, 15_000);
    } catch (err) {
      log.warn(`中断任务失败：${errText(err)}`);
    }
  }

  // ───────────────────────────── Codex 事件 ─────────────────────────────

  #onNotification(method: string, p: any): void {
    if (method === "thread/closed") {
      const conv = this.#convByThread.get(p?.threadId);
      if (conv) conv.loadedGen = undefined;
      return;
    }
    const run: TurnRun | undefined = p?.threadId ? this.#runs.get(p.threadId) : undefined;
    if (!run || run.finished) return;
    if (p.turnId && run.turnId && p.turnId !== run.turnId) return;
    switch (method) {
      case "turn/started":
        run.turnId ??= p.turn?.id;
        break;
      case "item/started":
        run.activity = describeItem(p.item) || run.activity;
        break;
      case "item/completed":
        this.#onItemCompleted(run, p.item as ThreadItem);
        break;
      case "error":
        if (p.willRetry) log.warn(`Codex 出错，正在重试：${p.error?.message ?? ""}`);
        else run.errorText = p.error?.message ?? run.errorText;
        break;
      case "turn/completed":
        if (!run.turnId || p.turn?.id === run.turnId) void this.#finishRun(run, p.turn as Turn);
        break;
    }
  }

  #onItemCompleted(run: TurnRun, item: ThreadItem | undefined): void {
    if (item?.type === "commandExecution") {
      log.debug(`[${run.conv.key}] 命令：${truncate(item.command ?? "", 200)} → exit ${item.exitCode}`);
    }
    if (item?.type !== "agentMessage") return;
    const text = item.text?.trim();
    if (!text) return;
    run.lastText = text;
    if (item.phase === "final_answer") {
      run.finalText = run.finalText ? `${run.finalText}\n\n${text}` : text;
    } else if (item.phase === "commentary") {
      this.#maybeProgress(run, text);
    } else {
      run.untaggedText = text;
    }
  }

  #maybeProgress(run: TurnRun, text: string): void {
    if (!this.#cfg.qq.progress || run.silent || run.progressSent >= MAX_PROGRESS) return;
    const now = Date.now();
    if (run.progressSent > 0 && now - run.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    if (passiveRemaining(run.ctx) <= 2) return; // 给最终回答留被动回复额度
    run.progressSent++;
    run.lastProgressAt = now;
    run.sentSomething = true;
    this.#queueSend(run, () => this.#sender.send(run.ctx, `⏳ ${truncate(text, 300)}`, { allowActive: false }));
  }

  /** 同一个任务的消息按顺序发送 */
  #queueSend(run: TurnRun, fn: () => Promise<unknown>): Promise<void> {
    run.sendChain = run.sendChain
      .then(fn)
      .then(
        () => undefined,
        (err) => log.error(`发送消息失败（${run.conv.key}）`, errText(err)),
      );
    return run.sendChain;
  }

  async #finishRun(run: TurnRun, turn: Turn | undefined, forced?: Turn["status"]): Promise<void> {
    if (run.finished) return;
    run.finished = true;
    for (const t of run.timers) clearTimeout(t);
    run.release();
    if (this.#runs.get(run.threadId) === run) this.#runs.delete(run.threadId);
    const conv = run.conv;
    if (conv.run === run) conv.run = undefined;

    // 兜底：如果漏掉了 item 通知，从 turn.items 里取回复
    for (const item of turn?.items ?? []) {
      const text = item.type === "agentMessage" ? item.text?.trim() : "";
      if (!text) continue;
      if (item.phase === "final_answer" && !run.finalText) run.finalText = text;
      else if (!item.phase && !run.untaggedText) run.untaggedText = text;
    }
    const status = turn?.status ?? forced ?? "failed";
    const answer = run.finalText || run.untaggedText || (status === "completed" ? run.lastText : "");
    log.info(`任务结束（${conv.key}）：${status}，用时 ${formatDuration(Date.now() - run.startedAt)}`);

    if (!run.silent) {
      await this.#queueSend(run, async () => {
        if (status === "completed") {
          await this.#sendAnswer(run, answer || "（Codex 没有返回文字内容）");
          return;
        }
        if (answer) await this.#sendAnswer(run, answer);
        if (status === "interrupted") {
          const minutes = Math.round(this.#cfg.codex.turnTimeoutMs / 60_000);
          await this.#sender.send(
            run.ctx,
            run.timedOut ? `⏱ 任务超过 ${minutes} 分钟，已自动停止。` : `⏹ 已停止当前任务${run.stopNote ? `，${run.stopNote}` : ""}。`,
          );
        } else {
          const reason = turn?.error?.message || run.errorText || "未知错误";
          await this.#sender.send(run.ctx, `❌ Codex 执行失败：${truncate(reason, 500)}`);
        }
      });
    }

    if (run.threadId !== conv.threadId) {
      void this.#unloadThread(run.threadId); // 线程已被 /new 替换
    } else {
      this.#scheduleIdleUnload(conv);
    }
    this.#pump(conv);
  }

  /** 发送回复：回复里引用的本机图片先换成说明文字，文字发完后再逐张发图片。 */
  async #sendAnswer(run: TurnRun, text: string): Promise<void> {
    const conv = run.conv;
    const reply = extractReplyImages(text.trim(), {
      cwd: run.cwd,
      maxImages: MAX_REPLY_IMAGES,
      maxBytes: MAX_IMAGE_BYTES,
      unsupported: canSendMedia(conv.scene) ? undefined : `${SCENE_LABEL[conv.scene]}里暂不支持发图片`,
    });
    // 回复只有图片时不用再发一条文字
    let body = reply.hasText ? reply.text : "";
    if (conv.notice) {
      body = body ? `${conv.notice}\n\n${body}` : conv.notice;
      conv.notice = undefined;
    }
    const { maxChunkChars, maxChunks } = this.#cfg.qq;
    let chunks = body ? chunkText(body, maxChunkChars) : [];
    if (chunks.length > maxChunks) {
      const file = this.#saveFullReply(conv, text.trim());
      chunks = chunks.slice(0, maxChunks);
      chunks[maxChunks - 1] += `\n\n…（内容太长已截断，完整回复保存在本机：${file}）`;
    }
    for (const [i, chunk] of chunks.entries()) {
      await this.#sender.send(run.ctx, chunks.length > 1 ? `【${i + 1}/${chunks.length}】\n${chunk}` : chunk);
    }
    const failed: string[] = [];
    for (const image of reply.images) {
      try {
        await this.#sender.sendImage(run.ctx, image.file);
      } catch (err) {
        log.warn(`发送图片失败（${conv.key}）：${image.file}`, errText(err));
        failed.push(`⚠️ 图片「${image.alt}」发送失败（${truncate(reasonText(err), 100)}），文件在本机：${image.file}`);
      }
    }
    if (failed.length) await this.#sender.send(run.ctx, failed.join("\n"));
    const sentImages = reply.images.length ? `，图片 ${reply.images.length - failed.length}/${reply.images.length} 张` : "";
    log.info(`已回复（${conv.key}）：${chunks.length} 条，${body.length} 字${sentImages}`);
  }

  #saveFullReply(conv: Conversation, text: string): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const file = path.join(this.#replyDir, `${stamp}-${conv.key.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 60)}.md`);
    try {
      fs.mkdirSync(this.#replyDir, { recursive: true });
      fs.writeFileSync(file, text);
    } catch (err) {
      log.error("保存完整回复失败", err);
    }
    return file;
  }

  #scheduleIdleUnload(conv: Conversation): void {
    clearTimeout(conv.idleTimer);
    conv.idleTimer = setTimeout(() => {
      if (conv.run || conv.starting || !conv.threadId || conv.loadedGen !== this.#codex.generation) return;
      conv.loadedGen = undefined;
      log.debug(`会话 ${conv.key} 空闲，卸载线程 ${conv.threadId}`);
      void this.#unloadThread(conv.threadId);
    }, IDLE_UNLOAD_MS).unref();
  }

  async #unloadThread(threadId: string): Promise<void> {
    try {
      await this.#codex.request("thread/unsubscribe", { threadId }, 15_000);
    } catch (err) {
      log.debug(`卸载线程 ${threadId} 失败：${errText(err)}`);
    }
  }

  /** /new：让会话和旧线程脱钩，下一条消息会新建线程。 */
  #detachThread(conv: Conversation): void {
    clearTimeout(conv.idleTimer);
    if (conv.threadId) {
      this.#convByThread.delete(conv.threadId);
      if (!conv.run && conv.loadedGen === this.#codex.generation) void this.#unloadThread(conv.threadId);
    }
    conv.threadId = undefined;
    conv.loadedGen = undefined;
    conv.model = undefined;
    conv.effort = undefined;
    conv.cwd = undefined;
    conv.title = undefined;
    conv.notice = undefined;
    this.#store.update(conv.key, { threadId: undefined });
  }

  #onCodexExit(reason: string): void {
    for (const run of [...this.#runs.values()]) {
      run.errorText = `Codex 服务异常退出（${reason}），本次任务已中断，请重新发送`;
      void this.#finishRun(run, undefined, "failed");
    }
  }

  async #onServerRequest(method: string, params: any): Promise<unknown> {
    const run = params?.threadId ? this.#runs.get(params.threadId) : undefined;
    const what = params?.command ? `：${truncate(String(params.command), 200)}` : "";
    log.warn(`Codex 请求审批/输入 ${method}${what}（QQ 端无法交互，已自动拒绝）`);
    if (run) run.activity = "需要审批的操作已被自动拒绝";
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return { decision: "decline" };
      case "item/permissions/requestApproval":
        return { permissions: {}, scope: "turn" };
      case "item/tool/requestUserInput":
        return { answers: {} };
      case "mcpServer/elicitation/request":
        return { action: "decline", content: null, _meta: null };
      case "execCommandApproval":
      case "applyPatchApproval":
        return { decision: { denied: { rejection: "QQ 机器人模式下无法人工审批" } } };
      default:
        throw new CodexRpcError(-32601, `QQ 机器人不支持 ${method}`);
    }
  }
}
