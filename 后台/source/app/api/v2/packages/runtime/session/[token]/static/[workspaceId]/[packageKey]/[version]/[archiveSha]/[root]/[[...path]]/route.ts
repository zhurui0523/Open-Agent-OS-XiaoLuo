import { servePluginRuntimeStatic } from "@/app/lib/plugin-runtime-static";

interface RuntimeParams {
  token: string;
  workspaceId: string;
  packageKey: string;
  version: string;
  archiveSha: string;
  root: string;
  path?: string[];
}

export async function GET(
  request: Request,
  context: { params: Promise<RuntimeParams> | RuntimeParams },
) {
  const params = await context.params;
  const headers = new Headers(request.headers);
  headers.set("x-xiaoluo-runtime-token", params.token);
  const forwarded = new Request(request.url, {
    method: "GET",
    headers,
  });

  return servePluginRuntimeStatic(forwarded, {
    workspaceId: params.workspaceId,
    packageKey: params.packageKey,
    version: params.version,
    archiveSha: params.archiveSha,
    root: params.root,
    path: params.path,
  });
}
