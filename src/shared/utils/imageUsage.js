export function isImageUsageItem(item, key = "") {
  if (item?.endpoint === "/v1/images/generations") return true;
  const text = `${key} ${item?.rawModel || item?.model || ""}`;
  return /image|sdwebui|comfyui|flux|imagen/i.test(text);
}

export function getAverageImageDurationMs(requests = []) {
  const durations = requests
    .filter((request) => isImageUsageItem(request))
    .map((request) => request.durationMs || request.latency?.total || 0)
    .filter((duration) => duration > 0);

  if (durations.length === 0) return null;
  return durations.reduce((total, duration) => total + duration, 0) / durations.length;
}
