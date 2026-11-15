/**
 * clipboard —— 复制文本三级通道（与 openExternalUrl 同款降级思路）。
 * NotAllowedError（Write permission denied）时自动走下一级：
 *   ① 桌面桥 IPC（Electron 主进程 clipboard，无权限约束，需重启桌面壳生效）
 *   ② navigator.clipboard.writeText（需安全上下文 + 剪贴板权限）
 *   ③ document.execCommand('copy') 兜底（临时 textarea + 选中复制）
 */

type ClipboardBridge = {
  writeClipboard?: (payload: { text: string }) => Promise<{ ok?: boolean }>;
};

export async function copyTextToClipboard(text: string): Promise<boolean> {
  // ① 桌面桥 IPC：主进程写系统剪贴板，不受渲染进程权限策略约束
  try {
    const bridge =
      typeof window !== "undefined"
        ? (window as unknown as { xiaoluoDesktop?: ClipboardBridge }).xiaoluoDesktop
        : undefined;
    if (bridge?.writeClipboard) {
      const result = await bridge.writeClipboard({ text });
      if (result?.ok) return true;
    }
  } catch {
    // 桥不可用，继续降级
  }
  // ② Async Clipboard API：非安全上下文/权限被拒会抛 NotAllowedError
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒，继续降级
  }
  // ③ execCommand 兜底：不依赖剪贴板权限，只要求用户手势（点击即满足）
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}
