/**
 * 内置推荐模型清单 v2（版本随客户端锁定，不做在线更新）。
 * 条目为纯数据：modality / files / engineArgs / 硬件门槛；新增模型不改代码。
 * sha256 为空表示暂不做校验（正式发布前必须补齐）。
 */
export const ENGINE_VERSION = "llama.cpp embedded b6230 + sd.cpp embedded 20260804";

const HF = "https://huggingface.co";
const HFM = "https://hf-mirror.com";
function mirrors(path) {
  return [HF + "/" + path, HFM + "/" + path];
}

export const MODEL_MANIFEST = [
  // ---------- 文本（llama.cpp 引擎） ----------
  {
    id: "qwen3-1.7b",
    name: "Qwen3 1.7B（轻快）",
    modality: "text",
    minTier: "lite",
    context: 8192,
    description: "入门快答，适合无独显机器（CPU 推理）",
    files: [
      { fileName: "qwen3-1.7b-q4_k_m.gguf", role: "model", sizeBytes: 1300000000, sha256: "", urls: mirrors("Qwen/Qwen3-1.7B-GGUF/resolve/main/qwen3-1.7b-q4_k_m.gguf") },
    ],
  },
  {
    id: "qwen3-4b",
    name: "Qwen3 4B（均衡）",
    modality: "text",
    minTier: "balanced",
    context: 16384,
    description: "均衡推荐，8GB 级显存流畅运行",
    files: [
      { fileName: "qwen3-4b-q4_k_m.gguf", role: "model", sizeBytes: 2700000000, sha256: "", urls: mirrors("Qwen/Qwen3-4B-GGUF/resolve/main/qwen3-4b-q4_k_m.gguf") },
    ],
  },
  {
    id: "qwen3-8b",
    name: "Qwen3 8B（高质量）",
    modality: "text",
    minTier: "high",
    context: 16384,
    description: "质量优先，需 12GB 级显存",
    files: [
      { fileName: "qwen3-8b-q4_k_m.gguf", role: "model", sizeBytes: 5100000000, sha256: "", urls: mirrors("Qwen/Qwen3-8B-GGUF/resolve/main/qwen3-8b-q4_k_m.gguf") },
    ],
  },
  {
    id: "deepseek-r1-8b",
    name: "DeepSeek-R1 蒸馏 8B（推理）",
    modality: "text",
    minTier: "balanced",
    context: 16384,
    description: "DeepSeek-R1-Distill-Qwen-8B，擅长数学/代码/深度推理",
    files: [
      { fileName: "DeepSeek-R1-Distill-Qwen-8B-Q4_K_M.gguf", role: "model", sizeBytes: 5400000000, sha256: "", urls: mirrors("bartowski/DeepSeek-R1-Distill-Qwen-8B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-8B-Q4_K_M.gguf") },
    ],
  },
  {
    id: "deepseek-r1-14b",
    name: "DeepSeek-R1 蒸馏 14B（推理）",
    modality: "text",
    minTier: "high",
    context: 16384,
    description: "DeepSeek-R1-Distill-Qwen-14B，推理质量更高，需 12GB 级显存",
    files: [
      { fileName: "DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf", role: "model", sizeBytes: 9000000000, sha256: "", urls: mirrors("bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf") },
    ],
  },
  {
    id: "kimi-k2-instruct",
    name: "Kimi-K2-Instruct（MoE 1T，极客档）",
    modality: "text",
    minTier: "high",
    minRamGb: 64,
    minDiskGb: 1200,
    confirmHuge: true,
    context: 32768,
    description: "Moonshot Kimi-K2-Instruct-0905 动态 Q4 量化，约 594GB，仅激活参数参与推理，需大内存 CPU/多卡",
    files: [
      { fileName: "Kimi-K2-Instruct-0905-UD-Q4_K_XL.gguf", role: "model", sizeBytes: 594000000000, sha256: "", urls: mirrors("unsloth/Kimi-K2-Instruct-0905-GGUF/resolve/main/Kimi-K2-Instruct-0905-UD-Q4_K_XL.gguf") },
    ],
  },
  // ---------- 图片（sd.cpp 引擎） ----------
  {
    id: "flux-schnell",
    name: "Flux.1-schnell（快速生图）",
    modality: "image",
    minTier: "balanced",
    minVramGb: 8,
    context: 0,
    description: "Black Forest Labs 快速生图模型，4 步出图，Apache 2.0 许可",
    files: [
      { fileName: "flux1-schnell-Q4_K_M.gguf", role: "model", sizeBytes: 6600000000, sha256: "", urls: mirrors("QuantStack/FLUX.1-schnell-GGUF/resolve/main/FLUX.1-schnell-Q4_K_M.gguf") },
    ],
  },
  {
    id: "qwen-image",
    name: "Qwen-Image（中文生图）",
    modality: "image",
    minTier: "balanced",
    minVramGb: 12,
    context: 0,
    description: "阿里通义 20B 生图模型，中文文字渲染能力强，Apache 2.0 许可",
    files: [
      { fileName: "Qwen-Image-Q8_0.gguf", role: "model", sizeBytes: 20500000000, sha256: "", urls: mirrors("QuantStack/Qwen-Image-GGUF/resolve/main/Qwen-Image-Q8_0.gguf") },
    ],
  },
  // ---------- 视频（sd.cpp 引擎） ----------
  {
    id: "wan2.2-ti2v-5b",
    name: "Wan2.2-TI2V-5B（文/图生视频）",
    modality: "video",
    minTier: "high",
    minVramGb: 12,
    minRamGb: 32,
    context: 0,
    description: "阿里万相 2.2 文图生视频 5B，5 秒 720p 带运动一致性，Apache 2.0 许可",
    files: [
      { fileName: "wan2.2_ti2v_5B-Q4_K_M.gguf", role: "model", sizeBytes: 3600000000, sha256: "", urls: mirrors("QuantStack/Wan2.2-TI2V-5B-GGUF/resolve/main/wan2.2_ti2v_5B-Q4_K_M.gguf") },
      { fileName: "umt5-xxl-encoder-Q4_K_M.gguf", role: "text-encoder", sizeBytes: 3100000000, sha256: "", urls: mirrors("ggml-org/umt5-xxl-encoder-GGUF/resolve/main/umt5-xxl-encoder-Q4_K_M.gguf") },
      { fileName: "wan2.2_vae.safetensors", role: "vae", sizeBytes: 320000000, sha256: "", urls: mirrors("Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors") },
    ],
  },
  {
    id: "minimax-h3-fl2va",
    name: "MiniMax H3（文生音视频 / 首尾帧）",
    modality: "video",
    minTier: "high",
    minVramGb: 12,
    minRamGb: 32,
    context: 0,
    license: "MiniMax H3 社区许可：排除美国/欧盟/英国/韩国地区使用",
    description: "33B 全模态视频模型 Q4_K_M，原生输出双声道音视频，768p/24fps，sd.cpp Day-1 支持",
    files: [
      { fileName: "minimax_h3_fl2va-Q4_K_M.gguf", role: "model", sizeBytes: 10500000000, sha256: "", urls: mirrors("Comfy-Org/MiniMax-H3-GGUF/resolve/main/minimax_h3_fl2va_q4_k_m.gguf") },
      { fileName: "qwen3vl_32b_minimax_h3-Q4_K_M.gguf", role: "text-encoder", sizeBytes: 19000000000, sha256: "", urls: mirrors("unsloth/MiniMax-H3-GGUF/resolve/main/qwen3vl_32b_minimax_h3-Q4_K_M.gguf") },
      { fileName: "minimax_h3_video_vae_int8_convrot.safetensors", role: "vae", sizeBytes: 1400000000, sha256: "", urls: mirrors("Kijai/MiniMax-H3-experimental/resolve/main/minimax_h3_video_vae_int8_convrot.safetensors") },
      { fileName: "minimax_h3_audio_vae_fp32.safetensors", role: "audio-vae", sizeBytes: 850000000, sha256: "", urls: mirrors("Kijai/MiniMax-H3-experimental/resolve/main/minimax_h3_audio_vae_fp32.safetensors") },
    ],
  },
];

export function modelById(id) {
  return MODEL_MANIFEST.find((model) => model.id === id) || null;
}

export function modelFiles(model) {
  return model.files || [];
}

export function modelSizeBytes(model) {
  return modelFiles(model).reduce((sum, file) => sum + (file.sizeBytes || 0), 0);
}

export function primaryFileName(model) {
  const files = modelFiles(model);
  const main = files.find((file) => file.role === "model") || files[0];
  return main ? main.fileName : "";
}

export function recommendedModelId(tier, modality = "text") {
  if (modality === "image") {
    return tier === "high" ? "qwen-image" : "flux-schnell";
  }
  if (modality === "video") {
    return tier === "high" ? "minimax-h3-fl2va" : "wan2.2-ti2v-5b";
  }
  if (tier === "high") return "qwen3-8b";
  if (tier === "balanced") return "qwen3-4b";
  return "qwen3-1.7b";
}

export function tierAllows(tier, minTier) {
  const order = { lite: 0, balanced: 1, high: 2 };
  return (order[tier] ?? 0) >= (order[minTier] ?? 0);
}

/**
 * 模型下载/启动门禁：档位 + 显存 + 内存 + 磁盘。
 * hardware 为 detectHardware() 的结果（tier/vramBytes/totalRamBytes/freeDiskBytes）。
 */
export function modelGate(hardware, model) {
  if (!tierAllows(hardware.tier, model.minTier)) {
    return { ok: false, reason: "硬件档位不足（需 " + model.minTier + " 档）" };
  }
  const GB = 1024 ** 3;
  if (model.minVramGb && (hardware.vramBytes || 0) < model.minVramGb * GB) {
    return { ok: false, reason: "需要显存 ≥ " + model.minVramGb + "GB" };
  }
  if (model.minRamGb && (hardware.totalRamBytes || 0) < model.minRamGb * GB) {
    return { ok: false, reason: "需要内存 ≥ " + model.minRamGb + "GB" };
  }
  if (model.minDiskGb && (hardware.freeDiskBytes || 0) < model.minDiskGb * GB) {
    return { ok: false, reason: "需要磁盘可用 ≥ " + model.minDiskGb + "GB" };
  }
  return { ok: true, reason: "" };
}
