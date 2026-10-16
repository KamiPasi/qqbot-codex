import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 能发到 QQ 的图片格式 */
export const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Markdown 图片 ![说明](路径)；路径里允许一层成对的括号，例如 Program Files (x86) */
const IMAGE_MD = /!\[([^\]\n]*)\]\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/g;
const FENCE = /^\s*(```|~~~)/;
const INLINE_CODE = /(`+)[^\n]*?\1/g;
/** 处理过程中先用占位符标记要发送的图片，最后再换成说明文字 */
const MARK = /\u0000(\d+)\u0000/g;

export interface ReplyImage {
  /** 说明文字，Markdown 里没写时用文件名 */
  alt: string;
  /** 本机绝对路径 */
  file: string;
}

export interface ReplyImages {
  /** 图片语法替换成说明文字之后的回复 */
  text: string;
  /** 除了要发送的图片，回复里是否还有别的内容 */
  hasText: boolean;
  /** 要发送的图片，按出现顺序排列，同一个文件只发一次 */
  images: ReplyImage[];
}

/** 转成本机绝对路径。网络路径（\\server\share）不算，免得去访问远程共享。 */
function toLocalPath(p: string, cwd: string): string | undefined {
  let file: string;
  if (/^file:/i.test(p)) {
    try {
      file = fileURLToPath(p);
    } catch {
      return undefined;
    }
  } else if (/^~[\\/]/.test(p)) {
    file = path.join(os.homedir(), p.slice(2));
  } else {
    file = path.resolve(cwd, p);
  }
  return /^[\\/]{2}/.test(file) ? undefined : file;
}

/** 链接目标对应的本地路径候选：去掉标题和尖括号，处理 file:// 和 ~，相对路径基于 cwd。网络图片和网络路径返回空数组。 */
function localCandidates(target: string, cwd: string): string[] {
  const t = target.trim();
  const titled = /^(.+?)\s+(?:"[^"]*"|'[^']*')$/.exec(t);
  const files: string[] = [];
  for (let raw of titled ? [titled[1], t] : [t]) {
    if (raw.startsWith("<") && raw.endsWith(">")) raw = raw.slice(1, -1).trim();
    if (!raw || /^data:/i.test(raw) || (/^[a-z][a-z0-9+.-]+:\/\//i.test(raw) && !/^file:/i.test(raw))) continue;
    const variants = [raw];
    if (!/^file:/i.test(raw) && /%[0-9a-f]{2}/i.test(raw)) {
      try {
        variants.push(decodeURIComponent(raw));
      } catch {
        // 不是合法的百分号编码，按原样处理
      }
    }
    for (const v of variants) {
      const file = toLocalPath(v, cwd);
      if (file && !files.includes(file)) files.push(file);
    }
  }
  return files;
}

function statFile(file: string): fs.Stats | undefined {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 找出 Codex 回复里指向本机图片的 Markdown 图片语法 `![说明](路径)`，替换成「[图片：说明]」，
 * 返回替换后的文字和要发送的图片（最多 maxImages 张）。
 * 发不了的图片（文件不存在、格式不支持、太大、超出张数、当前场景不支持）在文字里写明原因和路径。
 * 网络图片和代码里的内容保持原样。
 */
export function extractReplyImages(
  text: string,
  opts: {
    /** 相对路径基于这个目录（Codex 的工作目录） */
    cwd: string;
    maxImages: number;
    maxBytes: number;
    /** 当前场景发不了图片的原因；有值时所有图片都只给出路径 */
    unsupported?: string;
  },
): ReplyImages {
  const images: ReplyImage[] = [];
  const indexByFile = new Map<string, number>();

  const replaceImage = (whole: string, rawAlt: string, target: string): string => {
    const files = localCandidates(target, opts.cwd);
    if (files.length === 0) return whole;
    const file = files.find((f) => statFile(f)) ?? files[0];
    const alt = rawAlt.trim();
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    const known = indexByFile.get(key);
    if (known !== undefined) return `\u0000${known}\u0000`;
    const fail = (reason: string) => `[图片${alt ? `「${alt}」` : ""}无法发送：${reason}]`;
    const stat = statFile(file);
    if (!stat) return fail(`找不到文件 ${file}`);
    if (!IMAGE_EXTS.has(path.extname(file).toLowerCase())) return fail(`只支持 png/jpg/gif/webp 格式，文件在 ${file}`);
    if (stat.size > opts.maxBytes) return fail(`超过 ${opts.maxBytes / 1024 / 1024}MB，文件在 ${file}`);
    if (opts.unsupported) return fail(`${opts.unsupported}，文件在 ${file}`);
    if (images.length >= opts.maxImages) return fail(`一次最多发 ${opts.maxImages} 张，文件在 ${file}`);
    images.push({ alt: alt || path.basename(file), file });
    indexByFile.set(key, images.length - 1);
    return `\u0000${images.length - 1}\u0000`;
  };

  /** 只处理行内代码以外的部分 */
  const replaceLine = (line: string): string => {
    let out = "";
    let last = 0;
    for (const m of line.matchAll(INLINE_CODE)) {
      out += line.slice(last, m.index).replace(IMAGE_MD, replaceImage) + m[0];
      last = m.index + m[0].length;
    }
    return out + line.slice(last).replace(IMAGE_MD, replaceImage);
  };

  let inFence = false;
  const marked = text
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : replaceLine(line);
    })
    .join("\n");

  const label = (i: number) => `[图片${images.length > 1 ? i + 1 : ""}：${images[i].alt}]`;
  return {
    text: marked.replace(MARK, (_m, i: string) => label(Number(i))),
    hasText: /\S/.test(marked.replace(MARK, "")),
    images,
  };
}
