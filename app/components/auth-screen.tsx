"use client";

import { ArrowRight, Check, Sparkles } from "lucide-react";

export function AuthScreen({ onEnter }: { onEnter: () => void }) {
  return (
    <main className="auth-screen">
      <section className="auth-story">
        <div className="brand-lockup light">
          <span><Sparkles size={20} /></span>
          <div><b>XiaoLuo AI</b><small>Intent OS · V2</small></div>
        </div>
        <div className="auth-story-copy">
          <span className="auth-kicker">QUIET CREATIVE CANVAS</span>
          <h1>把一个想法，变成一条清晰可控的创作工作流。</h1>
          <p>表达目标、检查计划、调整节点，然后让每次执行沉淀为可以继续复用的资产。</p>
          <ul>
            <li><Check size={15} /> AI 计划先确认，再执行</li>
            <li><Check size={15} /> 节点状态透明、可暂停和重试</li>
            <li><Check size={15} /> 结果自动关联来源与版本</li>
          </ul>
        </div>
        <div className="auth-orbit" aria-hidden="true"><i /><i /><i /><span /></div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <span className="eyebrow">WELCOME BACK</span>
          <h2>登录 XiaoLuo AI</h2>
          <p>本版本为核心重写预览，使用演示工作区即可体验完整前端流程。</p>
          <label><span>邮箱</span><input type="email" defaultValue="creator@xiaoluo.ai" aria-label="邮箱" /></label>
          <label><span>密码</span><input type="password" defaultValue="xiaoluo-demo" aria-label="密码" /></label>
          <div className="auth-options">
            <label className="check-label"><input type="checkbox" defaultChecked /> 保持登录</label>
            <button type="button" className="text-button">忘记密码？</button>
          </div>
          <button type="button" className="primary-button auth-submit" onClick={onEnter}>
            进入演示工作区 <ArrowRight size={16} />
          </button>
          <small className="auth-notice">不会提交真实账号信息，认证服务将在后端接入阶段替换。</small>
        </div>
      </section>
    </main>
  );
}

