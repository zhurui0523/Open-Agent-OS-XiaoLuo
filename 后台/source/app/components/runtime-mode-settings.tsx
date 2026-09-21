"use client";

/**
 * SERVER-URL 设置 → 运行模式：自定义服务连接地址（云端直连）。
 * 地址保存在客户端 userData/server-url.json，应用并重启后生效；清空即恢复内置默认地址。
 */
import { useCallback, useEffect, useState } from "react";
import { Globe, MonitorSmartphone, PlugZap } from "lucide-react";

type RuntimeModeResult = {
  ok: boolean;
  data?: { mode?: string; cloudUrl?: string; url?: string };
  message?: string;
};
type RuntimeModeAction = (payload: {
  action: string;
  [key: string]: unknown;
}) => Promise<RuntimeModeResult>;

function runtimeModeBridge(): RuntimeModeAction | null {
  if (typeof window === "undefined") return null;
  const bridge = (
    window as unknown as { xiaoluoDesktop?: { serverUrl?: RuntimeModeAction } }
  ).xiaoluoDesktop;
  return bridge?.serverUrl || null;
}

type DesktopGateResult = { ok?: boolean; enabled?: boolean; error?: string };
type DesktopGateAction = (payload: { action: string; enabled?: boolean }) => Promise<DesktopGateResult>;

function desktopGateBridge(): DesktopGateAction | null {
  if (typeof window === 'undefined') return null;
  const bridge = (
    window as unknown as { xiaoluoDesktop?: { desktopAction?: DesktopGateAction } }
  ).xiaoluoDesktop;
  return bridge?.desktopAction || null;
}

/** DESKTOP-GATE 整桌控制开关：允许小逻截整桌屏幕并用全局键鼠（默认关闭；开关持久保存在客户端） */
function DesktopControlCard() {
  const gate = desktopGateBridge();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!gate) return;
    let alive = true;
    gate({ action: 'gate' })
      .then((res) => { if (alive) setEnabled(Boolean(res.enabled)); })
      .catch(() => { /* 静默降级 */ });
    return () => { alive = false; };
  }, [gate]);

  if (!gate) return null;

  async function toggle() {
    if (!gate) return;
    setBusy(true);
    setError('');
    try {
      const next = !enabled;
      if (next && !window.confirm('开启后小逻可以截取整个屏幕并操作全局鼠标键盘（每次会话仍会再次向你确认）。确定开启吗？')) return;
      const res = await gate({ action: 'setGate', enabled: next });
      if (res.error) throw new Error(res.error);
      setEnabled(Boolean(res.enabled));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '设置失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className='local-ai-card'>
      <div className='local-ai-step-head'>
        <MonitorSmartphone size={16} />
        <span>整桌控制</span>
      </div>
      <p className='local-ai-hint'>
        {enabled
          ? '已开启：小逻可整桌截屏并用全局键鼠验收本机软件界面（每次会话首次使用时仍会弹窗确认）。'
          : '未开启（默认）：小逻只能截内嵌浏览器画面。开启后小逻才能看到并操作整个桌面。'}
      </p>
      {error && <p className='local-ai-hint' style={{ color: '#dc2626' }}>{error}</p>}
      <span className='local-ai-custom-row'>
        <button type='button' className={enabled ? 'local-ai-btn' : 'local-ai-btn is-primary'} disabled={busy} onClick={() => void toggle()}>
          {enabled ? '关闭整桌控制' : '开启「允许小逻控制本机」'}
        </button>
      </span>
    </div>
  );
}


export function RuntimeModeSettings() {
  const bridge = runtimeModeBridge();
  const [cloudUrl, setCloudUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    if (!bridge) return;
    const result = await bridge({ action: "status" });
    if (result.ok && result.data) {
      setCloudUrl((current) => current || result.data?.cloudUrl || "");
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!bridge) {
    return (
      <div className="local-ai-page">
        <div className="settings-section-heading">
          <div>
            <h3>运行模式</h3>
            <p>自定义客户端连接的服务地址。</p>
          </div>
        </div>
        <div className="local-ai-card">
          <p className="local-ai-hint">需要桌面客户端才能切换运行模式。</p>
        </div>
        <DesktopControlCard />
      </div>
    );
  }

  async function testConnection() {
    if (!bridge) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await bridge({ action: "test", url: cloudUrl });
      if (result.ok) setNotice("测试通过：" + (result.message || "连接正常"));
      else setError("测试失败：" + (result.message || "无法连接"));
    } finally {
      setBusy(false);
    }
  }

  async function applyCloud() {
    if (!bridge) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await bridge({ action: "set", mode: "cloud", cloudUrl });
      if (!result.ok) throw new Error(result.message || "保存失败");
      setNotice("已保存，客户端即将重启并连接新地址…");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  
  return (
    <div className="local-ai-page">
      <div className="settings-section-heading">
        <div>
          <h3>运行模式</h3>
          <p>
            自定义桌面客户端连接的服务地址，应用后自动重启生效。
          </p>
        </div>
      </div>
      {error && <div className="settings-alert is-error"><span>{error}</span></div>}
      {notice && <div className="settings-alert is-success"><span>{notice}</span></div>}

      <div className="local-ai-card">
        <div className="local-ai-step-head">
          <MonitorSmartphone size={16} />
          <span>当前连接</span>
        </div>
        <p className="local-ai-hint">{cloudUrl ? '自定义地址：' + cloudUrl : '未设置自定义地址，使用内置默认地址'}</p>
              </div>

      <div className="local-ai-card">
        <div className="local-ai-step-head">
          <Globe size={16} />
          <span>连接地址</span>
        </div>
        <span className="local-ai-custom-row">
          <input
            className="local-ai-input"
            value={cloudUrl}
            onChange={(event) => setCloudUrl(event.target.value)}
            placeholder="例如 https://www.luosheji.cn 或 http://127.0.0.1:3002"
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="local-ai-btn"
            disabled={busy || !cloudUrl.trim()}
            onClick={() => void testConnection()}
          >
            <PlugZap size={13} /> 测试连接
          </button>
          <button
            type="button"
            className="local-ai-btn is-primary"
            disabled={busy || !cloudUrl.trim()}
            onClick={() => void applyCloud()}
          >
            应用并重启
          </button>
        </span>
        <p className="local-ai-hint">
          说明：服务地址由管理员提供，更换域名或端口后在这里改一次即可。
          局域网或本机调试可用 http 地址，正式环境请使用 https。应用前会先做健康检查，地址不可用时不会保存。
        </p>
      </div>

      <DesktopControlCard />
    </div>
  );
}
