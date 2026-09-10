let imageGenEnabled = false;
let shortcutAttached = false;
const subscribers = new Set();

export function isImageGenEnabled() {
  return imageGenEnabled;
}

export function toggleImageGenAccess() {
  imageGenEnabled = !imageGenEnabled;
  subscribers.forEach((listener) => listener(imageGenEnabled));
  return imageGenEnabled;
}

export function subscribeImageGenAccess(listener) {
  if (typeof window === "undefined") return () => {};
  if (!shortcutAttached) {
    function handleShortcut(event) {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        toggleImageGenAccess();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    shortcutAttached = true;
  }
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}
