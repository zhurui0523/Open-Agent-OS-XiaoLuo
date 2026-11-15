/**
 * 插件 iframe 故障隔离（P1-4 剩余项）。
 *
 * 以前 iframe 只接了 onError：页面加载卡死（白屏但 onLoad 不触发）就一直挂着，
 * 插件内部报错也只能靠用户刷新。这里给出可测的判定口径，组件按它执行。
 */

/** 加载看门狗：超过这个时间还没 onLoad 就算失败（正常静态面板 1s 内必到） */
export const FRAME_LOAD_TIMEOUT_MS = 20_000;

/** 自动重启次数上限：重启一次能盖住"瞬时网络抖动"，再多就是插件自身坏了，交回用户 */
export const MAX_AUTO_RESTARTS = 1;

export type FrameProblemKind = "timeout" | "error" | "crash";

export function shouldAutoRestart(attempts: number): boolean {
  return attempts < MAX_AUTO_RESTARTS;
}

export function describeFrameProblem(kind: FrameProblemKind, detail?: string): string {
  const tail = detail ? `（${detail}）` : "";
  if (kind === "timeout") return `插件界面加载超时${tail}：可能是插件服务没起来或网络卡住。`;
  if (kind === "crash") return `插件界面崩溃或报错${tail}：已重启过一次，仍然失败就别再重启，先检查插件代码。`;
  return `插件界面加载失败${tail}。`;
}
