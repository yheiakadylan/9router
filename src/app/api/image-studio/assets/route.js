import { NextResponse } from "next/server";
import { saveImageStudioAsset } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const form = await request.formData();
    const conversationId = String(form.get("conversationId") || "");
    const file = form.get("file");
    if (!conversationId) return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
    if (!(file instanceof File) || !file.type.startsWith("image/")) {
      return NextResponse.json({ error: "An image file is required" }, { status: 400 });
    }
    const asset = await saveImageStudioAsset({
      conversationId,
      mimeType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    return NextResponse.json({ asset }, { status: 201 });
  } catch (error) {
    const status = /20 MB|Unsupported image type|Conversation not found/.test(error?.message || "") ? 400 : 500;
    console.error("[IMAGE_STUDIO] asset upload failed:", error);
    return NextResponse.json({ error: error.message || "Failed to save image" }, { status });
  }
}
