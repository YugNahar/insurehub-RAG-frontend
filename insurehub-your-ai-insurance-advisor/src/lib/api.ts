export const API_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ||
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ||
  "";

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

export interface StreamMeta {
  sources: string[];
  needs_human: boolean;
}

/** Convert an http(s) API URL to the equivalent ws(s) URL for WebSocket connections. */
export function getWsUrl(): string {
  return API_URL.replace(/^https/, "wss").replace(/^http(?!s)/, "ws");
}

/**
 * Stream a POST to /ask-stream.
 * Calls onToken for each text chunk, then onDone with sources + needs_human flag.
 */
export async function apiStream(
  question: string,
  sessionId: string,
  onToken: (token: string) => void,
  onDone: (meta: StreamMeta) => void,
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
      body: JSON.stringify({ question, session_id: sessionId }),
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
    const jsonStart = buffer.lastIndexOf('\n\n{"sources"');
    if (jsonStart !== -1) {
      const textPart = buffer.slice(0, jsonStart);
      const jsonPart = buffer.slice(jsonStart + 2);
      if (textPart) onToken(textPart);
      try {
        const meta = JSON.parse(jsonPart);
        onDone({ sources: meta.sources ?? [], needs_human: meta.needs_human ?? false });
      } catch {
        onDone({ sources: [], needs_human: false });
      }
      return;
    }

    onToken(buffer);
    buffer = "";
  }

  if (buffer) onToken(buffer);
  onDone({ sources: [], needs_human: false });
}
