import { NextResponse } from "next/server";
import { startImageStudioJob } from "@/lib/imageStudioJobs";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json();
    if (!body.conversationId || !body.assistantId || !body.textModel || !body.imageModel || !Array.isArray(body.messages)) {
      return NextResponse.json({ error: "conversationId, assistantId, textModel, imageModel and messages are required" }, { status: 400 });
    }
    const jobId = await startImageStudioJob(body);
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    console.error("[IMAGE_STUDIO] job start failed:", error);
    return NextResponse.json({ error: error.message || "Failed to start image job" }, { status: error.status || 500 });
  }
}
