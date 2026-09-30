"use client";

import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AssistantBlock } from "@/domain/assistant/blocks";
import { cn } from "@/lib/utils";

/**
 * Storefront assistant (ADR 0017): a launcher and a non-blocking chat panel (bottom sheet on
 * phones). Facts are shown as cards built by the server from tool results; the assistant's text is
 * plain text. The page keeps working normally with the panel open or closed.
 */

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  blocks: AssistantBlock[];
  error?: boolean;
}

type PageContext =
  | { kind: "product"; slug: string }
  | { kind: "category"; slug: string }
  | { kind: "quote"; token: string }
  | { kind: "other" };

const MAX_CHARS = 1000;
const SUGGESTIONS = [
  "Do you have a water slide for Saturday?",
  "I have about 40 kids. What do you recommend?",
  "How much would this cost at my address?",
];

function pageContext(pathname: string): PageContext {
  const product = /^\/rentals\/([a-z0-9-]+)$/.exec(pathname);
  if (product) return { kind: "product", slug: product[1] ?? "" };
  const category = /^\/categories\/([a-z0-9-]+)$/.exec(pathname);
  if (category) return { kind: "category", slug: category[1] ?? "" };
  const quote = /^\/q\/([A-Za-z0-9_-]{43})$/.exec(pathname);
  if (quote) return { kind: "quote", token: quote[1] ?? "" };
  return { kind: "other" };
}

const STORAGE_KEY = "rc_ai_transcript";
function loadTranscript(): ChatMessage[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as ChatMessage[]).slice(-60) : [];
  } catch {
    return [];
  }
}
function saveTranscript(messages: ChatMessage[]) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-60)));
  } catch {
    // Storage unavailable (private mode): the conversation still works for this page view.
  }
}

let counter = 0;
const nextId = () => `m${String(Date.now())}-${String(++counter)}`;

export function AssistantWidget({ businessName }: { businessName: string }) {
  const pathname = usePathname();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  // The panel is closed on first render, so restoring the tab's transcript here cannot cause a
  // hydration mismatch.
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    typeof window === "undefined" ? [] : loadTranscript(),
  );
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastFailed, setLastFailed] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    saveTranscript(messages);
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Focus returns to the launcher after the panel closes (the launcher is hidden while the panel
  // is open on phones, so it can only take focus once it is rendered again).
  const restoreFocusRef = useRef(false);
  const close = useCallback(() => {
    restoreFocusRef.current = true;
    setOpen(false);
  }, []);
  useEffect(() => {
    if (!open && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      launcherRef.current?.focus();
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim().slice(0, MAX_CHARS);
      if (!message || busy) return;
      setBusy(true);
      setLastFailed(null);
      setDraft("");
      setMessages((m) => [...m, { id: nextId(), role: "user", text: message, blocks: [] }]);
      try {
        const res = await fetch("/api/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, page: pageContext(pathname) }),
        });
        const data = (await res.json().catch(() => null)) as {
          status?: string;
          reply?: string;
          blocks?: AssistantBlock[];
        } | null;
        const failed = !res.ok || data?.status !== "ok";
        setMessages((m) => [
          ...m,
          {
            id: nextId(),
            role: "assistant",
            text: data?.reply ?? "The assistant is unavailable right now. Please try again.",
            blocks: data?.blocks ?? [],
            ...(failed ? { error: true } : {}),
          },
        ]);
        if (failed) setLastFailed(message);
      } catch {
        setMessages((m) => [
          ...m,
          {
            id: nextId(),
            role: "assistant",
            text: "We couldn't reach the assistant. Check your connection and try again.",
            blocks: [],
            error: true,
          },
        ]);
        setLastFailed(message);
      } finally {
        setBusy(false);
      }
    },
    [busy, pathname],
  );

  const newChat = useCallback(async () => {
    await fetch("/api/assistant", { method: "DELETE" }).catch(() => undefined);
    setMessages([]);
    setLastFailed(null);
    inputRef.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((o) => !o);
        }}
        className={cn(
          "fixed bottom-24 right-4 z-40 inline-flex min-h-12 items-center gap-2 rounded-full bg-primary px-5 font-bold text-primary-foreground shadow-lg md:bottom-6 md:right-6",
          "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/40",
          open && "hidden md:inline-flex",
        )}
      >
        <span aria-hidden="true">💬</span>
        {open ? "Close assistant" : "Ask our assistant"}
      </button>

      {open ? (
        <section
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-label={`${businessName} rental assistant`}
          className="fixed inset-x-0 bottom-0 z-50 flex h-[85dvh] flex-col rounded-t-3xl border bg-background shadow-2xl md:inset-x-auto md:bottom-24 md:right-6 md:h-[min(640px,80dvh)] md:w-[400px] md:rounded-3xl"
        >
          <header className="flex items-center gap-2 border-b px-4 py-3">
            <h2 className="flex-1 text-base font-bold">Rental assistant</h2>
            <button
              type="button"
              onClick={() => {
                void newChat();
              }}
              className="min-h-10 rounded-full px-3 text-sm font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/40"
            >
              New chat
            </button>
            <button
              type="button"
              aria-label="Close assistant"
              onClick={close}
              className="grid size-10 place-items-center rounded-full text-xl hover:bg-muted focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/40"
            >
              ×
            </button>
          </header>

          <div
            ref={listRef}
            className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
            aria-live="polite"
          >
            {messages.length === 0 ? (
              <div className="grid gap-3">
                <p className="text-sm text-muted-foreground">
                  Hi! I can help you find rentals, check a date, get a price and build a quote.
                </p>
                <ul className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <li key={s}>
                      <button
                        type="button"
                        onClick={() => {
                          void send(s);
                        }}
                        className="min-h-10 rounded-full border px-3 text-left text-sm hover:border-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/40"
                      >
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {messages.map((m) => (
              <MessageView key={m.id} message={m} />
            ))}
            {busy ? (
              <p className="text-sm text-muted-foreground" role="status">
                Checking…
              </p>
            ) : null}
            {lastFailed && !busy ? (
              <button
                type="button"
                onClick={() => {
                  void send(lastFailed);
                }}
                className="min-h-10 rounded-full border px-4 text-sm font-semibold hover:border-primary"
              >
                Try again
              </button>
            ) : null}
          </div>

          <form
            className="grid gap-2 border-t p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send(draft);
            }}
          >
            <div className="flex items-end gap-2">
              <label htmlFor={`${panelId}-input`} className="sr-only">
                Message the assistant
              </label>
              <textarea
                id={`${panelId}-input`}
                ref={inputRef}
                value={draft}
                maxLength={MAX_CHARS}
                rows={2}
                onChange={(e) => {
                  setDraft(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(draft);
                  }
                }}
                placeholder="Ask about rentals, dates or prices…"
                className="min-h-11 flex-1 resize-none rounded-2xl border border-input bg-background px-3 py-2 text-base outline-none focus-visible:ring-4 focus-visible:ring-primary/30"
              />
              <button
                type="submit"
                disabled={busy || draft.trim() === ""}
                className="min-h-11 rounded-full bg-primary px-4 font-bold text-primary-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/40"
              >
                Send
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Prices and availability come from our booking system. The assistant can&apos;t confirm
              bookings or take payments.
            </p>
          </form>
        </section>
      ) : null}
    </>
  );
}

function MessageView({ message }: { message: ChatMessage }) {
  const mine = message.role === "user";
  return (
    <div className={cn("grid gap-2", mine ? "justify-items-end" : "justify-items-start")}>
      <p
        className={cn(
          "max-w-[85%] whitespace-pre-line rounded-2xl px-3 py-2 text-sm",
          mine ? "bg-primary text-primary-foreground" : "bg-muted",
          message.error && "border border-destructive/40",
        )}
      >
        <span className="sr-only">{mine ? "You: " : "Assistant: "}</span>
        {message.text}
      </p>
      {message.blocks.map((b, i) => (
        // Blocks of one message are immutable; position is their identity.
        // eslint-disable-next-line @eslint-react/no-array-index-key
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}

const card = "w-full rounded-2xl border bg-card p-3 text-sm";

function BlockView({ block }: { block: AssistantBlock }) {
  switch (block.type) {
    case "products":
      return (
        <ul className="grid w-full gap-2" aria-label="Suggested rentals">
          {block.products.map((p) => (
            <li key={p.slug} className={cn(card, "flex gap-3")}>
              {p.image ? (
                // eslint-disable-next-line @next/next/no-img-element -- tenant media route
                <img
                  src={p.image.url}
                  alt={p.image.alt}
                  width={64}
                  height={48}
                  className="h-12 w-16 rounded-lg object-cover"
                  loading="lazy"
                />
              ) : null}
              <div className="min-w-0">
                <Link href={p.url as Route} className="font-semibold text-primary hover:underline">
                  {p.name}
                </Link>
                {p.fromPrice ? <p className="text-muted-foreground">{p.fromPrice}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      );
    case "availability":
      return (
        <div className={card} data-testid="availability-card">
          <p className="font-semibold">
            <Link href={block.product.url as Route} className="hover:underline">
              {block.product.name}
            </Link>
            {block.variantName ? ` — ${block.variantName}` : ""}
          </p>
          <p className="text-muted-foreground">
            {block.when} · qty {block.quantity}
          </p>
          <p
            className={cn(
              "mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-bold",
              block.status === "available"
                ? "bg-emerald-100 text-emerald-900"
                : block.status === "unavailable"
                  ? "bg-red-100 text-red-900"
                  : "bg-amber-100 text-amber-900",
            )}
          >
            {block.status === "available"
              ? `Available${block.limited ? " (only a few left)" : ""}`
              : block.status === "unavailable"
                ? "Not available"
                : "Needs team review"}
          </p>
          {block.reasons.length ? (
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              {block.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    case "price":
      return (
        <div className={card} data-testid="price-card">
          <p className="font-semibold">Price · {block.when}</p>
          {block.status === "priced" ? (
            <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
              {[...block.lines, ...block.taxLines].map((l) => (
                <div key={`${l.label}-${l.amount}`} className="contents">
                  <dt className="text-muted-foreground">{l.label}</dt>
                  <dd className="text-right tabular-nums">{l.amount}</dd>
                </div>
              ))}
              <dt className="font-bold">Total</dt>
              <dd className="text-right font-bold tabular-nums">{block.total}</dd>
            </dl>
          ) : (
            <>
              <p className="mt-1">Our team needs to review this before giving a confirmed price.</p>
              {block.reasons.length ? (
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                  {block.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
      );
    case "service_area":
      return (
        <div className={card}>
          <p className="font-semibold">Delivery to {block.address}</p>
          <p className="text-muted-foreground">
            {block.status === "serviceable"
              ? `${block.label ?? "Delivery"}: ${block.fee ?? ""}`
              : block.status === "outside_service_area"
                ? "Outside our delivery area — the team can review special requests."
                : "Our team needs to review delivery to this address."}
          </p>
        </div>
      );
    case "quote":
      return (
        <div className={card} data-testid="quote-card">
          <p className="font-semibold">
            Quote {block.quoteNumber}
            {block.replaces ? ` (replaces ${block.replaces})` : ""}
          </p>
          <p className="text-muted-foreground">
            {block.priceIsFinal && block.total
              ? `Total ${block.total}`
              : "Price pending team review"}
          </p>
          {block.url ? (
            <Link
              href={block.url as Route}
              className="mt-1 inline-block font-semibold text-primary hover:underline"
            >
              View your quote
            </Link>
          ) : null}
        </div>
      );
    case "booking":
      return (
        <div
          className={cn(
            card,
            block.status === "hold_placed" ? "border-emerald-300" : "border-amber-300",
          )}
          data-testid="booking-card"
          role="status"
        >
          <p className="font-semibold">
            {block.status === "hold_placed" ? "Booking requested" : "Booking request"} · Quote{" "}
            {block.quoteNumber}
          </p>
          <p className="text-muted-foreground">{block.message}</p>
        </div>
      );
  }
}
