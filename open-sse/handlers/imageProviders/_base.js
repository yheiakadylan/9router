// Shared helpers for image provider adapters
import {
  IMAGE_OUTPUT_MAX_BYTES,
  IMAGE_OUTPUT_UPLOAD_HOSTS,
  IMAGE_OUTPUT_UPLOAD_TIMEOUT_MS,
} from "../../config/runtimeConfig.js";

export const POLL_INTERVAL_MS = 1500;
export const POLL_TIMEOUT_MS = 120000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Map OpenAI size to provider-specific aspect ratio
export function sizeToAspectRatio(size) {
  if (!size || typeof size !== "string") return "1:1";
  const map = {
    "1024x1024": "1:1",
    "1024x1792": "9:16",
    "1792x1024": "16:9",
    "1024x1536": "2:3",
    "1536x1024": "3:2",
  };
  return map[size] || "1:1";
}

// Fetch URL → base64 (for providers returning image URLs)
export async function urlToBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}

export function validateImageOutputUpload(outputUpload) {
  if (outputUpload == null) return null;
  if (!outputUpload || typeof outputUpload !== "object") {
    throw new Error("Invalid output_upload configuration");
  }

  const uploadUrl = new URL(String(outputUpload.url || ""));
  const publicUrl = new URL(String(outputUpload.public_url || ""));
  if (uploadUrl.protocol !== "https:" || publicUrl.protocol !== "https:") {
    throw new Error("output_upload URLs must use HTTPS");
  }
  if (!IMAGE_OUTPUT_UPLOAD_HOSTS.has(uploadUrl.hostname.toLowerCase())) {
    throw new Error(`output_upload host is not allowed: ${uploadUrl.hostname}`);
  }
  if (!IMAGE_OUTPUT_UPLOAD_HOSTS.has(publicUrl.hostname.toLowerCase())) {
    throw new Error(`output_upload public host is not allowed: ${publicUrl.hostname}`);
  }

  const contentType = String(outputUpload.content_type || "image/png").toLowerCase();
  if (!/^image\/(png|jpeg|webp|gif)$/.test(contentType)) {
    throw new Error(`Unsupported output_upload content type: ${contentType}`);
  }

  return {
    url: uploadUrl.toString(),
    publicUrl: publicUrl.toString(),
    contentType,
  };
}

export async function uploadBase64ImageOutput(base64, outputUpload) {
  const target = validateImageOutputUpload(outputUpload);
  if (!target) return null;

  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length || buffer.length > IMAGE_OUTPUT_MAX_BYTES) {
    throw new Error(`Generated image size is invalid: ${buffer.length} bytes`);
  }

  const response = await fetch(target.url, {
    method: "PUT",
    headers: { "Content-Type": target.contentType },
    body: buffer,
    redirect: "error",
    signal: AbortSignal.timeout(IMAGE_OUTPUT_UPLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Direct image upload failed: HTTP ${response.status}`);
  }
  return target.publicUrl;
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}
