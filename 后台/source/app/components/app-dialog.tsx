"use client";

import {
  AlertTriangle,
  CircleCheck,
  CircleHelp,
  Info,
  X,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type AppDialogTone = "info" | "success" | "warning" | "danger";

interface AppDialogOptions {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  tone?: AppDialogTone;
}

interface AppPromptOptions extends AppDialogOptions {
  defaultValue?: string;
  placeholder?: string;
  inputLabel?: string;
}

interface DialogRequest {
  id: number;
  kind: "alert" | "confirm" | "prompt";
  message: string;
  options: AppPromptOptions;
  resolve: (value: unknown) => void;
}

interface AppDialogApi {
  alert: (message: string, options?: AppDialogOptions) => Promise<void>;
  confirm: (message: string, options?: AppDialogOptions) => Promise<boolean>;
  prompt: (
    message: string,
    options?: AppPromptOptions,
  ) => Promise<string | null>;
}

const AppDialogContext = createContext<AppDialogApi | null>(null);

function defaultTitle(kind: DialogRequest["kind"], tone: AppDialogTone) {
  if (kind === "prompt") return "请输入信息";
  if (tone === "danger") return "请确认操作";
  if (tone === "warning") return "操作提醒";
  if (tone === "success") return "操作完成";
  return kind === "confirm" ? "请确认" : "提示";
}

function DialogIcon({ tone }: { tone: AppDialogTone }) {
  if (tone === "danger" || tone === "warning") {
    return <AlertTriangle size={21} />;
  }
  if (tone === "success") return <CircleCheck size={21} />;
  if (tone === "info") return <Info size={21} />;
  return <CircleHelp size={21} />;
}

export function AppDialogProvider({ children }: { children: ReactNode }) {
  const nextId = useRef(1);
  const [requests, setRequests] = useState<DialogRequest[]>([]);
  const active = requests[0] ?? null;
  const [inputState, setInputState] = useState({ requestId: 0, value: "" });
  const inputValue =
    active && inputState.requestId === active.id
      ? inputState.value
      : (active?.options.defaultValue ?? "");

  const enqueue = useCallback(
    <T,>(
      kind: DialogRequest["kind"],
      message: string,
      options: AppPromptOptions = {},
    ) =>
      new Promise<T>((resolve) => {
        setRequests((current) => [
          ...current,
          {
            id: nextId.current++,
            kind,
            message,
            options,
            resolve: (value: unknown) => resolve(value as T),
          },
        ]);
      }),
    [],
  );

  const api = useMemo<AppDialogApi>(
    () => ({
      alert: (message, options) =>
        enqueue<void>("alert", message, options),
      confirm: (message, options) =>
        enqueue<boolean>("confirm", message, options),
      prompt: (message, options) =>
        enqueue<string | null>("prompt", message, options),
    }),
    [enqueue],
  );

  const finish = useCallback(
    (value: unknown) => {
      if (!active) return;
      active.resolve(value);
      setRequests((current) => current.slice(1));
    },
    [active],
  );

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      finish(active.kind === "confirm" ? false : active.kind === "prompt" ? null : undefined);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, finish]);

  const tone = active?.options.tone ?? "info";
  const title = active
    ? active.options.title ?? defaultTitle(active.kind, tone)
    : "";

  return (
    <AppDialogContext.Provider value={api}>
      {children}
      {active && (
        <div className="app-dialog-backdrop">
          <form
            className={`app-dialog app-dialog-${tone}`}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="app-dialog-title"
            aria-describedby="app-dialog-message"
            onSubmit={(event) => {
              event.preventDefault();
              finish(
                active.kind === "prompt"
                  ? inputValue
                  : active.kind === "confirm"
                    ? true
                    : undefined,
              );
            }}
          >
            <div className="app-dialog-header">
              <span className="app-dialog-icon" aria-hidden="true">
                <DialogIcon tone={tone} />
              </span>
              <div>
                <small>XIAOLUO NOTICE</small>
                <h2 id="app-dialog-title">{title}</h2>
              </div>
              <button
                type="button"
                className="app-dialog-close"
                aria-label="关闭提示"
                onClick={() =>
                  finish(
                    active.kind === "confirm"
                      ? false
                      : active.kind === "prompt"
                        ? null
                        : undefined,
                  )
                }
              >
                <X size={18} />
              </button>
            </div>

            <p id="app-dialog-message" className="app-dialog-message">
              {active.message}
            </p>

            {active.kind === "prompt" && (
              <label className="app-dialog-input">
                <span>{active.options.inputLabel ?? "输入内容"}</span>
                <input
                  autoFocus
                  value={inputValue}
                  placeholder={active.options.placeholder}
                  onChange={(event) =>
                    setInputState({
                      requestId: active.id,
                      value: event.target.value,
                    })
                  }
                />
              </label>
            )}

            <div className="app-dialog-actions">
              {active.kind !== "alert" && (
                <button
                  type="button"
                  className="app-dialog-cancel"
                  onClick={() =>
                    finish(active.kind === "prompt" ? null : false)
                  }
                >
                  {active.options.cancelText ?? "取消"}
                </button>
              )}
              <button
                type="submit"
                autoFocus={active.kind !== "prompt"}
                className="app-dialog-confirm"
              >
                {active.options.confirmText ??
                  (active.kind === "prompt" ? "确认" : "知道了")}
              </button>
            </div>
          </form>
        </div>
      )}
    </AppDialogContext.Provider>
  );
}

export function useAppDialog() {
  const dialog = useContext(AppDialogContext);
  if (!dialog) {
    throw new Error("useAppDialog 必须在 AppDialogProvider 内使用");
  }
  return dialog;
}
