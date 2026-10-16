import fs from "node:fs";
import net from "node:net";
import path from "node:path";

function listen(address: string): Promise<net.Server | undefined> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? resolve(undefined) : reject(err)));
    server.listen(address, () => {
      server.unref();
      resolve(server);
    });
  });
}

function isAlive(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(address);
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * 单实例锁：同一个机器人只允许运行一个进程，避免开机自启和手动启动同时在线、重复回复。
 * Windows 用命名管道，其它系统用 dataDir 里的 unix socket；进程退出后系统自动释放。
 * 返回 undefined 表示已有实例在运行。
 */
export async function acquireInstanceLock(name: string, dataDir: string): Promise<net.Server | undefined> {
  if (process.platform === "win32") return listen(`\\\\.\\pipe\\${name}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const address = path.join(dataDir, `${name}.sock`);
  const server = await listen(address);
  if (server || (await isAlive(address))) return server;
  fs.rmSync(address, { force: true }); // 上次异常退出留下的 socket 文件
  return listen(address);
}
