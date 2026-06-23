export const API_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ||
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ||
  "https://mississippi-wallpapers-pick-depending.trycloudflare.com";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("insurehub_token");
}

export function setToken(token: string) {
  window.localStorage.setItem("insurehub_token", token);
}

export function clearToken() {
  window.localStorage.removeItem("insurehub_token");
}

export async function apiFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Request failed (${res.status})`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

/**
 * Stream a POST to /ask-stream.
 * Calls onToken for each text chunk, then onDone with the final sources array.
 */
export async function apiStream(
  question: string,
  onToken: (token: string) => void,
  onDone: (sources: string[]) => void,
  onError: (msg: string) => void,
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`${API_URL}/ask-stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ question }),
    });
  } catch {
    onError("Cannot reach the server. Is the backend running?");
    return;
  }

  if (!res.ok || !res.body) {
    onError(`Server error (${res.status})`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // The backend appends a final JSON line: {"sources":[...],"done":true}
    // Split on that so we can extract it without showing it as text.
    const jsonStart = buffer.lastIndexOf('\n\n{"sources"');
    if (jsonStart !== -1) {
      const textPart = buffer.slice(0, jsonStart);
      const jsonPart = buffer.slice(jsonStart + 2); // skip the \n\n
      if (textPart) onToken(textPart);
      try {
        const meta = JSON.parse(jsonPart);
        onDone(meta.sources ?? []);
      } catch {
        onDone([]);
      }
      return;
    }

    // Normal token chunk — pass straight to UI
    onToken(buffer);
    buffer = "";
  }

  // Stream ended without a done sentinel
  if (buffer) onToken(buffer);
  onDone([]);
}
