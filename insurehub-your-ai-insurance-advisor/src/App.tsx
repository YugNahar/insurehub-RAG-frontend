import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Link, useNavigate } from "react-router-dom";
import React, { useEffect, useState, useRef, useCallback, type ReactNode } from "react";
import {
  ShieldCheck,
  LogOut,
  FileText,
  Film,
  Globe,
  MessageCircle,
  Send,
  X,
  Upload,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiFetch, apiStream, clearToken, getToken, getWsUrl, setToken } from "@/lib/api";
import { cn } from "@/lib/utils";
// ─────────────────────────────────────────────
// QueryClient
// ─────────────────────────────────────────────

const queryClient = new QueryClient();

// ─────────────────────────────────────────────
// Main App Shell
// ─────────────────────────────────────────────

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function GlobalErrorBoundary({ children }: { children: ReactNode }) {
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    function handler(event: ErrorEvent) {
      setError(event.error ?? new Error(event.message));
    }
    window.addEventListener("error", handler);
    return () => window.removeEventListener("error", handler);
  }, []);

  if (error) {
    console.error(error);
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            This page didn't load
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Something went wrong on our end. You can try refreshing or head back home.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <button
              onClick={() => setError(null)}
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Try again
            </button>
            <Link
              to="/"
              className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              Go home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export function App() {
  return (
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <GlobalErrorBoundary>
          <Routes>
            <Route path="/" element={<IndexPage />} />
            <Route path="/auth" element={<AuthPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="*" element={<NotFoundComponent />} />
          </Routes>
        </GlobalErrorBoundary>
      </QueryClientProvider>
    </BrowserRouter>
  );
}

// ─────────────────────────────────────────────
// Index (Chat / Layla)
// ─────────────────────────────────────────────

type Message = {
  role: "user" | "assistant" | "agent" | "system";
  content: string;
  agentName?: string;
};

// Both keys in localStorage so session + history survive tab switches and browser restarts.
// This prevents a new sidebar entry appearing whenever the user opens a fresh tab.
const STORAGE_KEY    = "insurehub_chat_history";
const SESSION_ID_KEY = "insurehub_session_id";

const GREETING: Message = {
  role: "assistant",
  content: "Hi, I'm Layla 👋 Your personal insurance advisor. How can I help you today?",
};

function IndexPage() {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen bg-background">
      <ChatWidget open={open} onOpenChange={setOpen} />
    </div>
  );
}

type ChatMode = "ai" | "waiting" | "human";

function ChatWidget({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([GREETING]);
  const [hydrated, setHydrated] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState<string>("default");
  const [chatMode, setChatMode] = useState<ChatMode>("ai");
  const [agentName, setAgentName] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pollSeenRef = useRef<number>(0);       // last message index seen via polling
  const chatModeRef = useRef<ChatMode>("ai");  // ref so polling closure sees latest value

  // chatModeRef is updated synchronously whenever setChatMode is called — see setModeSync below.
  // This ensures polling closures always read the current value without a render cycle.

  function setModeSync(mode: ChatMode) {
    chatModeRef.current = mode;
    setChatMode(mode);
  }

  // Create or reuse hub session on mount, then open WebSocket.
  // Session ID is persisted in sessionStorage so page refreshes don't create a new chat entry.
  useEffect(() => {
    const storedId = window.localStorage.getItem(SESSION_ID_KEY);
    if (storedId) {
      // Sync pollSeenRef to backend total BEFORE starting the polling interval,
      // so we don't replay old messages that are already in localStorage.
      apiFetch(`/session/${storedId}/poll?after=0`)
        .then((d) => { if (d?.total != null) pollSeenRef.current = d.total; })
        .catch(() => {})
        .finally(() => {
          setSessionId(storedId);
          const ws = new WebSocket(`${getWsUrl()}/ws/user/${storedId}`);
          wsRef.current = ws;
          ws.onmessage = handleWsMessage;
          ws.onclose = () => { wsRef.current = null; };
        });
    } else {
      apiFetch("/session/create", { method: "POST" })
        .then((d: { session_id: string }) => {
          if (!d?.session_id) return;
          window.localStorage.setItem(SESSION_ID_KEY, d.session_id);
          setSessionId(d.session_id);
          const ws = new WebSocket(`${getWsUrl()}/ws/user/${d.session_id}`);
          wsRef.current = ws;
          ws.onmessage = handleWsMessage;
          ws.onclose = () => { wsRef.current = null; };
        })
        .catch(() => {});
    }
  }, []);

  // Polling — runs every second. Owns agent-message delivery and all chatMode transitions.
  useEffect(() => {
    if (sessionId === "default") return;
    const interval = setInterval(async () => {
      try {
        const data = await apiFetch(`/session/${sessionId}/poll?after=${pollSeenRef.current}`);
        if (!data) return;

        // Sync chatMode with server status. Update ref synchronously so the
        // next interval tick sees the correct value and doesn't double-fire.
        if (data.status === "human" && chatModeRef.current !== "human") {
          setModeSync("human");
          setAgentName(data.agent_name || "Agent");
          setMessages((m) => [
            ...m,
            { role: "system", content: `You're now connected with ${data.agent_name || "an agent"}. They can see your conversation and will help you directly.` },
          ]);
        }
        if (data.status === "waiting" && chatModeRef.current === "ai") {
          setModeSync("waiting");
        }
        if (data.status === "ai" && chatModeRef.current !== "ai") {
          setModeSync("ai");
          setAgentName(null);
        }

        // Deliver agent messages not yet shown
        const newMsgs: { role: string; content: string; timestamp: string }[] = data.messages || [];
        for (const m of newMsgs) {
          if (m.role === "agent") {
            setMessages((prev) => [
              ...prev,
              { role: "agent", content: m.content, agentName: data.agent_name || "Agent" },
            ]);
          }
        }
        if (data.total != null) pollSeenRef.current = data.total;
      } catch { /* ignore */ }
    }, 1000);
    return () => clearInterval(interval);
  }, [sessionId]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Message[];
        if (Array.isArray(parsed) && parsed.length) setMessages(parsed);
      }
    } catch { /* ignore */ }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch { /* ignore */ }
  }, [messages, hydrated]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      });
    }
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  // Clean up WebSocket on unmount
  useEffect(() => {
    return () => { wsRef.current?.close(); };
  }, []);

  function handleWsMessage(ev: MessageEvent) {
    const msg = JSON.parse(ev.data as string);
    // agent_message is intentionally NOT handled here — polling owns message delivery
    // to avoid duplicates (WebSocket + polling both firing the same message).
    if (msg.type === "agent_joined") {
      setAgentName(msg.agent_name);
      // Guard: polling may have already transitioned to "human" a moment earlier.
      // Only add the system message once.
      if (chatModeRef.current !== "human") {
        setModeSync("human");
        setMessages((m) => [
          ...m,
          {
            role: "system",
            content: `You're now connected with ${msg.agent_name}. They can see your conversation and will help you directly.`,
          },
        ]);
      }
    } else if (msg.type === "agent_left") {
      setAgentName(null);
      setModeSync("ai");
      setMessages((m) => [
        ...m,
        { role: "system", content: msg.message || "You're back with Layla." },
      ]);
    } else if (msg.type === "waiting") {
      setMessages((m) => [
        ...m,
        { role: "system", content: msg.message },
      ]);
    } else if (msg.type === "session_deleted") {
      // Agent cleared the conversation — wipe local state and start fresh
      window.localStorage.removeItem(SESSION_ID_KEY);
      window.localStorage.removeItem(STORAGE_KEY);
      setModeSync("ai");
      setAgentName(null);
      pollSeenRef.current = 0;
      setMessages([GREETING]);
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
      // Create a brand-new session
      apiFetch("/session/create", { method: "POST" })
        .then((d: { session_id: string }) => {
          if (!d?.session_id) return;
          window.localStorage.setItem(SESSION_ID_KEY, d.session_id);
          setSessionId(d.session_id);
          const ws = new WebSocket(`${getWsUrl()}/ws/user/${d.session_id}`);
          wsRef.current = ws;
          ws.onmessage = handleWsMessage;
          ws.onclose = () => { wsRef.current = null; };
        })
        .catch(() => {});
    }
  }

  function requestHandoff() {
    // Guard: only trigger handoff once per AI session — don't re-trigger if already
    // waiting for an agent or already in a live human session.
    if (chatModeRef.current !== "ai") return;
    setModeSync("waiting");
    setMessages((m) => [
      ...m,
      { role: "system", content: "I'm finding a human agent who can help you better. One moment…" },
    ]);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "request_handoff" }));
    } else {
      // WebSocket dropped — use HTTP fallback
      apiFetch(`/session/${sessionId}/request-handoff`, { method: "POST" }).catch(() => {});
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;

    setMessages((m) => [...m, { role: "user", content: text }]);
    setInput("");

    // In human mode, send via WebSocket directly
    if (chatMode === "human" && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "message", content: text }));
      return;
    }

    setSending(true);
    setMessages((m) => [...m, { role: "assistant", content: "" }]);

    try {
      await apiStream(
        text,
        sessionId,
        (token) => {
          setMessages((m) => {
            const updated = [...m];
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              content: updated[updated.length - 1].content + token,
            };
            return updated;
          });
        },
        (meta) => {
          if (meta.needs_human) requestHandoff();
        },
        (errMsg) => {
          setMessages((m) => {
            const updated = [...m];
            updated[updated.length - 1] = { ...updated[updated.length - 1], content: errMsg };
            return updated;
          });
        },
      );
    } catch (err) {
      setMessages((m) => {
        const updated = [...m];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          content: "I'm having trouble reaching the server right now. Please try again in a moment.",
        };
        return updated;
      });
    } finally {
      setSending(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const headerLabel =
    chatMode === "human" && agentName
      ? `${agentName} · Live support`
      : chatMode === "waiting"
      ? "Finding an agent…"
      : "InsureHub advisor · online";

  const headerDotClass =
    chatMode === "human"
      ? "bg-blue-400"
      : chatMode === "waiting"
      ? "bg-amber-400 animate-pulse"
      : "bg-emerald-400";

  const avatarLabel = chatMode === "human" && agentName ? agentName[0].toUpperCase() : "L";

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-label={open ? "Close chat" : "Open chat with Layla"}
        className={cn(
          "fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-2xl shadow-primary/30 ring-1 ring-primary/40 transition-all hover:scale-105 active:scale-95",
          open && "scale-90 opacity-0 pointer-events-none",
        )}
      >
        <MessageCircle className="h-6 w-6" />
        <span className="absolute -top-1 -right-1 flex h-3 w-3">
          <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/70" />
          <span className="relative h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-background" />
        </span>
      </button>

      <div
        className={cn(
          "fixed bottom-5 right-5 z-50 flex w-[calc(100vw-2.5rem)] max-w-sm origin-bottom-right flex-col overflow-hidden rounded-2xl border border-border/70 bg-card/95 shadow-2xl shadow-black/40 backdrop-blur transition-all duration-200",
          "h-[32rem] max-h-[calc(100vh-2.5rem)]",
          open ? "scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0",
        )}
        role="dialog"
        aria-label="Chat with Layla"
      >
        <div className="flex items-center gap-3 border-b border-border/60 bg-background/40 px-4 py-3">
          <div className="relative">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/20 text-sm font-semibold text-primary">
              {avatarLabel}
            </div>
            <span className={cn("absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-card", headerDotClass)} />
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="text-sm font-medium">
              {chatMode === "human" && agentName ? agentName : "Layla"}
            </div>
            <div className="text-xs text-muted-foreground">{headerLabel}</div>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            aria-label="Close chat"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.map((m, i) => (
            <MessageBubble key={i} message={m} />
          ))}
          {sending && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <TypingDots />
              <span>{chatMode === "human" ? `${agentName} is typing…` : "Layla is typing…"}</span>
            </div>
          )}
        </div>

        <div className="border-t border-border/60 bg-background/40 p-2.5">
          <div className="flex items-end gap-2 rounded-xl border border-border/70 bg-background/60 p-1.5 focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/40">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              rows={1}
              placeholder={chatMode === "waiting" ? "Connecting you to an agent…" : "Type a message…"}
              disabled={chatMode === "waiting"}
              className="max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
            />
            <Button
              onClick={send}
              disabled={!input.trim() || sending || chatMode === "waiting"}
              size="icon"
              className="h-8 w-8 shrink-0 rounded-lg"
              aria-label="Send message"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const { role, content, agentName } = message;

  if (role === "system") {
    return (
      <div className="flex justify-center">
        <div className="max-w-[90%] rounded-lg border border-border/40 bg-muted/30 px-3 py-1.5 text-center text-xs text-muted-foreground">
          {content}
        </div>
      </div>
    );
  }

  const isUser = role === "user";
  const isAgent = role === "agent";

  return (
    <div className={cn("flex w-full gap-2", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
            isAgent ? "bg-blue-500/20 text-blue-400" : "bg-primary/20 text-primary",
          )}
        >
          {isAgent ? (agentName?.[0]?.toUpperCase() ?? "A") : "L"}
        </div>
      )}
      <div className="flex flex-col gap-0.5">
        {isAgent && agentName && (
          <div className="text-[10px] font-medium text-blue-400 pl-1">{agentName}</div>
        )}
        <div
          className={cn(
            "max-w-[80%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
            isUser
              ? "bg-primary text-primary-foreground rounded-br-sm"
              : isAgent
              ? "bg-blue-500/15 text-foreground rounded-bl-sm border border-blue-500/20"
              : "bg-secondary text-secondary-foreground rounded-bl-sm",
          )}
        >
          {content}
        </div>
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex gap-1">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
    </span>
  );
}

// ─────────────────────────────────────────────
// Auth Page
// ─────────────────────────────────────────────

function AuthPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (getToken()) navigate("/admin", { replace: true });
  }, [navigate]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      const token = data?.token || data?.access_token || data?.jwt;
      if (!token) throw new Error("No token returned by server");
      setToken(token);
      navigate("/admin", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-background to-[oklch(0.13_0.05_265)] px-4">
      <div className="w-full max-w-sm">
        <Link to="/" className="mb-6 flex items-center justify-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <span className="text-base font-semibold tracking-tight">InsureHub</span>
        </Link>

        <div className="rounded-2xl border border-border/70 bg-card/70 p-6 shadow-2xl shadow-black/20 backdrop-blur">
          <h1 className="text-xl font-semibold tracking-tight">Admin sign in</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage Layla's knowledge sources.
          </p>

          <form onSubmit={onSubmit} className="mt-5 space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="username" className="text-sm font-medium">
                Username
              </label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="password" className="text-sm font-medium">
                Password
              </label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          <Link to="/" className="hover:text-foreground">
            ← Back to chat
          </Link>
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Admin Page
// ─────────────────────────────────────────────

type Item = {
  id: string | number;
  name?: string;
  title?: string;
  url?: string;
  filename?: string;
  chunks?: number;
};

function AdminPage() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      navigate("/auth", { replace: true });
    } else {
      setReady(true);
    }
  }, [navigate]);

  function signOut() {
    clearToken();
    navigate("/auth", { replace: true });
  }

  if (!ready) return null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-[oklch(0.13_0.05_265)]">
      <header className="border-b border-border/60 bg-background/60 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div className="leading-tight">
              <div className="text-base font-semibold tracking-tight">InsureHub</div>
              <div className="text-xs text-muted-foreground">Admin console</div>
            </div>
          </Link>
          <Button variant="ghost" size="sm" onClick={signOut} className="gap-2">
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Knowledge sources</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Layla learns from the documents, videos, and webpages you add here.
          </p>
        </div>

        <Tabs defaultValue="documents" className="w-full">
          <TabsList className="bg-card/60">
            <TabsTrigger value="documents" className="gap-2">
              <FileText className="h-4 w-4" /> Documents
            </TabsTrigger>
            <TabsTrigger value="videos" className="gap-2">
              <Film className="h-4 w-4" /> Videos
            </TabsTrigger>
            <TabsTrigger value="webpages" className="gap-2">
              <Globe className="h-4 w-4" /> Webpages
            </TabsTrigger>
          </TabsList>

          <TabsContent value="documents" className="mt-6">
            <DocumentsTab />
          </TabsContent>
          <TabsContent value="videos" className="mt-6">
            <UrlTab
              kind="videos"
              endpoint="/videos"
              icon={<Film className="h-4 w-4 text-primary" />}
              placeholder="https://www.youtube.com/watch?v=…"
              addLabel="Add video"
              emptyLabel="No videos added yet."
            />
          </TabsContent>
          <TabsContent value="webpages" className="mt-6">
            <UrlTab
              kind="webpages"
              endpoint="/webpages"
              icon={<Globe className="h-4 w-4 text-primary" />}
              placeholder="https://example.com/article"
              addLabel="Add webpage"
              emptyLabel="No webpages added yet."
            />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card/60 p-5 backdrop-blur">
      {children}
    </div>
  );
}

function useList(endpoint: string) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch(endpoint);
      const raw: unknown[] = Array.isArray(data)
        ? data
        : (data?.items || data?.results || data?.documents || data?.docs || data?.videos || data?.webpages || []);
      const arr: Item[] = raw.map((v, i) => {
        if (typeof v === "string") return { id: v, name: v };
        const obj = v as Record<string, unknown>;
        // Documents: {filename, chunks} → use filename as id for delete
        if (obj.filename) return { id: obj.filename as string, name: obj.filename as string, chunks: obj.chunks as number };
        // Videos: {url, title} → use url as id for delete, title for display
        if (obj.url) return { id: obj.url as string, url: obj.url as string, title: obj.title as string ?? obj.url as string };
        return { ...(obj as Item), id: (obj.id ?? obj.name ?? obj.filename ?? i) as string | number };
      });
      setItems(arr);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    load();
  }, [load]);

  return { items, setItems, loading, error, reload: load };
}

function DocumentsTab() {
  const listEndpoint = "/docs";
  const uploadEndpoint = "/upload";
  const { items, loading, error, reload } = useList(listEndpoint);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function pollUntilDone(jobId: string, filename: string): Promise<void> {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const job = await apiFetch(`/upload/${jobId}`);
        if (job.status === "done") return;
        if (job.status === "error") throw new Error(job.error || "Processing failed");
        setUploadStatus(`Processing ${filename}…`);
      } catch (e) {
        if (e instanceof Error && e.message.includes("Processing failed")) throw e;
      }
    }
    throw new Error("Timed out waiting for document to be indexed");
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(true);
    setUploadError(null);
    setUploadStatus(null);
    try {
      for (const file of list) {
        setUploadStatus(`Uploading ${file.name}…`);
        const fd = new FormData();
        fd.append("file", file);
        const res = await apiFetch(uploadEndpoint, { method: "POST", body: fd });
        // Upload is async — poll until the background job finishes indexing
        if (res?.job_id) {
          setUploadStatus(`Indexing ${file.name}…`);
          await pollUntilDone(res.job_id, file.name);
        }
      }
      setUploadStatus(null);
      await reload();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      setUploadStatus(null);
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files);
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) uploadFiles(e.target.files);
    e.target.value = "";
  }

  async function remove(id: Item["id"]) {
    try {
      await apiFetch(`/docs/${encodeURIComponent(String(id))}`, { method: "DELETE" });
      await reload();
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <Panel>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-border/70 bg-background/40 px-6 py-10 text-center transition-colors",
          dragOver && "border-primary/70 bg-primary/5",
        )}
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Upload className="h-5 w-5" />
        </div>
        <p className="mt-3 text-sm font-medium">
          {uploadStatus ?? (uploading ? "Uploading…" : "Drag & drop files here, or click to browse")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">PDF, DOCX, TXT and more</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={onChange}
        />
      </div>

      {uploadError && (
        <p className="mt-3 text-xs text-destructive">{uploadError}</p>
      )}

      <ItemList
        items={items}
        loading={loading}
        error={error}
        emptyLabel="No documents uploaded yet."
        onRemove={remove}
        renderLabel={(it) => it.filename || it.name || it.title || String(it.id)}
        renderSubLabel={(it) => it.chunks != null ? `${it.chunks} chunks indexed` : undefined}
        icon={<FileText className="h-4 w-4 text-primary" />}
      />
    </Panel>
  );
}

function UrlTab({
  endpoint,
  icon,
  placeholder,
  addLabel,
  emptyLabel,
}: {
  kind: string;
  endpoint: string;
  icon: React.ReactNode;
  placeholder: string;
  addLabel: string;
  emptyLabel: string;
}) {
  const { items, loading, error, reload } = useList(endpoint);
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitStatus("Processing… this can take up to a minute");
    try {
      await apiFetch(endpoint, {
        method: "POST",
        body: JSON.stringify({ url: url.trim() }),
      });
      setUrl("");
      setSubmitStatus(null);
      await reload();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Failed to add");
    } finally {
      setSubmitting(false);
      setSubmitStatus(null);
    }
  }

  async function remove(id: Item["id"]) {
    try {
      await apiFetch(`${endpoint}/${id}`, { method: "DELETE" });
      await reload();
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <Panel>
      <form onSubmit={add} className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={placeholder}
          required
        />
        <Button type="submit" disabled={submitting || !url.trim()}>
          {submitting ? "Processing…" : addLabel}
        </Button>
      </form>
      {submitStatus && <p className="mt-2 text-xs text-muted-foreground">{submitStatus}</p>}
      {submitError && <p className="mt-2 text-xs text-destructive">{submitError}</p>}

      <ItemList
        items={items}
        loading={loading}
        error={error}
        emptyLabel={emptyLabel}
        onRemove={remove}
        renderLabel={(it) => (it.title && it.title !== it.url ? it.title : it.url || it.name || String(it.id))}
        renderSubLabel={(it) => (it.title && it.title !== it.url && it.url ? it.url : undefined)}
        icon={icon}
      />
    </Panel>
  );
}

function ItemList({
  items,
  loading,
  error,
  emptyLabel,
  onRemove,
  renderLabel,
  renderSubLabel,
  icon,
}: {
  items: Item[];
  loading: boolean;
  error: string | null;
  emptyLabel: string;
  onRemove: (id: Item["id"]) => void;
  renderLabel: (it: Item) => string;
  renderSubLabel?: (it: Item) => string | undefined;
  icon: React.ReactNode;
}) {
  return (
    <div className="mt-6">
      <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Library
      </div>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-background/30">
          {items.map((it) => {
            const sub = renderSubLabel?.(it);
            return (
              <li
                key={String(it.id)}
                className="flex items-center gap-3 px-4 py-3"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
                  {icon}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{renderLabel(it)}</div>
                  {sub && (
                    <div className="truncate text-xs text-muted-foreground">{sub}</div>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onRemove(it.id)}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label="Remove"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}