import { getImageStudioAsset } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { id } = await params;
  const asset = await getImageStudioAsset(id);
  if (!asset) return new Response("Image not found", { status: 404 });
  return new Response(asset.bytes, {
    headers: {
      "Content-Type": asset.mimeType,
      "Content-Length": String(asset.bytes.length),
      "Cache-Control": "private, max-age=300",
      "Content-Disposition": `inline; filename="${asset.fileName}"`,
    },
  });
}
