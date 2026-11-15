import type { Metadata } from "next";
import { AppShell } from "./components/app-shell";

export const metadata: Metadata = {
  title: "小逻Agent OS",
  description: "小逻Agent OS——以意图驱动的 AI 工作台",
};

export default function Home() {
  return <AppShell />;
}
