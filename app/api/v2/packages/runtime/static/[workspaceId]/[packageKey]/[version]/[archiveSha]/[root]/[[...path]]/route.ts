import {
  type PluginRuntimeStaticParams,
  servePluginRuntimeStatic,
} from "@/app/lib/plugin-runtime-static";

export async function GET(
  request: Request,
  context: {
    params:
      | Promise<PluginRuntimeStaticParams>
      | PluginRuntimeStaticParams;
  },
) {
  return servePluginRuntimeStatic(request, await context.params);
}
