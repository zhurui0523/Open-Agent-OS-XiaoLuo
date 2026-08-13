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
export const RUNNINGHUB_SPARKVIDEO_MINI_MODEL = "sparkvideo-2.0-mini";
export const RUNNINGHUB_SPARKVIDEO_MINI_MULTIMODAL_ENDPOINT =
  "https://www.runninghub.cn/openapi/v2/rhart-video/sparkvideo-2.0-mini/multimodal-video";
export const RUNNINGHUB_SPARKVIDEO_MODEL = "sparkvideo-2.0";
export const RUNNINGHUB_SPARKVIDEO_MULTIMODAL_ENDPOINT =
  "https://www.runninghub.cn/openapi/v2/rhart-video/sparkvideo-2.0/multimodal-video";
export const RUNNINGHUB_MINIMAX_H3_ENDPOINT =
  "https://www.runninghub.cn/openapi/v2/minimax/hailuo-h3/multimodal-to-video";
export const RUNNINGHUB_MINIMAX_H3_MODEL = "MiniMax-H3";
export const RUNNINGHUB_SEEDANCE_ENDPOINT =
  "https://www.runninghub.cn/openapi/v2/bytedance/seedance-2.5-token/multimodal-video";
export const RUNNINGHUB_SEEDANCE_MODEL = "seedance-2.5";
export const RUNNINGHUB_SUNO_V5_ENDPOINT =
  "https://www.runninghub.ai/openapi/v2/rhart-audio/suno-v5.5/custom";
export const RUNNINGHUB_SUNO_V5_MODEL = "suno-v5.5";
export const RUNNINGHUB_RH_IMAGE_2_ENDPOINT =
  "https://www.runninghub.ai/openapi/v2/rhart-image-g-2-official/image-to-image";
export const RUNNINGHUB_RH_IMAGE_2_MODEL = "rhart-image-g-2-official";
export const RUNNINGHUB_RH_IMAGE_2_QUERY_ENDPOINT =
  "https://www.runninghub.ai/openapi/v2/query";
export const RUNNINGHUB_QUERY_ENDPOINT =
  "https://www.runninghub.cn/openapi/v2/query";
export const RUNNINGHUB_NANO_BANANA_2_ENDPOINT =
  "https://www.runninghub.ai/openapi/v2/rhart-image-n-g31-flash/image-to-image";
export const RUNNINGHUB_NANO_BANANA_2_MODEL = "rhart-image-n-g31-flash";

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
    value: "runninghub-rh-image-2",
    label: "RH-image-2",
    modelTypes: ["image"],
  },
  {
    value: "runninghub-nano-banana-2",
    label: "RH-banana-2",
    modelTypes: ["image"],
  },
  {
    value: "runninghub-sparkvideo-mini-multimodal",
    label: "RunningHub · SparkVideo 2.0 Mini 多模态",
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
    value: "runninghub-seedance",
    label: "RunningHub · Seedance-2.5",
    modelTypes: ["video"],
  },
  {
    value: "runninghub-suno-v5",
    label: "RunningHub · Suno v5.5",
    modelTypes: ["audio"],
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
  format?: string;
  description?: string;
  enum?: string[];
  default: string;
  maxLength?: number;
};

function parameterSchema(properties: Record<string, ParameterProperty>) {
  return { type: "object", properties };
}

function runningHubVideoParameterSchema(resolutions: string[]) {
  return parameterSchema({
    resolution: {
      type: "string",
      title: "画质",
      enum: resolutions,
      default: "720p",
    },
    duration: {
      type: "string",
      title: "时长（秒）",
      enum: ["-1", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"],
      default: "5",
    },
    ratio: {
      type: "string",
      title: "比例",
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

function runningHubSeedanceParameterSchema() {
  const schema = runningHubVideoParameterSchema([
    "480p",
    "720p",
    "1080p",
    "2k",
    "4k",
  ]);
  schema.properties.duration = {
    type: "string",
    title: "时长（秒）",
    enum: ["-1", ...Array.from({ length: 27 }, (_, index) => String(index + 4))],
    default: "5",
  };
  schema.properties.bitrateMode = {
    type: "string",
    title: "画质档位",
    enum: ["standard", "high"],
    default: "standard",
  };
  schema.properties.conversionSlots = {
    type: "string",
    title: "真人素材转换范围",
    enum: [
      "all",
      ...Array.from({ length: 30 }, (_, index) => "image" + (index + 1)),
      ...Array.from({ length: 10 }, (_, index) => "video" + (index + 1)),
    ],
    default: "all",
  };
  return schema;
}

export interface SunoStyleTagOption {
  en: string;
  zh: string;
}

export interface SunoStyleTagGroup {
  name: string;
  options: SunoStyleTagOption[];
}

// Suno 风格标签预设：分组展示、可多选；选项保存中文标签（与既有“民谣”等用法一致），
// 悬浮提示对应英文风格名。除预设外用户还可以自行添加自定义标签
export const SUNO_STYLE_TAG_GROUPS: SunoStyleTagGroup[] = [
  {
    name: "流行与人声 Pop & Vocal",
    options: [
      { en: "Pop", zh: "流行" },
      { en: "Mandopop", zh: "华语流行" },
      { en: "Cantopop", zh: "粤语流行" },
      { en: "K-Pop", zh: "韩国流行" },
      { en: "Synth-pop", zh: "合成器流行" },
      { en: "Dream Pop", zh: "梦幻流行" },
      { en: "Indie Pop", zh: "独立流行" },
      { en: "Art Pop", zh: "艺术流行" },
      { en: "Teen Pop", zh: "青少年流行" },
      { en: "Vocal", zh: "人声" },
    ],
  },
  {
    name: "摇滚与金属 Rock & Metal",
    options: [
      { en: "Rock", zh: "摇滚" },
      { en: "Classic Rock", zh: "经典摇滚" },
      { en: "Alternative Rock", zh: "另类摇滚" },
      { en: "Indie Rock", zh: "独立摇滚" },
      { en: "Punk Rock", zh: "朋克摇滚" },
      { en: "Pop Punk", zh: "流行朋克" },
      { en: "Hard Rock", zh: "硬摇滚" },
      { en: "Heavy Metal", zh: "重金属" },
      { en: "Nu Metal", zh: "新金属" },
      { en: "Grunge", zh: "垃圾摇滚" },
      { en: "Psychedelic Rock", zh: "迷幻摇滚" },
      { en: "Post-Rock", zh: "后摇" },
    ],
  },
  {
    name: "电子与舞曲 Electronic & Dance",
    options: [
      { en: "EDM", zh: "电子舞曲" },
      { en: "House", zh: "浩室音乐" },
      { en: "Techno", zh: "泰克诺" },
      { en: "Trance", zh: "迷幻舞曲" },
      { en: "Dubstep", zh: "回响贝斯" },
      { en: "Drum and Bass", zh: "鼓与贝斯" },
      { en: "Lo-fi", zh: "低保真" },
      { en: "Lo-fi Hip Hop", zh: "低保真嘻哈" },
      { en: "Chillwave", zh: "冷潮" },
      { en: "Synthwave", zh: "合成器波" },
      { en: "Cyberpunk", zh: "赛博朋克" },
      { en: "Ambient", zh: "氛围音乐" },
    ],
  },
  {
    name: "爵士、蓝调与灵魂乐 Jazz, Blues & Soul",
    options: [
      { en: "Jazz", zh: "爵士" },
      { en: "Smooth Jazz", zh: "平滑爵士" },
      { en: "Bebop", zh: "比波普" },
      { en: "Swing", zh: "摇摆乐" },
      { en: "Blues", zh: "蓝调" },
      { en: "R&B", zh: "节奏布鲁斯" },
      { en: "Soul", zh: "灵魂乐" },
      { en: "Funk", zh: "放克" },
      { en: "Disco", zh: "迪斯科" },
      { en: "Bossa Nova", zh: "波萨诺瓦" },
    ],
  },
  {
    name: "古典、管弦与影视配乐 Classical & Cinematic",
    options: [
      { en: "Classical", zh: "古典" },
      { en: "Orchestral", zh: "管弦乐" },
      { en: "Symphony", zh: "交响乐" },
      { en: "Piano Solo", zh: "钢琴独奏" },
      { en: "Cinematic", zh: "电影感" },
      { en: "Epic", zh: "史诗感" },
      { en: "Soundtrack", zh: "原声带" },
      { en: "Opera", zh: "歌剧" },
    ],
  },
  {
    name: "民族与世界音乐 World & Folk",
    options: [
      { en: "Folk", zh: "民谣" },
      { en: "Chinese Folk", zh: "中国民谣" },
      { en: "Guofeng", zh: "国风" },
      { en: "Country", zh: "乡村音乐" },
      { en: "Bluegrass", zh: "蓝草音乐" },
      { en: "Latin", zh: "拉丁" },
      { en: "Reggae", zh: "雷鬼" },
      { en: "Afrobeat", zh: "非洲节拍" },
      { en: "Indian Classical", zh: "印度古典" },
    ],
  },
  {
    name: "说唱与嘻哈 Rap & Hip-Hop",
    options: [
      { en: "Hip Hop", zh: "嘻哈" },
      { en: "Rap", zh: "说唱" },
      { en: "Trap", zh: "陷阱音乐" },
      { en: "Drill", zh: "钻头音乐" },
      { en: "Old School Hip Hop", zh: "老派嘻哈" },
      { en: "Conscious Rap", zh: "意识说唱" },
    ],
  },
  {
    name: "常用修饰词 Modifiers",
    options: [
      { en: "Male Vocals", zh: "男声" },
      { en: "Female Vocals", zh: "女声" },
      { en: "Duet", zh: "二重唱" },
      { en: "Instrumental", zh: "纯音乐" },
      { en: "Acoustic", zh: "不插电/原声" },
      { en: "Electric", zh: "电声" },
      { en: "Upbeat", zh: "欢快" },
      { en: "Melancholic", zh: "忧郁" },
      { en: "Dark", zh: "黑暗" },
      { en: "Ethereal", zh: "空灵" },
      { en: "Fast Tempo", zh: "快节奏" },
      { en: "Slow Tempo", zh: "慢节奏" },
    ],
  },
];

export function builtInModelParameterSchema(
  protocol: ModelProtocol,
  modelType: NodeKind,
) {
  if (modelType === "video") {
    if (protocol === "runninghub-sparkvideo-mini-multimodal") {
      return runningHubMultimodalVideoParameterSchema([
        "480p",
        "720p",
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
          title: "画质",
          enum: ["2K"],
          default: "2K",
        },
        duration: {
          type: "string",
          title: "时长（秒）",
          enum: ["5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"],
          default: "5",
        },
        ratio: {
          type: "string",
          title: "比例",
          enum: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
          default: "adaptive",
        },
      });
    }
    if (protocol === "runninghub-seedance") {
      return runningHubSeedanceParameterSchema();
    }
  }
  if (modelType === "audio") {
    if (protocol === "runninghub-suno-v5") {
      return parameterSchema({
        title: {
          type: "string",
          title: "歌曲标题",
          default: "",
          maxLength: 80,
        },
        tags: {
          type: "string",
          title: "风格标签",
          format: "style-tags",
          description: "可点选预设风格，也可输入自定义标签，多个标签用英文逗号分隔",
          default: "",
          maxLength: 1000,
        },

      });
    }
  }
  if (modelType === "image") {
    if (protocol === "runninghub-rh-image-2") {
      return parameterSchema({
        aspectRatio: {
          type: "string",
          title: "比例",
          enum: [
            "1:1",
            "1:2",
            "2:1",
            "1:3",
            "3:1",
            "2:3",
            "3:2",
            "3:4",
            "4:3",
            "4:5",
            "5:4",
            "9:16",
            "21:9",
            "9:21",
            "16:9",
          ],
          default: "16:9",
        },
        resolution: {
          type: "string",
          title: "画质",
          enum: ["1k", "2k", "4k"],
          default: "2k",
        },
        quality: {
          type: "string",
          title: "质量",
          enum: ["low", "medium", "high"],
          default: "medium",
        },
      });
    }
    if (protocol === "runninghub-nano-banana-2") {
      return parameterSchema({
        aspectRatio: {
          type: "string",
          title: "比例",
          enum: [
            "1:1",
            "16:9",
            "9:16",
            "4:3",
            "3:4",
            "3:2",
            "2:3",
            "5:4",
            "4:5",
            "21:9",
            "1:4",
            "4:1",
            "1:8",
            "8:1",
          ],
          default: "16:9",
        },
        resolution: {
          type: "string",
          title: "画质",
          enum: ["1k", "2k", "4k"],
          default: "1k",
        },
      });
    }
    if (protocol === "gemini") {
      return parameterSchema({
        aspectRatio: {
          type: "string",
          title: "比例",
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
          title: "画质",
          enum: ["1K", "2K", "4K"],
          default: "4K",
        },
      });
    }
    return parameterSchema({
      size: {
        type: "string",
        title: "尺寸",
        enum: ["1024x1024", "1792x1024", "1024x1792"],
        default: "1024x1024",
      },
      quality: {
        type: "string",
        title: "质量",
        enum: ["standard", "hd"],
        default: "standard",
      },
      style: {
        type: "string",
        title: "风格",
        enum: ["vivid", "natural"],
        default: "vivid",
      },
    });
  }

  return parameterSchema({});
}
