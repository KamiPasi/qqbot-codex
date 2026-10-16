import { spawn } from "node:child_process";
import { createLogger } from "./log.ts";

const log = createLogger("console");

/** 窗口标题，和 start.bat 里设置的一致 */
const WINDOW_TITLE = "QQ Codex Bot";

/** 通过 kernel32 的 SetConsoleMode 去掉 ENABLE_QUICK_EDIT_MODE(0x40)；改这个标志必须同时带上 ENABLE_EXTENDED_FLAGS(0x80) */
const SCRIPT = `
$sig = @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int nStdHandle);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr hConsoleHandle, out uint lpMode);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr hConsoleHandle, uint dwMode);
'@
$k = Add-Type -MemberDefinition $sig -Name ConsoleMode -Namespace QQBotCodex -PassThru
$h = $k::GetStdHandle(-10)
$m = [uint32]0
if (-not $k::GetConsoleMode($h, [ref]$m)) { exit 2 }
if (-not $k::SetConsoleMode($h, [uint32](($m -band 0xFFFFFFBFL) -bor 0x80))) { exit 3 }
`;

/**
 * Windows 控制台默认开着「快速编辑」：在窗口里点一下就会进入选择状态（标题前面出现「选择」），
 * 之后所有往这个窗口写日志的进程都会被挂起——心跳停了、消息也不处理，直到按 Esc。
 * 机器人长期挂在窗口里运行，所以启动时把当前窗口的快速编辑关掉（不影响其他窗口）。
 */
export function disableQuickEdit(): void {
  if (process.platform !== "win32" || !process.stdin.isTTY) return;
  // stdin 继承控制台，PowerShell 才能拿到这个窗口的输入句柄
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")],
    { stdio: ["inherit", "ignore", "ignore"] },
  );
  const warn = () => log.warn("没能关闭控制台的快速编辑：在窗口里点击会让机器人暂停，标题出现「选择」时按 Esc 恢复");
  child.once("error", warn);
  child.once("exit", (code) => {
    process.title = WINDOW_TITLE; // PowerShell 启动时会把窗口标题改成「Windows PowerShell」，改回来
    if (code === 0) log.debug("已关闭控制台的快速编辑");
    else warn();
  });
  child.unref();
}
