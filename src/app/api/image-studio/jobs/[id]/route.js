import { NextResponse } from "next/server";
import { cancelImageStudioJob } from "@/lib/imageStudioJobs";

export const runtime = "nodejs";

export async function DELETE(_request, { params }) {
  const { id } = await params;
  const cancelled = cancelImageStudioJob(id);
  return NextResponse.json({ cancelled }, { status: cancelled ? 200 : 404 });
}
