/**
 * 出站网络代理（第 7.3 项，学 Codex `network-proxy` 的最小版）
 *
 * 背景：小逻原来只有"网络策略"——`[sandbox] network = loopback` 时把所有 HTTP(S)_PROXY
 * 指向 `127.0.0.1:9` 黑洞，等于一刀切：白名单 `network_allow` 里的域名也连不上。
 *
 * 这里补一个本机 HTTP 代理，把白名单变成"真能用"：
 *   - 域名白名单 / 黑名单（黑名单优先，`*` 通配、`*.corp.com` 后缀通配）；
 *   - CONNECT 隧道（HTTPS）按目标域名放行/拒绝；
 *   - 明文 HTTP 转发时按目标主机注入凭据头（token 从环境变量读，绝不落盘、不进审计）；
 *   - 每次裁决写审计（host / 端口 / 方法 / 放行还是拒绝 / 命中的规则），token 永远不出现。
 *
 * 明确边界（写在这里，别对外说成"企业级出网网关"）：
 *   1. 没有 MITM：HTTPS 走 CONNECT 隧道，代理看不到明文，也就不能给 HTTPS 注入凭据头；
 *   2. 没有证书体系、没有 HTTP/2 专用处理、没有按进程归属统计；
 *   3. 只约束"遵守 HTTP(S)_PROXY 约定"的工具；raw socket / --noproxy 仍绕过（与既有黑洞策略同一层）；
 *   4. 默认关闭，只有 hooks.toml `[sandbox] egress = "proxy"` 才启用，避免改变既有行为。
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import net from "node:net";

export interface EgressCredential {
  /** 目标主机（支持 `*.corp.com`），命中才注入 */
  host: string;
  /** 注入的请求头名，默认 authorization */
  header: string;
  /** 从哪个环境变量读 token（值本身永不打印） */
  env: string;
  /** 可选前缀，如 "Bearer"；给了就拼成 `<prefix> <token>` */
  prefix?: string;
}

export interface EgressConfig {
  /** 只有 hooks.toml 写了 egress = "proxy" 才 true */
  enabled: boolean;
  allow: string[];
  deny: string[];
  credentials: EgressCredential[];
}

export interface EgressAuditEntry {
  at: number;
  host: string;
  port: number;
  method: string;
  decision: "allow" | "deny";
  reason: string;
}

const MAX_AUDIT = 200;

/** 极简 [[egress]] 块解析：坏行跳过，未知键忽略——写坏了不能把出网静默全放开 */
export function parseEgressConfig(tomlRaw: string): EgressConfig {
  const toml = String(tomlRaw ?? "").replace(/\r\n/g, "\n");
  const config: EgressConfig = { enabled: false, allow: [], deny: [], credentials: [] };

  const sandbox = /(?:^|\n)\[sandbox\]\n([\s\S]*?)(?=\n\[|$)/.exec(toml);
  if (sandbox) {
    const raw = /^\s*egress\s*=\s*["']?([A-Za-z_]+)["']?/m.exec(sandbox[1]);
    config.enabled = (raw?.[1] ?? "").toLowerCase() === "proxy";
  }

  for (const block of toml.split(/\n(?=\[\[egress\]\])/)) {
    if (!/^\[\[egress\]\]/.test(block.trim())) continue;
    const host = /^\s*host\s*=\s*"(.*)"\s*$/m.exec(block)?.[1]?.trim();
    const header = /^\s*header\s*=\s*"(.*)"\s*$/m.exec(block)?.[1]?.trim() || "authorization";
    const env = /^\s*env\s*=\s*"(.*)"\s*$/m.exec(block)?.[1]?.trim();
    const prefix = /^\s*prefix\s*=\s*"(.*)"\s*$/m.exec(block)?.[1]?.trim();
    if (!host || !env) continue; // 缺 host/env 的块没有意义，直接丢
    config.credentials.push({ host, header, env, ...(prefix ? { prefix } : {}) });
  }
  return config;
}

function normalizeHost(host: string): string {
  return String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
}

/** 域名匹配：`*` 全放行，`*.corp.com` 匹配子域与自身，其余精确匹配 */
export function hostMatches(host: string, pattern: string): boolean {
  const h = normalizeHost(host);
  const p = normalizeHost(pattern);
  if (!h || !p) return false;
  if (p === "*") return true;
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".corp.com"
    return h === p.slice(2) || h.endsWith(suffix);
  }
  return h === p;
}

/** 裁决：黑名单优先；没有白名单等于全拒（与既有"全部要批准"口径一致） */
export function hostAllowed(host: string, config: Pick<EgressConfig, "allow" | "deny">): { ok: boolean; reason: string } {
  const denied = (config.deny ?? []).find((p) => hostMatches(host, p));
  if (denied) return { ok: false, reason: "命中黑名单：" + denied };
  if (!(config.allow ?? []).length) return { ok: false, reason: "没有配置 network_allow 白名单" };
  const allowed = (config.allow ?? []).find((p) => hostMatches(host, p));
  return allowed ? { ok: true, reason: "命中白名单：" + allowed } : { ok: false, reason: "不在白名单" };
}

function findCredential(host: string, credentials: EgressCredential[]): EgressCredential | null {
  // 具体规则优先于通配（`api.corp.com` 先于 `*.corp.com`）
  const exact = credentials.find((c) => normalizeHost(c.host) === normalizeHost(host));
  if (exact) return exact;
  return credentials.find((c) => normalizeHost(c.host).startsWith("*.") && hostMatches(host, c.host)) ?? null;
}

function parseAuthority(authority: string): { host: string; port: number } {
  const raw = String(authority ?? "");
  const at = raw.lastIndexOf(":");
  if (at > 0) {
    const port = Number(raw.slice(at + 1));
    if (Number.isInteger(port) && port > 0) return { host: raw.slice(0, at), port };
  }
  return { host: raw, port: 80 };
}

export interface EgressProxy {
  url: string;
  port: number;
  audit: EgressAuditEntry[];
  close: () => Promise<void>;
}

/**
 * 起一个代理：只监听 127.0.0.1（不暴露到局域网）。
 * onAudit 可选，宿主可以拿去写日志；默认只留在内存里（有上限，防长跑进程吃内存）。
 */
export async function startEgressProxy(options: {
  allow: string[];
  deny?: string[];
  credentials?: EgressCredential[];
  onAudit?: (entry: EgressAuditEntry) => void;
  maxAudit?: number;
}): Promise<EgressProxy> {
  const audit: EgressAuditEntry[] = [];
  const limit = Math.max(1, options.maxAudit ?? MAX_AUDIT);
  const record = (entry: EgressAuditEntry) => {
    audit.push(entry);
    if (audit.length > limit) audit.splice(0, audit.length - limit);
    options.onAudit?.(entry);
  };
  const config = { allow: options.allow ?? [], deny: options.deny ?? [] };
  const credentials = options.credentials ?? [];

  const server: Server = createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? "", "http://placeholder.invalid");
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("代理请求的 URL 解析不了");
      return;
    }
    const host = target.hostname;
    const verdict = hostAllowed(host, config);
    if (!verdict.ok) {
      record({ at: Date.now(), host, port: Number(target.port || 80), method: req.method ?? "GET", decision: "deny", reason: verdict.reason });
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("出站被拒：" + verdict.reason);
      return;
    }
    record({ at: Date.now(), host, port: Number(target.port || 80), method: req.method ?? "GET", decision: "allow", reason: verdict.reason });

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (k === "proxy-connection" || k === "proxy-authorization" || k === "host") continue;
      headers[k] = v;
    }
    const cred = findCredential(host, credentials);
    if (cred) {
      const token = process.env[cred.env];
      if (token) {
        const key = cred.header.toLowerCase();
        headers[key] = cred.prefix ? cred.prefix + " " + token : token;
      }
    }
    const upstream = httpRequest(
      {
        hostname: host,
        port: Number(target.port || 80),
        path: target.pathname + target.search,
        method: req.method,
        headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end("上游连接失败：" + err.message);
    });
    req.pipe(upstream);
  });

  server.on("connect", (req, clientSocket, head) => {
    const { host, port } = parseAuthority(req.url ?? "");
    const verdict = hostAllowed(host, config);
    if (!verdict.ok) {
      record({ at: Date.now(), host, port, method: "CONNECT", decision: "deny", reason: verdict.reason });
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    record({ at: Date.now(), host, port, method: "CONNECT", decision: "allow", reason: verdict.reason });
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
    // 两端任一断开就收掉另一端，别让半开连接吊着
    clientSocket.on("close", () => upstream.destroy());
    upstream.on("close", () => clientSocket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = "http://127.0.0.1:" + port;

  return {
    url,
    port,
    audit,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** 代理 env：与既有黑洞策略同名字段，宿主只要把这段 env 交给子进程即可 */
export function egressEnv(url: string): Record<string, string> {
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    all_proxy: url,
    NO_PROXY: "localhost,127.0.0.1,::1,[::1]",
    no_proxy: "localhost,127.0.0.1,::1,[::1]",
  };
}

type EgressRegistry = Map<string, { proxy: EgressProxy }>;
function egressRegistry(): EgressRegistry {
  const g = globalThis as unknown as { __xiaoluoEgressProxies?: EgressRegistry };
  if (!g.__xiaoluoEgressProxies) g.__xiaoluoEgressProxies = new Map();
  return g.__xiaoluoEgressProxies;
}

/**
 * 按工作区起/复用一个代理并返回可直接合并进子进程的 env。
 * 未启用（egress != proxy）返回空对象——保持既有行为不变。
 */
export async function ensureEgressEnv(
  key: string,
  config: EgressConfig,
  onAudit?: (entry: EgressAuditEntry) => void,
): Promise<Record<string, string>> {
  if (!config.enabled) return {};
  const registry = egressRegistry();
  const cached = registry.get(key);
  if (cached) return egressEnv(cached.proxy.url);
  const proxy = await startEgressProxy({ allow: config.allow, deny: config.deny, credentials: config.credentials, onAudit });
  registry.set(key, { proxy });
  return egressEnv(proxy.url);
}

/** 测试用：关掉所有缓存代理并清空注册表 */
export async function resetEgressProxiesForTests(): Promise<void> {
  const registry = egressRegistry();
  for (const entry of registry.values()) await entry.proxy.close();
  registry.clear();
}

/** 测试用：取当前缓存的代理（不新建） */
export function peekEgressProxy(key: string): EgressProxy | undefined {
  return egressRegistry().get(key)?.proxy;
}
