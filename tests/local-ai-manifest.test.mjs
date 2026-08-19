import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_MANIFEST,
  modelById,
  modelFiles,
  modelSizeBytes,
  primaryFileName,
  recommendedModelId,
  tierAllows,
  modelGate,
} from "../desktop/local-ai/manifest.mjs";

const GB = 1024 ** 3;

test("manifest covers the seven model families across three modalities", () => {
  const ids = MODEL_MANIFEST.map((m) => m.id);
  for (const id of [
    "qwen3-1.7b",
    "qwen3-4b",
    "qwen3-8b",
    "deepseek-r1-8b",
    "deepseek-r1-14b",
    "kimi-k2-instruct",
    "flux-schnell",
    "qwen-image",
    "wan2.2-ti2v-5b",
    "minimax-h3-fl2va",
  ]) {
    assert.ok(ids.includes(id), "缺少模型 " + id);
  }
  const modalities = new Set(MODEL_MANIFEST.map((m) => m.modality));
  assert.deepEqual([...modalities].sort(), ["image", "text", "video"]);
});

test("every entry declares files with role/size/urls and consistent total size", () => {
  for (const model of MODEL_MANIFEST) {
    const files = modelFiles(model);
    assert.ok(files.length >= 1, model.id + " 缺少 files");
    for (const file of files) {
      assert.ok(file.fileName, model.id + " 文件缺少 fileName");
      assert.ok(["model", "text-encoder", "vae", "audio-vae"].includes(file.role), model.id + " 非法 role");
      assert.ok(file.sizeBytes > 0, model.id + " 文件缺少 sizeBytes");
      assert.ok(Array.isArray(file.urls) && file.urls.length >= 1, model.id + " 缺少下载镜像");
    }
    assert.equal(
      modelSizeBytes(model),
      files.reduce((sum, f) => sum + f.sizeBytes, 0),
      model.id + " 聚合体积应等于各文件之和",
    );
    assert.ok(files.some((f) => f.fileName === primaryFileName(model)));
  }
});

test("multi-file models declare their component roles", () => {
  assert.equal(modelFiles(modelById("wan2.2-ti2v-5b")).length, 3);
  const h3Roles = modelFiles(modelById("minimax-h3-fl2va")).map((f) => f.role).sort();
  assert.deepEqual(h3Roles, ["audio-vae", "model", "text-encoder", "vae"]);
  assert.equal(modelFiles(modelById("qwen3-4b")).length, 1);
});

test("huge models require explicit confirmation and high gate", () => {
  const kimi = modelById("kimi-k2-instruct");
  assert.equal(kimi.confirmHuge, true);
  assert.equal(kimi.minTier, "high");
  assert.ok(kimi.minRamGb >= 64);
  assert.ok(kimi.minDiskGb >= 1200);
  const h3 = modelById("minimax-h3-fl2va");
  assert.ok(String(h3.license || "").length > 0, "MiniMax H3 应携带社区许可提示");
});

test("tierAllows orders lite < balanced < high", () => {
  assert.equal(tierAllows("high", "lite"), true);
  assert.equal(tierAllows("balanced", "high"), false);
  assert.equal(tierAllows("lite", "balanced"), false);
  assert.equal(tierAllows("lite", "lite"), true);
});

test("recommendedModelId picks by tier and modality", () => {
  assert.equal(recommendedModelId("lite", "text"), "qwen3-1.7b");
  assert.equal(recommendedModelId("balanced", "text"), "qwen3-4b");
  assert.equal(recommendedModelId("high", "text"), "qwen3-8b");
  assert.equal(recommendedModelId("balanced", "image"), "flux-schnell");
  assert.equal(recommendedModelId("high", "image"), "qwen-image");
  assert.equal(recommendedModelId("balanced", "video"), "wan2.2-ti2v-5b");
  assert.equal(recommendedModelId("high", "video"), "minimax-h3-fl2va");
});

test("modelGate enforces tier / vram / ram / disk thresholds", () => {
  const strong = {
    tier: "high",
    vramBytes: 16 * GB,
    totalRamBytes: 64 * GB,
    freeDiskBytes: 2000 * GB,
  };
  assert.equal(modelGate(strong, modelById("qwen-image")).ok, true);
  assert.equal(modelGate(strong, modelById("minimax-h3-fl2va")).ok, true);

  const weakVram = { ...strong, vramBytes: 6 * GB };
  const fluxGate = modelGate(weakVram, modelById("flux-schnell"));
  assert.equal(fluxGate.ok, false);
  assert.match(fluxGate.reason, /显存/);

  const lowTier = { ...strong, tier: "lite" };
  const imageGate = modelGate(lowTier, modelById("qwen-image"));
  assert.equal(imageGate.ok, false);
  assert.match(imageGate.reason, /档位/);

  const lowRam = { ...strong, totalRamBytes: 16 * GB };
  const kimiGate = modelGate(lowRam, modelById("kimi-k2-instruct"));
  assert.equal(kimiGate.ok, false);
  assert.match(kimiGate.reason, /内存/);

  const lowDisk = { ...strong, freeDiskBytes: 500 * GB };
  const diskGate = modelGate(lowDisk, modelById("kimi-k2-instruct"));
  assert.equal(diskGate.ok, false);
  assert.match(diskGate.reason, /磁盘/);
});
