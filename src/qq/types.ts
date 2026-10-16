/** 消息来源场景 */
export type Scene = "c2c" | "group" | "channel" | "dms";

export const SCENE_LABEL: Record<Scene, string> = {
  c2c: "QQ单聊",
  group: "QQ群",
  channel: "频道",
  dms: "频道私信",
};

export interface QQUser {
  id?: string;
  username?: string;
  bot?: boolean;
  user_openid?: string;
  member_openid?: string;
  union_openid?: string;
  member_role?: string;
}

export interface QQAttachment {
  url?: string;
  filename?: string;
  content_type?: string;
  size?: number;
  width?: number;
  height?: number;
  voice_wav_url?: string;
  asr_refer_text?: string;
}

export interface QQMsgElement {
  msg_idx?: string;
  author?: QQUser;
  message_type?: number;
  content?: string;
  attachments?: QQAttachment[];
  msg_elements?: QQMsgElement[];
}

/** C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE / AT_MESSAGE_CREATE / DIRECT_MESSAGE_CREATE 的事件体 */
export interface QQMessageEvent {
  id: string;
  author?: QQUser;
  content?: string;
  timestamp?: string;
  message_type?: number;
  group_openid?: string;
  group_id?: string;
  channel_id?: string;
  guild_id?: string;
  src_guild_id?: string;
  attachments?: QQAttachment[];
  mentions?: QQUser[];
  msg_elements?: QQMsgElement[];
  message_scene?: { source?: string; ext?: string[] };
}

/** FRIEND_ADD / GROUP_ADD_ROBOT 等通知类事件 */
export interface QQNoticeEvent {
  openid?: string;
  group_openid?: string;
  op_member_openid?: string;
  timestamp?: number | string;
}

export interface GatewayPayload {
  op: number;
  d?: any;
  s?: number;
  t?: string;
  id?: string;
}
