"use client";

import { KeyRound, PackageCheck, Plus, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface TrustSnapshot {
  publishers: Array<{
    id: string;
    slug: string;
    displayName: string;
    status: string;
  }>;
  keys: Array<{
    id: string;
    publisherId: string;
    fingerprintSha256: string;
    status: string;
  }>;
  reviews: Array<{
    id: string;
    packageKey: string;
    version: string;
    signatureVerified: boolean;
    status: string;
    reason: string | null;
    scan: { risk?: string; score?: number; issues?: Array<{ message?: string }> };
  }>;
}
async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) throw new Error(payload.error ?? "操作失败");
  return payload;
}

export function PackageTrustAdmin() {
  const [snapshot, setSnapshot] = useState<TrustSnapshot | null>(null);
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [publisherId, setPublisherId] = useState("");
  const [publicKeyPem, setPublicKeyPem] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const payload = await requestJson<TrustSnapshot>(
      "/api/v2/admin/package-trust",
    );
    setSnapshot(payload);
    setPublisherId((current) => current || payload.publishers[0]?.id || "");
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((error) =>
        setMessage(error instanceof Error ? error.message : "读取失败"),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function mutate(
    action: string,
    body: Record<string, unknown>,
    success: string,
  ) {
    setBusy(action);
    try {
      await requestJson("/api/v2/admin/package-trust", {
        method: "POST",
        body: JSON.stringify({ action, ...body }),
      });
      setMessage(success);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="package-trust-admin">
      <div className="settings-section-heading">
        <div>
          <h3><PackageCheck size={18} /> Package 信任中心</h3>
          <p>发布者身份、公钥签名、安全扫描、隔离与撤销统一管理。</p>
        </div>
      </div>
      {message && <div className="settings-alert">{message}</div>}
      <div className="package-trust-forms">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(
              "publisher.create",
              { slug, displayName },
              "发布者已提交审核",
            ).then(() => {
              setSlug("");
              setDisplayName("");
            });
          }}
        >
          <b><Plus size={14} /> 登记发布者</b>
          <input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="com.example.publisher"
            required
          />
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="发布者名称"
            required
          />
          <button className="secondary-button" disabled={Boolean(busy)}>
            创建
          </button>
        </form>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(
              "key.add",
              { publisherId, publicKeyPem },
              "发布者公钥已登记",
            ).then(() => setPublicKeyPem(""));
          }}
        >
          <b><KeyRound size={14} /> 登记签名公钥</b>
          <select
            value={publisherId}
            onChange={(event) => setPublisherId(event.target.value)}
            required
          >
            <option value="">选择发布者</option>
            {snapshot?.publishers.map((publisher) => (
              <option key={publisher.id} value={publisher.id}>
                {publisher.displayName}
              </option>
            ))}
          </select>
          <textarea
            value={publicKeyPem}
            onChange={(event) => setPublicKeyPem(event.target.value)}
            placeholder="-----BEGIN PUBLIC KEY-----"
            required
          />
          <button className="secondary-button" disabled={Boolean(busy)}>
            保存公钥
          </button>
        </form>
      </div>
      <div className="package-trust-columns">
        <section>
          <h4>发布者</h4>
          {snapshot?.publishers.map((publisher) => (
            <article key={publisher.id}>
              <div>
                <b>{publisher.displayName}</b>
                <code>{publisher.slug}</code>
              </div>
              <em data-state={publisher.status}>{publisher.status}</em>
              <footer>
                {publisher.status !== "approved" && (
                  <button
                    type="button"
                    onClick={() =>
                      void mutate(
                        "publisher.review",
                        { publisherId: publisher.id, status: "approved" },
                        "发布者已批准",
                      )
                    }
                  >
                    批准
                  </button>
                )}
                {publisher.status === "approved" && (
                  <button
                    type="button"
                    onClick={() =>
                      void mutate(
                        "publisher.review",
                        { publisherId: publisher.id, status: "suspended" },
                        "发布者已暂停",
                      )
                    }
                  >
                    暂停
                  </button>
                )}
                <button
                  type="button"
                  className="danger"
                  onClick={() =>
                    void mutate(
                      "publisher.review",
                      { publisherId: publisher.id, status: "revoked" },
                      "发布者及关联 Package 已撤销",
                    )
                  }
                >
                  撤销
                </button>
              </footer>
            </article>
          ))}
          {!snapshot?.publishers.length && <p>暂无发布者。</p>}
        </section>
        <section>
          <h4><ShieldAlert size={15} /> Package 审核队列</h4>
          {snapshot?.reviews.map((review) => (
            <article key={review.id}>
              <div>
                <b>{review.packageKey}</b>
                <code>v{review.version}</code>
              </div>
              <em data-state={review.status}>
                {review.status} · {review.scan.risk ?? "unknown"}
              </em>
              <p>
                {review.signatureVerified ? "可信签名已验证" : "未验证可信签名"}
                {review.scan.issues?.[0]?.message
                  ? ` · ${review.scan.issues[0].message}`
                  : ""}
              </p>
              <footer>
                <button
                  type="button"
                  onClick={() =>
                    void mutate(
                      "review.update",
                      { reviewId: review.id, status: "approved" },
                      "Package 已批准",
                    )
                  }
                >
                  批准
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void mutate(
                      "review.update",
                      { reviewId: review.id, status: "quarantined" },
                      "Package 已隔离",
                    )
                  }
                >
                  隔离
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() =>
                    void mutate(
                      "review.update",
                      { reviewId: review.id, status: "revoked" },
                      "Package 已撤销",
                    )
                  }
                >
                  撤销
                </button>
              </footer>
            </article>
          ))}
          {!snapshot?.reviews.length && <p>暂无 Package 审核记录。</p>}
        </section>
      </div>
    </section>
  );
}
