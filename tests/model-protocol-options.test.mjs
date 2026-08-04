import assert from "node:assert/strict";
import test from "node:test";

import {
  builtInModelParameterSchema,
  defaultProtocolForModelType,
  modelProtocolOptionsForType,
  protocolSupportsModelType,
} from "../app/lib/model-protocol-options.ts";

function valuesFor(modelType) {
  return modelProtocolOptionsForType(modelType).map((option) => option.value);
}

test("text models only show text-compatible protocols", () => {
  assert.deepEqual(valuesFor("text"), [
    "openai-compatible",
    "anthropic-compatible",
    "gemini",
  ]);
  assert.equal(valuesFor("text").includes("openai-responses"), false);
  assert.equal(valuesFor("text").includes("ark"), false);
  assert.equal(valuesFor("text").includes("async-video"), false);
});

test("image models hide text-only and video-only protocols", () => {
  assert.deepEqual(valuesFor("image"), ["gemini", "dall-e-3"]);
});

test("video models show the supported RunningHub providers", () => {
  assert.deepEqual(valuesFor("video"), [
    "runninghub-sparkvideo-mini",
    "runninghub-sparkvideo-mini-multimodal",
    "runninghub-sparkvideo",
    "runninghub-sparkvideo-multimodal",
    "runninghub-minimax-h3",
  ]);
});

test("an incompatible protocol falls back to the type default", () => {
  assert.equal(protocolSupportsModelType("gemini", "video"), false);
  assert.equal(protocolSupportsModelType("ark", "text"), false);
  assert.equal(defaultProtocolForModelType("video"), "runninghub-sparkvideo-mini");
  assert.equal(defaultProtocolForModelType("image"), "dall-e-3");
  assert.equal(protocolSupportsModelType("dall-e-3", "image"), true);
  assert.equal(protocolSupportsModelType("dall-e-3", "text"), false);
  assert.equal(protocolSupportsModelType("gemini", "image"), true);
});

test("text models do not expose model parameter options", () => {
  assert.deepEqual(
    builtInModelParameterSchema("openai-compatible", "text").properties,
    {},
  );
});

test("image providers expose their own fixed parameter choices", () => {
  const dalle = builtInModelParameterSchema("dall-e-3", "image");

  assert.deepEqual(dalle.properties.size.enum, [
    "1024x1024",
    "1792x1024",
    "1024x1792",
  ]);
  assert.deepEqual(dalle.properties.quality.enum, ["standard", "hd"]);
  assert.deepEqual(dalle.properties.style.enum, ["vivid", "natural"]);
  assert.equal(dalle.properties.response_format, undefined);

  const gemini = builtInModelParameterSchema("gemini", "image");
  assert.deepEqual(gemini.properties.imageSize.enum, ["1K", "2K", "4K"]);
  assert.equal(gemini.properties.imageSize.default, "4K");
  assert.equal(gemini.properties.aspectRatio.default, "16:9");
});

test("video models do not expose placeholder parameter choices", () => {
  const schema = builtInModelParameterSchema("openai-compatible", "video");
  assert.deepEqual(schema.properties, {});
});

test("RunningHub video providers expose their own fixed parameter choices", () => {
  const mini = builtInModelParameterSchema(
    "runninghub-sparkvideo-mini",
    "video",
  );
  const standard = builtInModelParameterSchema(
    "runninghub-sparkvideo",
    "video",
  );
  const miniMultimodal = builtInModelParameterSchema(
    "runninghub-sparkvideo-mini-multimodal",
    "video",
  );
  const standardMultimodal = builtInModelParameterSchema(
    "runninghub-sparkvideo-multimodal",
    "video",
  );
  const minimax = builtInModelParameterSchema(
    "runninghub-minimax-h3",
    "video",
  );

  assert.deepEqual(mini.properties.resolution.enum, [
    "480p",
    "720p",
    "1080p",
    "2k",
    "4k",
  ]);
  assert.equal(mini.properties.duration.default, "5");
  assert.equal(mini.properties.ratio.default, "adaptive");
  assert.equal(standard.properties.resolution.enum.includes("native1080p"), true);
  assert.equal(standard.properties.resolution.enum.includes("native4k"), true);
  assert.deepEqual(miniMultimodal.properties.conversionSlots.enum, [
    "all",
    "image1",
    "image2",
    "image3",
    "image4",
    "image5",
    "image6",
    "image7",
    "image8",
    "image9",
    "video1",
    "video2",
    "video3",
  ]);
  assert.equal(
    standardMultimodal.properties.resolution.enum.includes("native1080p"),
    true,
  );
  assert.deepEqual(minimax.properties.resolution.enum, ["2K"]);
  assert.deepEqual(minimax.properties.duration.enum, [
    "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15",
  ]);
  assert.deepEqual(minimax.properties.ratio.enum, [
    "adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16",
  ]);
});
