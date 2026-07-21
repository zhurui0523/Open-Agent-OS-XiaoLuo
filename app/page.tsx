import type { Metadata } from "next";
import { AppShell } from "./components/app-shell";

export const metadata: Metadata = {
  title: "XiaoLuo AI Intent OS V2",
  description: "从自然语言意图到可编辑画布工作流的 AI 内容创作系统。",
};

export default function Home() {
  return <AppShell />;
}
