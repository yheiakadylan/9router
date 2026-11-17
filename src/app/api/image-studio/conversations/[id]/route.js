import { NextResponse } from "next/server";
import {
  deleteImageStudioConversation,
  getImageStudioConversation,
  updateImageStudioConversation,
} from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { id } = await params;
  const conversation = await getImageStudioConversation(id);
  if (!conversation) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  return NextResponse.json({ conversation });
}

export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const conversation = await updateImageStudioConversation(id, body);
    if (!conversation) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    return NextResponse.json({ conversation });
  } catch (error) {
    console.error("[IMAGE_STUDIO] update failed:", error);
    return NextResponse.json({ error: "Failed to save image conversation" }, { status: 500 });
  }
}

export async function DELETE(_request, { params }) {
  try {
    const { id } = await params;
    const deleted = await deleteImageStudioConversation(id);
    if (!deleted) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[IMAGE_STUDIO] delete failed:", error);
    return NextResponse.json({ error: "Failed to delete image conversation" }, { status: 500 });
  }
}
