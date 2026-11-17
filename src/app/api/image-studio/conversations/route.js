import { NextResponse } from "next/server";
import {
  createImageStudioConversation,
  listImageStudioConversations,
} from "@/lib/db";
import { getActiveImageStudioJobConversationIds, getActiveImageStudioJobs } from "@/lib/imageStudioJobs";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const conversations = await listImageStudioConversations({
      recoverInterrupted: true,
      activeConversationIds: getActiveImageStudioJobConversationIds(),
    });
    return NextResponse.json({ conversations, jobs: getActiveImageStudioJobs() });
  } catch (error) {
    console.error("[IMAGE_STUDIO] list failed:", error);
    return NextResponse.json({ error: "Failed to load image conversations" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const conversation = await createImageStudioConversation({
      title: body.title,
      textModel: body.textModel || null,
      imageModel: body.imageModel || null,
    });
    return NextResponse.json({ conversation }, { status: 201 });
  } catch (error) {
    console.error("[IMAGE_STUDIO] create failed:", error);
    return NextResponse.json({ error: "Failed to create image conversation" }, { status: 500 });
  }
}
