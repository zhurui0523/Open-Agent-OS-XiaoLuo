import type { ModelProtocol, NodeKind } from "../types";

export interface ModelProtocolOption {
  value: ModelProtocol;
  label: string;
  modelTypes: NodeKind[];
}

export const DALL_E_3_ENDPOINT =
  "https://api.vectorengine.cn/v1/images/generations";
export const DALL_E_3_MODEL = "dall-e-3";
export const GEMINI_IMAGE_MODEL = "gemini-3-pro-image-preview";
export const GEMINI_IMAGE_ENDPOINT =
  `https://api.vectorengine.cn/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;
export const RUNNINGHUB_SPARKVIDEO_MINI_ENDPOINT =
  "https://www.runninghub.cn/openapi/v2/rhart-video/sparkvideo-2.0-mini/image-to-video";
export const RUNNINGHUB_SPARKVIDEO_MINI_MODEL = "sparkvideo-2.0-mini";
export const RUNNINGHUB_SPARKVIDEO_MINI_MULTIMODAL_ENDPOINT =
  "https://www.runninghub.cn/openapi/v2/rhart-video/sparkvideo-2.0-mini/multimodal-video";
export const RUNNINGHUB_SPARKVIDEO_ENDPOINT =
  "https://www.runninghub.cn/openapi/v2/rhart-video/sparkvideo-2.0/image-to-video";
export const RUNNINGHUB_SPARKVIDEO_MODEL = "sparkvideo-2.0";
export const RUNNINGHUB_SPARKVIDEO_MULTIMODAL_ENDPOINT =
  "https://www.runninghub.cn/openapi/v2/rhart-video/sparkvideo-2.0/multimodal-video";
export const RUNNINGHUB_MINIMAX_H3_ENDPOINT =
  "https://www.runninghub.cn/openapi/v2/minimax/hailuo-h3/multimodal-to-video";
export const RUNNINGHUB_MINIMAX_H3_MODEL = "MiniMax-H3";

export const modelProtocolOptions: ModelProtocolOption[] = [
  {
    value: "openai-compatible",
    label: "OpenAI 兼容",
    modelTypes: ["text"],
  },
  {
    value: "anthropic-compatible",
    label: "原生 Claude 格式",
    modelTypes: ["text"],
  },
  {
    value: "gemini",
    label: "原生 Gemini 格式",
    modelTypes: ["text", "image"],
  },
  {
    value: "dall-e-3",
    label: "dall-e-3",
    modelTypes: ["image"],
  },
  {
    value: "runninghub-sparkvideo-mini",
    label: "RunningHub · SparkVideo 2.0 Mini",
    modelTypes: ["video"],
  },
  {
    value: "runninghub-sparkvideo-mini-multimodal",
    label: "RunningHub · SparkVideo 2.0 Mini 多模态",
    modelTypes: ["video"],
  },
  {
    value: "runninghub-sparkvideo",
    label: "RunningHub · SparkVideo 2.0",
    modelTypes: ["video"],
  },
  {
    value: "runninghub-sparkvideo-multimodal",
    label: "RunningHub · SparkVideo 2.0 多模态",
    modelTypes: ["video"],
  },
  {
    value: "runninghub-minimax-h3",
    label: "RunningHub · MiniMax-H3",
    modelTypes: ["video"],
  },
  {
    value: "ark",
    label: "火山方舟",
    modelTypes: [],
  },
  {
    value: "async-video",
    label: "视频生成服务",
    modelTypes: [],
  },
];

export function modelProtocolOptionsForType(modelType: NodeKind) {
  return modelProtocolOptions.filter((option) =>
    option.modelTypes.includes(modelType),
  );
}

export function protocolSupportsModelType(
  protocol: ModelProtocol,
  modelType: NodeKind,
) {
  return modelProtocolOptions.some(
    (option) =>
      option.value === protocol && option.modelTypes.includes(modelType),
  );
}

export function defaultProtocolForModelType(modelType: NodeKind) {
  if (modelType === "image") return "dall-e-3";
  return (
    modelProtocolOptionsForType(modelType)[0]?.value ?? "openai-compatible"
  );
}

type ParameterProperty = {
  type: "string";
  title: string;
  enum: string[];
  default: string;
};

function parameterSchema(properties: Record<string, ParameterProperty>) {
  return { type: "object", properties };
}

function runningHubVideoParameterSchema(resolutions: string[]) {
  return parameterSchema({
    resolution: {
      type: "string",
      title: "默认分辨率",
      enum: resolutions,
      default: "720p",
    },
    duration: {
      type: "string",
      title: "默认时长（秒）",
      enum: ["-1", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"],
      default: "5",
    },
    ratio: {
      type: "string",
      title: "默认比例",
      enum: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
      default: "adaptive",
    },
    generateAudio: {
      type: "string",
      title: "生成音频",
      enum: ["true", "false"],
      default: "true",
    },
    realPersonMode: {
      type: "string",
      title: "真人模式",
      enum: ["true", "false"],
      default: "true",
    },
    conversionSlots: {
      type: "string",
      title: "真人素材转换范围",
      enum: ["all", "firstFrameUrl", "lastFrameUrl"],
      default: "all",
    },
    returnLastFrame: {
      type: "string",
      title: "返回尾帧",
      enum: ["false", "true"],
      default: "false",
    },
  });
}

function runningHubMultimodalVideoParameterSchema(resolutions: string[]) {
  const schema = runningHubVideoParameterSchema(resolutions);
  schema.properties.conversionSlots = {
    type: "string",
    title: "真人素材转换范围",
    enum: [
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
    ],
    default: "all",
  };
  return schema;
}

export function builtInModelParameterSchema(
  protocol: ModelProtocol,
  modelType: NodeKind,
) {
  if (modelType === "video") {
    if (protocol === "runninghub-sparkvideo-mini") {
      return runningHubVideoParameterSchema([
        "480p",
        "720p",
        "1080p",
        "2k",
        "4k",
      ]);
    }
    if (protocol === "runninghub-sparkvideo-mini-multimodal") {
      return runningHubMultimodalVideoParameterSchema([
        "480p",
        "720p",
        "1080p",
        "2k",
        "4k",
      ]);
    }
    if (protocol === "runninghub-sparkvideo") {
      return runningHubVideoParameterSchema([
        "480p",
        "720p",
        "native1080p",
        "native4k",
        "1080p",
        "2k",
        "4k",
      ]);
    }
    if (protocol === "runninghub-sparkvideo-multimodal") {
      return runningHubMultimodalVideoParameterSchema([
        "480p",
        "720p",
        "native1080p",
        "native4k",
        "1080p",
        "2k",
        "4k",
      ]);
    }
    if (protocol === "runninghub-minimax-h3") {
      return parameterSchema({
        resolution: {
          type: "string",
          title: "默认分辨率",
          enum: ["2K"],
          default: "2K",
        },
        duration: {
          type: "string",
          title: "默认时长（秒）",
          enum: ["5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"],
          default: "5",
        },
        ratio: {
          type: "string",
          title: "默认比例",
          enum: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
          default: "adaptive",
        },
      });
    }
  }
  if (modelType === "image") {
    if (protocol === "gemini") {
      return parameterSchema({
        aspectRatio: {
          type: "string",
          title: "默认比例",
          enum: [
            "1:1",
            "2:3",
            "3:2",
            "3:4",
            "4:3",
            "4:5",
            "5:4",
            "9:16",
            "16:9",
            "21:9",
          ],
          default: "16:9",
        },
        imageSize: {
          type: "string",
          title: "默认画质",
          enum: ["1K", "2K", "4K"],
          default: "4K",
        },
      });
    }
    return parameterSchema({
      size: {
        type: "string",
        title: "默认尺寸",
        enum: ["1024x1024", "1792x1024", "1024x1792"],
        default: "1024x1024",
      },
      quality: {
        type: "string",
        title: "默认质量",
        enum: ["standard", "hd"],
        default: "standard",
      },
      style: {
        type: "string",
        title: "默认风格",
        enum: ["vivid", "natural"],
        default: "vivid",
      },
    });
  }

  return parameterSchema({});
}
