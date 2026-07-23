import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "XiaoLuo AI Intent OS V2";
const description = "安静、透明、可控的 AI 创作工作流画布。";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const rawHost =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3001";
  const host = rawHost.split(",")[0].trim();
  const safeHost = /^[a-z0-9.-]+(?::\d+)?$/i.test(host)
    ? host
    : "localhost:3001";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0];
  const protocol = forwardedProtocol ?? (safeHost.startsWith("localhost") ? "http" : "https");
  const imageUrl = `${protocol}://${safeHost}/og.png`;

  return {
    title,
    description,
    icons: {
      icon: [
        {
          url: "/xiaoluo-intent-mark.png",
          type: "image/png",
          sizes: "1254x1254",
        },
      ],
      shortcut: ["/xiaoluo-intent-mark.png"],
      apple: [{ url: "/xiaoluo-intent-mark.png" }],
    },
    openGraph: {
      title,
      description,
      type: "website",
      images: [{ url: imageUrl, width: 1731, height: 909, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
