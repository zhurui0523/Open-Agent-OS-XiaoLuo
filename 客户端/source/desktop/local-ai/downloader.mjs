/**
 * 模型下载器 v2：多文件编排（files 顺序下载）、HTTP Range 断点续传、
 * 2 倍磁盘预检、重试 3 次、逐文件 sha256 校验、聚合进度事件。
 * 已落盘文件跨会话不重复下载（大模型友好）。
 */
import { createWriteStream, createReadStream, statSync, renameSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { join } from "node:path";
import { mutateState } from "./state.mjs";
import { modelFiles, modelSizeBytes } from "./manifest.mjs";

const tasks = new Map(); // modelId -> task
let eventSink = () => {};
export function setDownloadEventSink(fn) { eventSink = fn; }

function emit(type, payload) {
  mutateState((state) => { state.download = type === "download-progress" || type === "download-status" ? { ...payload, type } : null; });
  try { eventSink({ type, ...payload }); } catch {}
}

function request(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, { headers }, (res) => resolve(res));
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("连接超时")));
  });
}

async function followRedirects(url, headers, redirects = 5) {
  let res = await request(url, headers);
  while ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
    res.destroy();
    res = await request(new URL(res.headers.location, url).toString(), headers);
    redirects -= 1;
  }
  return res;
}

async function checkDisk(storagePath, sizeBytes) {
  try {
    mkdirSync(storagePath, { recursive: true });
    const usage = await statfs(storagePath);
    const free = usage.bavail * usage.bsize;
    if (free < sizeBytes * 2) {
      throw new Error("磁盘空间不足：需要约 " + Math.ceil((sizeBytes * 2) / 1024 ** 3) + "GB 可用");
    }
  } catch (error) {
    if (error.code === "ENOSPC") throw new Error("磁盘空间不足");
    throw error;
  }
}

function computeSha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function downloadedBytesBefore(task, index) {
  let sum = 0;
  for (let i = 0; i < index; i += 1) {
    const file = task.files[i];
    if (file.done) sum += file.sizeBytes;
  }
  return sum;
}

function downloadFileOnce(task, file) {
  return new Promise(async (resolve, reject) => {
    const resumeFrom = existsSync(file.partPath) ? statSync(file.partPath).size : 0;
    const headers = {};
    if (resumeFrom > 0) headers.range = "bytes=" + resumeFrom + "-";
    let res;
    try {
      res = await followRedirects(file.urls[file.urlIndex], headers);
    } catch (error) {
      reject(error);
      return;
    }
    if (res.statusCode === 416) {
      // 已下载完整：交给校验
      res.destroy();
      resolve(resumeFrom);
      return;
    }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.destroy();
      reject(new Error("下载源返回 HTTP " + res.statusCode));
      return;
    }
    if (res.statusCode === 200 && resumeFrom > 0) {
      // 服务端不支持 Range：从头下
      try { unlinkSync(file.partPath); } catch {}
      file.received = 0;
    } else {
      file.received = resumeFrom;
    }
    const total = Number(res.headers["content-length"] || 0) + file.received;
    file.total = total || file.sizeBytes;
    const out = createWriteStream(file.partPath, { flags: res.statusCode === 200 ? "w" : "a" });
    let lastEmit = 0;
    const start = Date.now();
    const baseBytes = downloadedBytesBefore(task, task.files.indexOf(file));
    res.on("data", (chunk) => {
      file.received += chunk.length;
      const now = Date.now();
      if (now - lastEmit > 500) {
        lastEmit = now;
        const elapsed = Math.max(1, (now - start) / 1000);
        emit("download-progress", {
          modelId: task.modelId,
          fileIndex: task.files.indexOf(file),
          fileCount: task.files.length,
          fileName: file.fileName,
          receivedBytes: baseBytes + file.received,
          totalBytes: task.totalBytes,
          speedBps: Math.round((file.received - resumeFrom) / elapsed),
        });
      }
      if (task.paused) res.pause();
    });
    res.pipe(out);
    out.on("finish", () => resolve(file.received));
    out.on("error", reject);
    res.on("error", reject);
    task.resumeFn = () => res.resume();
    task.abortFn = () => { res.destroy(new Error("cancelled")); };
  });
}

async function runFile(task, file, fileIndex) {
  while (file.attempts < 3 && !task.cancelled && !task.paused) {
    try {
      await downloadFileOnce(task, file);
      if (task.cancelled || task.paused) return false;
      if (file.sha256) {
        emit("download-status", { modelId: task.modelId, status: "verifying", fileIndex, fileCount: task.files.length, fileName: file.fileName });
        const digest = await computeSha256(file.partPath);
        if (digest.toLowerCase() !== file.sha256.toLowerCase()) {
          try { unlinkSync(file.partPath); } catch {}
          throw new Error("校验失败，已删除并准备重下");
        }
      }
      renameSync(file.partPath, file.targetPath);
      file.done = true;
      return true;
    } catch (error) {
      if (task.cancelled || task.paused) return false;
      file.attempts += 1;
      file.urlIndex = (file.urlIndex + 1) % file.urls.length;
      task.error = error instanceof Error ? error.message : String(error);
      emit("download-status", { modelId: task.modelId, status: "retrying", fileIndex, fileCount: task.files.length, attempt: file.attempts, error: task.error });
      await new Promise((r) => setTimeout(r, 1500 * file.attempts));
    }
  }
  return false;
}

async function runTask(task) {
  for (let i = 0; i < task.files.length; i += 1) {
    const file = task.files[i];
    if (file.done) continue;
    if (task.cancelled) return;
    if (task.paused) {
      task.status = "paused";
      emit("download-status", { modelId: task.modelId, status: "paused", fileIndex: i, fileCount: task.files.length });
      return;
    }
    task.status = "downloading";
    emit("download-status", { modelId: task.modelId, status: "downloading", fileIndex: i, fileCount: task.files.length, fileName: file.fileName });
    const ok = await runFile(task, file, i);
    if (!ok) {
      if (task.cancelled) return;
      if (task.paused) {
        task.status = "paused";
        emit("download-status", { modelId: task.modelId, status: "paused", fileIndex: i, fileCount: task.files.length });
        return;
      }
      task.status = "failed";
      emit("download-status", { modelId: task.modelId, status: "failed", fileIndex: i, fileCount: task.files.length, error: task.error || "下载失败" });
      return;
    }
  }
  task.status = "done";
  emit("download-status", { modelId: task.modelId, status: "done", fileCount: task.files.length });
}

export async function startDownload(model, storagePath) {
  if (tasks.has(model.id)) {
    const existing = tasks.get(model.id);
    if (["downloading", "verifying"].includes(existing.status)) return existing;
  }
  // 兼容一期单文件条目（无 files 字段）
  const rawFiles = modelFiles(model).length
    ? modelFiles(model)
    : [{ fileName: model.fileName, role: "model", sizeBytes: model.sizeBytes, sha256: model.sha256 || "", urls: model.urls }];
  const totalBytes = rawFiles.reduce((sum, file) => sum + (file.sizeBytes || 0), 0) || modelSizeBytes(model);
  await checkDisk(storagePath, totalBytes);
  const files = rawFiles.map((file) => {
    const targetPath = join(storagePath, file.fileName);
    return {
      fileName: file.fileName,
      role: file.role || "model",
      sizeBytes: file.sizeBytes || 0,
      sha256: file.sha256 || "",
      urls: file.urls || [],
      targetPath,
      partPath: targetPath + ".part",
      // 跨会话续传：已完整落盘的文件跳过
      done: existsSync(targetPath) && statSync(targetPath).size >= (file.sizeBytes || 1),
      received: 0,
      total: file.sizeBytes || 0,
      attempts: 0,
      urlIndex: 0,
    };
  });
  const task = {
    modelId: model.id,
    files,
    totalBytes,
    status: "queued",
    paused: false,
    cancelled: false,
    error: "",
    resumeFn: null,
    abortFn: null,
  };
  tasks.set(model.id, task);
  void runTask(task);
  return task;
}

export function pauseDownload(modelId) {
  const task = tasks.get(modelId);
  if (!task || task.status !== "downloading") return;
  task.paused = true;
}

export function resumeDownload(modelId) {
  const task = tasks.get(modelId);
  if (!task) return;
  if (task.status === "downloading" && task.paused) {
    task.paused = false;
    task.resumeFn?.();
    return;
  }
  if (["paused", "failed"].includes(task.status)) {
    task.paused = false;
    task.status = "queued";
    task.files.forEach((file) => { file.attempts = 0; });
    void runTask(task);
  }
}

export function cancelDownload(modelId) {
  const task = tasks.get(modelId);
  if (!task) return;
  task.cancelled = true;
  task.abortFn?.();
  for (const file of task.files) {
    try { if (existsSync(file.partPath)) unlinkSync(file.partPath); } catch {}
  }
  tasks.delete(modelId);
  emit("download-status", { modelId, status: "cancelled" });
}

export function getDownloadTask(modelId) {
  return tasks.get(modelId) || null;
}
