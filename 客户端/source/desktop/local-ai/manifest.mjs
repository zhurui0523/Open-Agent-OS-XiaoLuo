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

/** 超大模型按分片生成 files 清单（首个分片即 llama.cpp --model 入口） */
function ggufShards(repo, folder, baseName, shardSizes) {
  const total = shardSizes.length;
  return shardSizes.map((gb, i) => {
    const idx = String(i + 1).padStart(5, "0");
    const fileName = baseName + "-" + idx + "-of-" + String(total).padStart(5, "0") + ".gguf";
    return {
      fileName,
      role: "model",
      sizeBytes: Math.round(gb * 1e9),
      sha256: "",
      urls: mirrors(repo + "/resolve/main/" + folder + "/" + fileName),
    };
  });
}

// Kimi K3 UD-Q4_K_XL：32 分片，合计约 1.51TB
const KIMI_K3_SHARDS = [
  0.007, 47.5, 49.2, 49, 49, 49.1, 49.2, 49, 49, 49.1, 49.2, 49, 49, 49.1, 49.2, 49,
  49, 49.1, 49.2, 49, 49, 49.1, 49.2, 49, 49, 49.1, 49.2, 49, 49, 49.1, 49.2, 37.8,
];
// Qwen3.8 Max（2.4T-A95B MoE）UD-Q1_0：10 分片，合计约 397GB
const QWEN38_MAX_SHARDS = [0.011, 48.8, 50, 49.1, 49, 49.1, 48.7, 49, 47.8, 5.82];

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
  {
    id: "qwen3.8-27b",
    name: "Qwen3.8 27B（最新旗舰）",
    modality: "text",
    minTier: "high",
    context: 32768,
    description: "Qwen3.8-27B 动态 4 位量化（Unsloth Dynamic V3），智能体编码/长上下文能力强，建议 16GB 级显存或 24GB 统一内存",
    files: [
      { fileName: "Qwen3.8-27B-UD-Q4_K_XL.gguf", role: "model", sizeBytes: 17600000000, sha256: "", urls: mirrors("unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-UD-Q4_K_XL.gguf") },
    ],
  },
  {
    id: "qwen3.8-max",
    name: "Qwen3.8 Max 2.4T-A95B（MoE，极客档）",
    modality: "text",
    minTier: "high",
    minRamGb: 512,
    minDiskGb: 900,
    confirmHuge: true,
    context: 32768,
    description: "Qwen3.8 家族旗舰（2.4T 参数 / 95B 激活）UD-Q1_0 量化，约 397GB，需超大内存多卡或纯 CPU 集群",
    files: ggufShards("unsloth/Qwen3.8-2.4T-A95B-GGUF", "UD-Q1_0", "Qwen3.8-2.4T-A95B-UD-Q1_0", QWEN38_MAX_SHARDS),
  },
  {
    id: "kimi-k3",
    name: "Kimi K3（MoE，极客档）",
    modality: "text",
    minTier: "high",
    minRamGb: 256,
    minDiskGb: 3200,
    confirmHuge: true,
    context: 32768,
    description: "Moonshot Kimi K3 动态 Q4 量化（32 分片），约 1.51TB，仅激活参数参与推理，需大内存多卡",
    files: ggufShards("unsloth/Kimi-K3-GGUF", "UD-Q4_K_XL", "Kimi-K3-UD-Q4_K_XL", KIMI_K3_SHARDS),
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash（Q4 专家）",
    modality: "text",
    minTier: "high",
    minRamGb: 128,
    minDiskGb: 400,
    confirmHuge: true,
    context: 32768,
    description: "DeepSeek-V4-Flash Q4 专家 imatrix 量化，约 165GB，兼顾质量与部署门槛",
    files: [
      { fileName: "DeepSeek-V4-Flash-Q4KExperts-F16HC-F16Compressor-F16Indexer-Q8Attn-Q8Shared-Q8Out-chat-v2-imatrix-0731.gguf", role: "model", sizeBytes: 165000000000, sha256: "", urls: mirrors("antirez/deepseek-v4-gguf/resolve/main/DeepSeek-V4-Flash-Q4KExperts-F16HC-F16Compressor-F16Indexer-Q8Attn-Q8Shared-Q8Out-chat-v2-imatrix-0731.gguf") },
    ],
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro（Q2，极客档）",
    modality: "text",
    minTier: "high",
    minRamGb: 256,
    minDiskGb: 1000,
    confirmHuge: true,
    context: 32768,
    description: "DeepSeek-V4-Pro Q2 imatrix 量化，约 465GB，完整旗舰能力，需大内存多卡",
    files: [
      { fileName: "DeepSeek-V4-Pro-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-Instruct-imatrix-0813.gguf", role: "model", sizeBytes: 465000000000, sha256: "", urls: mirrors("antirez/deepseek-v4-gguf/resolve/main/DeepSeek-V4-Pro-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-Instruct-imatrix-0813.gguf") },
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
