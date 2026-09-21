/**
 * 硬件探测与三档分级：轻量（仅文本）/ 均衡（文本+图片）/ 高质量（文本+图片+视频）
 * 依据既定决策：AMD 显卡归"仅文本"档；N 卡 >=12GB 高质量，>=6GB 均衡，其余轻量。
 * 二期扩展：显存/内存阈值 → capabilities 门禁（WMI AdapterRAM 有 4GB 上限，N 卡显存优先 nvidia-smi）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statfs } from "node:fs/promises";
import { totalmem } from "node:os";

const execFileAsync = promisify(execFile);

async function probeGpus() {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "(Get-CimInstance Win32_VideoController | ForEach-Object { \$_.Name + '|' + \$_.AdapterRAM }) -join [Environment]::NewLine",
      ],
      { timeout: 10000, windowsHide: true },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.lastIndexOf("|");
        if (separator <= 0) return null;
        return {
          name: line.slice(0, separator).trim(),
          adapterRamBytes: Number(line.slice(separator + 1)) || 0,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** WMI AdapterRAM 为 32 位值（上限约 4GB），N 卡真实显存改查 nvidia-smi */
async function probeNvidiaVramBytes() {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      { timeout: 8000, windowsHide: true },
    );
    const mibs = stdout
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (!mibs.length) return 0;
    return Math.max(...mibs) * 1024 ** 2;
  } catch {
    return 0;
  }
}

export function classifyTier(gpus) {
  const nvidia = gpus.find((gpu) => /nvidia|geforce|rtx|gtx|quadro/i.test(gpu.name));
  if (nvidia && nvidia.vramBytes >= 12 * 1024 ** 3) {
    return { tier: "high", gpuName: nvidia.name, reason: "N 卡显存 >=12GB，可跑高质量文本/图片/视频模型" };
  }
  if (nvidia && nvidia.vramBytes >= 6 * 1024 ** 3) {
    return { tier: "balanced", gpuName: nvidia.name, reason: "N 卡显存 6~12GB，可跑均衡档模型" };
  }
  if (nvidia) {
    return { tier: "lite", gpuName: nvidia.name, reason: "显存不足 6GB，仅建议轻量小模型" };
  }
  return { tier: "lite", gpuName: "", reason: "未检测到 N 卡独显（AMD/核显按轻量档处理），走 CPU 推理" };
}

export async function detectHardware(storagePath) {
  const gpus = await probeGpus();
  const nvidiaGpu = gpus.find((gpu) => /nvidia|geforce|rtx|gtx|quadro/i.test(gpu.name));
  if (nvidiaGpu) {
    const realVram = await probeNvidiaVramBytes();
    if (realVram > nvidiaGpu.adapterRamBytes) nvidiaGpu.vramBytes = realVram;
    else nvidiaGpu.vramBytes = nvidiaGpu.adapterRamBytes;
  }
  for (const gpu of gpus) if (!gpu.vramBytes) gpu.vramBytes = gpu.adapterRamBytes;
  const { tier, gpuName, reason } = classifyTier(gpus);
  let freeDiskBytes = 0;
  try {
    const usage = await statfs(storagePath || process.cwd());
    freeDiskBytes = usage.bavail * usage.bsize;
  } catch {
    freeDiskBytes = 0;
  }
  const vramBytes = nvidiaGpu ? nvidiaGpu.vramBytes : 0;
  const totalRamBytes = totalmem();
  // 能力门禁：图片需 N 卡 >=8GB；视频需 N 卡 >=12GB 且内存 >=32GB
  const capabilities = {
    text: true,
    image: vramBytes >= 8 * 1024 ** 3,
    video: vramBytes >= 12 * 1024 ** 3 && totalRamBytes >= 32 * 1024 ** 3,
  };
  const modalities = ["text"];
  if (capabilities.image) modalities.push("image");
  if (capabilities.video) modalities.push("video");
  return {
    tier,
    gpuName,
    reason,
    gpus,
    vramBytes,
    totalRamBytes,
    freeDiskBytes,
    capabilities,
    modalities,
  };
}
