/**
 * GET /api/v2/packages/artifact-static/[...path]
 * 服务从代码产物生成的插件静态文件
 * 路径格式：/{packageId}/{version}/{...filePath}
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const ARTIFACT_PACKAGES_DIR = path.join(process.cwd(), '.local-data', 'artifact-packages');

const contentTypes: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  try {
    const resolvedParams = await params;
    const pathSegments = resolvedParams.path ?? [];
    if (pathSegments.length < 2) {
      return Response.json(
        { error: '路径必须包含 packageId 和 version' },
        { status: 400 }
      );
    }

    const [packageId, version, ...filePath] = pathSegments;

    // 安全校验
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(packageId)) {
      return Response.json({ error: '无效的 packageId' }, { status: 400 });
    }
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      return Response.json({ error: '无效的 version' }, { status: 400 });
    }

    // 防止路径遍历
    if (filePath.some((s) => !s || s === '.' || s === '..' || s.includes('\\') || s.includes('\0'))) {
      return Response.json({ error: '无效的文件路径' }, { status: 400 });
    }

    const targetFile = filePath.length > 0 ? filePath.join('/') : 'index.html';
    const fullPath = path.resolve(ARTIFACT_PACKAGES_DIR, packageId, version, targetFile);
    const packageRoot = path.resolve(ARTIFACT_PACKAGES_DIR, packageId, version);

    // 确保路径在包目录内
    if (!fullPath.startsWith(packageRoot)) {
      return Response.json({ error: '路径遍历攻击被阻止' }, { status: 403 });
    }

    // 读取文件
    let fileContent: Buffer;
    try {
      fileContent = await fs.readFile(fullPath);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return Response.json({ error: '文件不存在' }, { status: 404 });
      }
      throw err;
    }

    // 确定 Content-Type
    const ext = path.extname(targetFile).slice(1).toLowerCase();
    const contentType = contentTypes[ext] ?? 'application/octet-stream';

    // HTML 文件需要重写相对路径
    let body = fileContent;
    if (ext === 'html' || ext === 'htm') {
      const text = fileContent.toString('utf-8');
      // 将绝对路径改为相对路径（适配 sandbox iframe）
      const rewritten = text.replace(/\b(src|href)=(["'])\/(?!\/)/gi, '$1=$2./');
      body = Buffer.from(rewritten, 'utf-8');
    } else if (ext === 'css') {
      const text = fileContent.toString('utf-8');
      const base = new URL(request.url).origin + '/api/v2/packages/artifact-static/' + packageId + '/' + version + '/';
      const rewritten = text.replace(/url\((["']?)\/(?!\/)/gi, 'url($1' + base);
      body = Buffer.from(rewritten, 'utf-8');
    }

    const headers = new Headers({
      'content-type': contentType,
      'access-control-allow-origin': '*',
      'content-security-policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; media-src 'self' data: blob: https:; connect-src 'self' data: blob: https:; frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
      'x-content-type-options': 'nosniff',
      'cache-control': ext === 'html' || ext === 'htm' ? 'private, no-store' : 'private, max-age=31536000, immutable',
    });

    return new Response(new Uint8Array(body), { status: 200, headers });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json(
      {
        error: error instanceof Error ? error.message : '读取插件静态资源失败',
      },
      { status: 500 }
    );
  }
}
