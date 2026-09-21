import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "小逻Agent OS";
const description = "小逻Agent OS——以意图驱动的 AI 工作台";

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
  // O2-LOOPBACK: 环回主机（localhost/127.x/[::1]）实际是 http 服务，og:image 不该写成 https
  const loopbackHost = safeHost.startsWith("localhost") || safeHost.startsWith("127.") || safeHost.startsWith("[::1]");
  const protocol = forwardedProtocol ?? (loopbackHost ? "http" : "https");
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
      <body>
        {children}
      </body>
    </html>
  );
}

/* css recompile touch */
