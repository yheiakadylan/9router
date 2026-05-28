export function parseBase64DataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid base64 data URL");
  }
  return {
    mimeType: match[1],
    base64Data: match[2],
    buffer: Buffer.from(match[2], "base64"),
  };
}

export function getExtensionFromMime(mimeType) {
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif"
  };
  return map[mimeType] || "png";
}
