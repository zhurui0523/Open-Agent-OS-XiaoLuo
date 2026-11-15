/**
 * feature flag 运行时判定（P2-6 收尾）。
 *
 * 机制早就有了，但一直没挂到任何真实功能上——"能开能关"却没人读，等于没有。
 * 这里把 flag 接到真正会拦请求的地方：插件能力桥可以被一键关掉（出问题即时止损）。
 */
import { DEFAULT_ON_FLAGS, flagEnabled } from "../../shared/agent-config.mjs";
import { resolveRuntimeConfig } from "./agent-config";

/** 请求即解析（配置层已合并文件层 + env 层），flags 里显式值优先，其次看 defaultOn */
export async function isFeatureOn(name: string, workspaceRoot: string): Promise<boolean> {
  const view = await resolveRuntimeConfig(workspaceRoot);
  return flagEnabled({ flags: view.flags }, name, DEFAULT_ON_FLAGS);
}
