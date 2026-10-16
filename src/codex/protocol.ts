/**
 * Codex app-server 协议中本项目用到的部分（基于 codex-cli 0.162.1）。
 * 完整类型可用 `codex app-server generate-ts --out <目录>` 生成后对照。
 */

export type UserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface Thread {
  id: string;
  path: string | null;
  cwd: string;
  name: string | null;
  /** 通常是第一条用户消息 */
  preview: string;
  /** Unix 秒 */
  createdAt: number;
  updatedAt: number;
}

/** thread/start 与 thread/resume 的返回值 */
export interface ThreadSessionResponse {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  reasoningEffort: string | null;
  sandbox: { type: string };
  approvalPolicy: unknown;
}

export interface ThreadStartParams {
  cwd?: string;
  model?: string;
  sandbox?: string;
  approvalPolicy?: string;
  developerInstructions?: string;
  ephemeral?: boolean;
  threadSource?: string;
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  cwd?: string;
  model?: string;
  effort?: string;
}

export interface TurnError {
  message: string;
  codexErrorInfo: unknown;
  additionalDetails: string | null;
}

/** ThreadItem 的宽松版本：只声明用到的字段 */
export interface ThreadItem {
  type: string;
  id: string;
  /** agentMessage / plan */
  text?: string;
  /** agentMessage："commentary"（过程说明）或 "final_answer"（最终回答） */
  phase?: string | null;
  /** commandExecution */
  command?: string;
  status?: string;
  exitCode?: number | null;
  /** mcpToolCall */
  server?: string;
  tool?: string;
  /** fileChange */
  changes?: Array<{ path: string }>;
  /** userMessage */
  content?: Array<{ type: string; text?: string }>;
}

export interface Turn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: TurnError | null;
  items: ThreadItem[];
  durationMs: number | null;
}
