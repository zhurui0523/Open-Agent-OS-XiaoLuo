import { and, eq, gt } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { kernelRuns, runEvents } from "../../../../../db/schema";
import { requireUser } from "../../../../lib/auth";

const encoder = new TextEncoder();

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const url = new URL(request.url);
    const runId = url.searchParams.get("runId")?.trim();
    const after = url.searchParams.get("after")?.trim();
    if (!runId) {
      return Response.json({ error: "runId 必填" }, { status: 400 });
    }
    const db = await getDb();
    const [owned] = await db
      .select({ id: kernelRuns.id })
      .from(kernelRuns)
      .where(
        and(eq(kernelRuns.id, runId), eq(kernelRuns.createdBy, user.id)),
      )
      .limit(1);
    if (!owned) {
      return Response.json({ error: "运行记录不存在" }, { status: 404 });
    }
    const rows = await db
      .select()
      .from(runEvents)
      .where(
        after
          ? and(eq(runEvents.runId, runId), gt(runEvents.createdAt, after))
          : eq(runEvents.runId, runId),
      )
      .orderBy(runEvents.createdAt);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        rows.forEach((row) => {
          controller.enqueue(
            encoder.encode(
              `id: ${row.id}\nevent: ${row.eventType}\ndata: ${row.payloadJson}\n\n`,
            ),
          );
        });
        controller.enqueue(
          encoder.encode(`event: heartbeat\ndata: {"runId":"${runId}"}\n\n`),
        );
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json(
      { error: error instanceof Error ? error.message : "读取运行事件失败" },
      { status: 500 },
    );
  }
}
