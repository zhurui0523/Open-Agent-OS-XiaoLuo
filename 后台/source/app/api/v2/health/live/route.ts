export async function GET() {
  return Response.json({
    ok: true,
    service: "xiaoluo-ai-intent-os-v2",
    time: new Date().toISOString(),
  });
}
