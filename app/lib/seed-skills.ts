/**
 * 官方种子技能：解决技能生态的数量问题——机制已齐（技能三件套 + 技能市场），
 * 但新用户工作区与市场都是空的。产品自带一套官方技能，双路播种：
 * 1) seedUserSkills：工作区创建时落盘 skills/（同名不覆盖，用户可自由删改）；
 * 2) seedOfficialMarket：市场目录缺官方条目时补种，能力中心技能市场开箱有货。
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface SeedSkill {
  name: string;
  skillMd: string;
}

export const OFFICIAL_PUBLISHER_ID = "xiaoluo-official";
const OFFICIAL_PUBLISHER_NAME = "小逻官方";

export const SEED_SKILLS: SeedSkill[] = [
  {
    name: "make-ppt",
    skillMd: ["---","name: make-ppt","description: 把主题做成单文件 HTML 16:9 幻灯片，键盘翻页","whenToUse: 老板要 PPT / 幻灯片 / 演示稿时用这个","---","","1. 先和老板确认主题、受众、页数、风格；已给的信息不重复问。","2. 用 write_code 生成单文件 HTML：每页 16:9 全屏，一页一节，大字号、少字、多要点。","3. 支持左右方向键翻页与页码指示。","4. preview_code 自检后交付，告诉老板可按页增删调整。"
    ].join("\n"),
  },
  {
    name: "data-analysis-report",
    skillMd: ["---","name: data-analysis-report","description: 清洗聚合数据后产出带图表的 HTML 分析报告","whenToUse: 老板给数据（文件/粘贴）要分析报告、复盘、图表时用","---","","1. 确认数据来源（上传文件 / 粘贴表格）与要回答的问题。","2. 数据落盘工作区，write_code 写 Node 清洗聚合脚本。","3. run_command 跑脚本，输出关键指标数字。","4. write_code 生成 HTML 报告页：结论先行，SVG/CSS 图表，明细表殿后。","5. preview_code 自检后交付报告；数字必须来自脚本结果，不许编造。"
    ].join("\n"),
  },
  {
    name: "game-prototype",
    skillMd: ["---","name: game-prototype","description: 单文件 HTML5 可玩小游戏原型（canvas 主循环）","whenToUse: 老板要做游戏 / 小游戏 / 互动 demo 时用","---","","1. 确认玩法核心：操作方式、得分规则、失败条件；优先单屏小游戏。","2. write_code 单文件 HTML5：canvas 渲染 + requestAnimationFrame 主循环 + 键盘/鼠标控制 + 计分与重开。","3. preview_code 自检可玩性：控制响应、碰撞判定、失败后能重开。","4. 按老板反馈迭代，一次只改需要改的部分。"
    ].join("\n"),
  },
  {
    name: "ai-drama",
    skillMd: ["---","name: ai-drama","description: AI 剧流水线：剧本分镜 → 画布产图配乐 → HTML 播放页","whenToUse: 老板要做短剧 / AI 剧 / 有声故事 / 分镜视频时用","---","","1. 写迷你剧本：主题、3~6 幕，每幕含台词、画面描述、情绪基调。","2. 产出分镜表：幕次 / 台词 / 画面描述 / 配乐建议，先给老板过目。","3. 引导老板在画布按分镜生成场景图与配乐（图片、音乐生成卡已就位）。","4. write_code 生成 HTML 播放页：按幕展示场景图 + 台词字幕 + 自动/手动翻页。","5. preview_code 自检后交付整剧。"
    ].join("\n"),
  },
  {
    name: "weekly-report",
    skillMd: ["---","name: weekly-report","description: 盘点工作区产出，四段式生成周报","whenToUse: 老板要周报 / 工作总结 / 进展汇报时用","---","","1. 用 list_dir / read_file 盘点工作区本周产出文件与记录。","2. 四段式成稿：本周进展 / 问题与风险 / 下周计划 / 需要的支持。","3. 每条进展附事实依据（文件名、时间），没数据就直说，不编。","4. 老板要文档版时结合 make-docx 技能输出 Word。"
    ].join("\n"),
  },
  {
    name: "static-site-deploy",
    skillMd: ["---","name: static-site-deploy","description: 静态站闭环：写页面 → 预览 → 起服务 → 部署","whenToUse: 老板要上线静态网页 / 部署站点时用","---","","1. write_code 产出站点文件（index.html + 资源）到独立目录。","2. preview_code 自检页面渲染与交互。","3. start_service 起本地服务验证可访问。","4. deploy_program 部署，拿到地址后把访问链接与说明交付老板。"
    ].join("\n"),
  },
  {
    name: "make-docx",
    skillMd: ["---","name: make-docx","description: 用 docx 库生成 Word 文档（标题/段落/表格）","whenToUse: 老板要 Word / docx 文档时用","---","","1. 确认文档结构：标题、章节、是否需要表格。","2. run_command 在工作区执行 npm i docx（已装则跳过）。","3. write_code 写生成脚本：用 docx 库组装标题、段落、表格。","4. run_command 跑脚本产出 .docx，告知老板文件位置。"
    ].join("\n"),
  },
  {
    name: "todo-app",
    skillMd: ["---","name: todo-app","description: 单文件 HTML 待办清单应用模板（localStorage 持久化）","whenToUse: 老板要待办 / 任务清单 / 小工具页面时用","---","","1. write_code 单文件 HTML 待办：添加 / 完成 / 删除，localStorage 持久化。","2. preview_code 自检：添加、勾选、刷新不丢数据。","3. 按老板需求加功能：筛选、截止日期、拖拽排序。"
    ].join("\n"),
  },
];

/** 用户侧播种：落盘工作区 skills/（同名不覆盖，用户自己的技能优先） */
export async function seedUserSkills(userWorkspaceRoot: string): Promise<void> {
  for (const seed of SEED_SKILLS) {
    const dir = path.join(userWorkspaceRoot, "skills", seed.name);
    try {
      await fs.access(path.join(dir, "SKILL.md"));
      continue;
    } catch { /* 不存在才播种 */ }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), seed.skillMd, "utf8");
  }
}

/** 市场侧播种：官方发布者目录缺条目时补种（publisherId 独立，用户无法下架） */
export async function seedOfficialMarket(marketRoot: string): Promise<void> {
  const ownerDir = path.join(marketRoot, OFFICIAL_PUBLISHER_ID);
  for (const seed of SEED_SKILLS) {
    const dir = path.join(ownerDir, seed.name);
    try {
      await fs.access(path.join(dir, "SKILL.md"));
      continue;
    } catch { /* 缺条目才播种 */ }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), seed.skillMd, "utf8");
    await fs.writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify({
        publisherId: OFFICIAL_PUBLISHER_ID,
        publisherName: OFFICIAL_PUBLISHER_NAME,
        publishedAt: new Date().toISOString(),
      }),
      "utf8",
    );
  }
}
