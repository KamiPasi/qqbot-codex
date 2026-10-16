# QQ 机器人 × Codex

把 QQ 官方机器人接到本机的 Codex（`codex app-server`），在 QQ 里直接和 Codex 对话、让它干活。

```
QQ 用户 ──消息──▶ QQ 开放平台 ──WebSocket 事件──▶ 本程序 ──JSON-RPC (stdio)──▶ codex app-server ──▶ 模型 / 本机命令 / MCP
   ▲                                                  │
   └──────────── 回复（QQ OpenAPI）◀─────────────────────┘
```

- 每个 QQ 会话（单聊、群、频道子频道）对应一个 Codex 线程。对应关系存在 `data/sessions.json`，重启后可以接着聊。线程在 Codex 桌面版和 `codex resume` 里也能看到，用第一句话命名，例如「QQ·帮我看下昨天的销售」。
- Codex 会沿用 `~/.codex/config.toml` 里的模型、MCP、技能等配置，`.env` 里也可以单独覆盖。
- 运行时没有第三方依赖：只用到 Node 22 自带的 `fetch`、`WebSocket` 和 TypeScript 类型剥离。

## 快速开始

1. 环境：Node.js ≥ 22.18，以及已经登录的 Codex CLI（`codex login status` 能看到登录状态）。
2. 在 [QQ 开放平台](https://q.qq.com) 创建机器人，在「开发 → 开发设置」里拿到 AppID 和 AppSecret。
3. 下载代码：`git clone https://github.com/KamiPasi/qqbot-codex.git`。运行时没有第三方依赖，不需要 `npm install`（它只用于类型检查和测试）。
4. 复制 `.env.example` 为 `.env`，填入 `QQ_APP_ID` 和 `QQ_APP_SECRET`，其他项按需修改。
5. 自检：`npm run check`。它会依次验证 QQ 凭据、Codex app-server 和网关地址。
6. 启动：Windows 上双击 `start.bat`（带守护进程，异常退出会自动重启）；macOS / Linux 用 `npm run supervise`（作者只在 Windows 上测试过）。调试时可以用 `npm start` 直接运行。
7. 在 QQ 里给机器人发 `/whoami`，把返回的 ID 填进 `.env` 的 `QQ_ALLOWED_USERS`。保存后立即生效，不用重启。
8. 直接发消息，开始对话。

### QQ 开放平台那边要做的

- 机器人还没上线（未过审）时，只有沙箱里的用户和群能用。到 q.qq.com 打开你的机器人，在「开发 → 沙箱配置」里加入自己的 QQ 号和测试群。
- 单聊：用手机 QQ 扫机器人资料页的二维码，或打开分享链接，添加机器人为好友。
- 群聊：把机器人拉进群，然后 `@机器人 问题`。
- 如果在「开发设置」里开启了 IP 白名单，需要把本机的公网出口 IP 加进去。

## 在 QQ 里怎么用

| 指令 | 作用 |
| --- | --- |
| 直接发消息 | 和 Codex 对话。任务还在进行时再发消息，会追加给正在执行的任务 |
| `/new [内容]` | 开启新会话，可以直接带上第一句话。旧会话会保留，之后还能切回去 |
| `/threads` | 列出当前 QQ 会话用过的线程 |
| `/threads all` | 列出本机最近的全部 Codex 线程，包括桌面版和 CLI 创建的（只能在单聊里用） |
| `/switch 序号` | 切换到列表里的线程接着聊，会回显上次的问答。也可以填线程 ID 或它的前几位 |
| `/stop` | 停止当前任务 |
| `/status` | 查看线程、模型、工作目录、运行状态 |
| `/model [名称\|default]` | 查看可用模型或切换模型 |
| `/effort [强度\|default]` | 查看或切换推理强度（例如 low / medium / high / xhigh） |
| `/cwd [路径\|default]` | 查看或切换 Codex 的工作目录 |
| `/whoami` | 查看自己的 ID（不在白名单的人也能用） |
| `/help` | 显示帮助 |

中文指令也可以用：`/新会话`、`/线程`、`/切换 2`、`/停止`、`/状态`、`/帮助`、`/模型`。

切换线程的几点说明：
- 新线程用第一句话命名，例如「QQ·帮我看下昨天的销售」。在 Codex 桌面版里也能看到这些线程，并接着聊。
- 群聊里只能切换本群用过的线程，`/threads all` 只能在单聊里用，避免把你电脑上的其他会话暴露给群成员。
- 切到桌面版创建的线程后，工作目录会跟着那个线程走。不要在桌面版和 QQ 里同时操作同一个线程。
- 一个线程同一时间只能属于一个 QQ 会话；任务进行中不能切换，需要先 `/stop`。

- 群里需要 @机器人。默认全群共用一个会话（`QQ_GROUP_SESSION=shared`），每条消息会带上发送者标记。改成 `user` 后，群里每人各用一个会话。
- 识图：直接发图片，可以同时带上文字（例如「图里写了什么」）。图片会下载到 `data/attachments/` 交给 Codex 看。其他文件也存到这个目录，并把本地路径告诉 Codex；语音使用平台的语音识别文字。
- 发图片：让 Codex 画图表、截图时，它会在回复里写 `![说明](图片路径)`。程序把这段换成「[图片：说明]」，文字发完后再把图片一张张发过来。支持 png / jpg / gif / webp，单张不超过 5MB，一次最多 3 张；发不出去时会告诉你图片在本机的路径。只支持单聊和群聊，频道里只给出路径。
- 升级到支持发图片的版本之前创建的会话，Codex 还不知道可以发图片，先发 `/new` 开个新会话。
- Codex 处理时，单聊会显示“正在输入”，中途的进度说明（例如“我先看看目录结构”）也会转发过来，可以用 `QQ_PROGRESS=false` 关闭。

## 安全须知（请务必看）

- **白名单里的人，等于可以让 Codex 在这台电脑上执行命令。** 沙箱默认沿用 `~/.codex/config.toml`；如果那里配置的是 `sandbox_mode = "danger-full-access"` 加 `approval_policy = "never"`，就是完全访问、不需要审批。只把信任的人加进白名单；`QQ_ALLOWED_GROUPS` 会放行整个群，要更谨慎。
- 想限制权限，可以在 `.env` 里设置 `CODEX_SANDBOX=read-only` 或 `workspace-write`。注意：作者在 Windows 上测试时，沙箱模式下出现过命令卡住、工作区内写文件也失败的情况，改之前建议先测试一下。
- QQ 里没法点“同意”，所以审批策略建议保持 `never`。如果 Codex 发起了需要审批的操作，程序会自动拒绝，并在日志里记一条警告。
- `.env` 里有 AppSecret，不要提交到 git，也不要发给别人。如果泄露了，到开放平台重置密钥，再更新 `.env`。

## QQ 平台的限制（代码里已经处理）

- 被动回复：单聊收到消息后 60 分钟内最多回 4 条，群聊 5 分钟内最多回 5 条。超出后自动改发主动消息；主动消息有频率限制，用户也可以在 QQ 里关闭接收。
- 长回复会自动拆分，每条不超过 1800 字，最多发 5 条；更长的部分完整保存在 `data/replies/`。
- Markdown：默认先尝试发送 Markdown，机器人没有这个权限时自动改用纯文本，之后不再尝试。
- 未报备的链接会被平台拦截：程序会把链接里的 `.` 改成 `[.]` 后重新发送。
- 发图片要先上传：程序用 `file_data`（base64）直接上传，拿到 `file_info` 再发富媒体消息。直接上传的上限是 5MB，更大的图片要用分片上传，目前还不支持。每张图片和文字一样占一次被动回复。
- 网关断线会自动重连，并恢复会话、补收断线期间的消息；Codex app-server 意外退出后也会自动重启。

## 开机自启和自动重启

- 设置开机自启（Windows）：按 Win+R 输入 `shell:startup` 打开「启动」文件夹，右键 `start.bat` →「创建快捷方式」，把快捷方式放进这个文件夹，再在快捷方式属性里把「运行方式」设为「最小化」。之后每次登录 Windows 都会自动运行。注意是**登录后**才启动，开机停在登录界面时不会运行。只要电脑登录着，白名单里的人随时都能让 Codex 操作这台电脑。
- `start.bat` 运行的是守护进程 `scripts/supervisor.ts`：机器人崩溃，或开机时网络还没准备好，都会自动重启。重启间隔从 5 秒开始翻倍，最长 5 分钟；连续运行 10 分钟以上后再出问题，间隔重新从 5 秒算。
- 下面这些情况重启也没用，守护进程会停下来不再重试，窗口保留并显示原因（日志里也有）：配置写错、AppID/AppSecret 不正确、机器人被封禁或下架、已经有一个实例在运行。处理好之后重新双击 `start.bat`。
- 同一个机器人同时只能运行一个实例。开机自启的那个还在运行时再双击 `start.bat`，新开的会提示后退出。要手动重启，先关掉原来的窗口。
- 停止：在窗口里按 Ctrl+C，或者直接关掉窗口。
- 关闭自启：删掉启动文件夹里的那个快捷方式，或者在任务管理器的「启动应用」里禁用它。

## 配置项

完整说明见 `.env.example`，常用的几项：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `QQ_ALLOWED_USERS` | 空 | 允许使用的用户 ID，逗号分隔，`*` 表示所有人。同一个人在单聊和群里的 ID 不同 |
| `QQ_ALLOWED_GROUPS` | 空 | 允许使用的群 ID |
| `QQ_INTENTS` | `GROUP_AND_C2C_EVENT,PUBLIC_GUILD_MESSAGES` | 订阅的事件 |
| `QQ_MARKDOWN` | `auto` | `auto` / `on` / `off` |
| `CODEX_CWD` | `./workspace` | Codex 的工作目录。可以在里面放 `AGENTS.md` 写给 Codex 的规则 |
| `CODEX_MODEL` / `CODEX_EFFORT` | 沿用 config.toml | 默认模型和推理强度。xhigh 比较慢，聊天场景可以考虑 medium |
| `CODEX_SANDBOX` | 沿用 config.toml | `read-only` / `workspace-write` / `danger-full-access` |
| `CODEX_INSTRUCTIONS` | 空 | 追加给 Codex 的人设或规则（`\n` 表示换行） |
| `CODEX_MAX_CONCURRENT` | `3` | 同时运行的任务数上限 |
| `CODEX_TURN_TIMEOUT_MIN` | `30` | 单个任务超时自动停止的时间（分钟） |

## 目录结构

```
start.bat              双击启动（运行守护进程）
scripts/
  supervisor.ts        守护进程：异常退出自动重启，退出码 2（配置/凭据等问题）时停止
src/
  main.ts              入口：加载配置、自检、启动各模块、白名单热更新
  config.ts            .env 解析
  lock.ts              单实例锁（命名管道），防止同一个机器人重复运行
  qq/
    token.ts           access_token 获取与自动刷新
    api.ts             OpenAPI（api.bot.qq.com）
    gateway.ts         WebSocket 网关：鉴权、心跳、断线重连与会话恢复
    sender.ts          发消息：被动/主动切换、Markdown 降级、链接处理、限流重试、上传和发送图片
  codex/
    appServer.ts       管理 codex app-server 子进程，处理 JSON-RPC
    protocol.ts        用到的协议类型
  bridge/
    bridge.ts          QQ 消息与 Codex 线程/turn 的桥接、指令处理
    sessions.ts        会话与线程的对应关系（data/sessions.json）
    attachments.ts     收到的图片和文件下载
    images.ts          从 Codex 回复里找出要发给用户的本机图片
data/                  运行数据：sessions.json、logs/、attachments/、replies/
workspace/             Codex 的默认工作目录
```

## 常见问题

- **机器人不回复**：先看终端日志里有没有“收到 …”。没有的话，检查 QQ 号或群是否在沙箱名单里。日志显示“未授权”的话，把日志里打印的 ID 加进白名单。
- **启动时报 4014 intent 无权限**：`QQ_INTENTS` 里有机器人没开通的事件，删掉对应项即可。
- **想换人设或加规则**：用 `CODEX_INSTRUCTIONS`，或者在工作目录里写 `AGENTS.md`。
- **开机后机器人没上线**：打开任务栏上最小化的「QQ Codex Bot」窗口看最后几行。如果是「不再自动重启」，按上一行给出的原因处理；如果是网络问题，它会自己重试。
- **窗口里提示「已经有一个实例在运行」**：开机自启的那个已经在运行了，不用再手动启动。
- **日志**：在 `data/logs/bot-日期.log`；`LOG_LEVEL=debug` 会额外记录 Codex 的 stderr 和执行过的命令。

## 开发

```bash
npm test            # 单元测试（含用假 Codex 跑通的桥接流程）
npm run typecheck   # TypeScript 类型检查
```

协议参考：`codex app-server generate-ts --out <目录>` 可以生成当前 Codex 版本完整的协议类型；QQ 侧参考 https://bot.q.qq.com/wiki/develop/api-v2/ 。

## 许可证

[MIT](LICENSE)
