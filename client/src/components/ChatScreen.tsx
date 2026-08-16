import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MessageTrustBadge } from "@/components/MessageTrustBadge";
import { cn } from "@/lib/utils";
import { colorForUser } from "@/lib/userColor";
import type { ConnectionStatus, TimelineItem } from "@/types";

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
};

const STATUS_COLOR: Record<ConnectionStatus, string> = {
  connected: "bg-moss",
  reconnecting: "bg-amber",
  disconnected: "bg-rust",
};

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono text-[0.7rem] text-mist"
      aria-live="polite"
    >
      <span className={cn("size-1.5 rounded-full", STATUS_COLOR[status])} />
      {STATUS_LABEL[status]}
    </span>
  );
}

function TypingIndicator({ users }: { users: string[] }) {
  if (users.length === 0) return <span className="opacity-0">·</span>;
  const label =
    users.length === 1
      ? `${users[0]} is typing`
      : users.length === 2
      ? `${users[0]} and ${users[1]} are typing`
      : "Several people are typing";
  return <span>{label}…</span>;
}

export function ChatScreen({
  username,
  connectionStatus,
  onlineUsers,
  typingUsers,
  timeline,
  onSend,
  onTyping,
}: {
  username: string;
  connectionStatus: ConnectionStatus;
  onlineUsers: string[];
  typingUsers: string[];
  timeline: TimelineItem[];
  onSend: (text: string) => void;
  onTyping: (typing: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [showScrollButton, setShowScrollButton] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomAnchor = useRef<HTMLDivElement>(null);
  const wasNearBottom = useRef(true);

  useEffect(() => {
    if (wasNearBottom.current) {
      bottomAnchor.current?.scrollIntoView({ block: "end" });
    }
  }, [timeline]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < 80;
    wasNearBottom.current = nearBottom;
    setShowScrollButton(!nearBottom);
  }

  function scrollToLatest() {
    bottomAnchor.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    wasNearBottom.current = true;
    setShowScrollButton(false);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSend(draft);
    setDraft("");
  }

  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col gap-3 border-b border-hairline bg-linen p-4 md:h-full md:w-56 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-base font-medium text-ink">
            Online
          </h2>
          <ConnectionBadge status={connectionStatus} />
        </div>
        <ul className="flex flex-wrap gap-2 md:flex-col md:gap-1.5">
          {onlineUsers.map((user) => (
            <li
              key={user}
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm text-ink"
            >
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: colorForUser(user) }}
              />
              <span className="truncate font-medium" style={{ color: colorForUser(user) }}>
                {user}
              </span>
              {user === username && (
                <span className="text-xs text-mist">(you)</span>
              )}
            </li>
          ))}
        </ul>
      </aside>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 space-y-1.5 overflow-y-auto px-4 py-4 md:px-6"
        >
          {timeline.map((item) =>
            item.kind === "system" ? (
              <div key={item.id} className="flex justify-center py-1">
                <span className="rounded-full bg-linen px-3 py-1 font-mono text-[0.7rem] text-mist">
                  {item.text} · {formatTime(item.timestamp)}
                </span>
              </div>
            ) : (
              <div
                key={item.id}
                className={cn(
                  "flex flex-col",
                  item.own ? "items-end" : "items-start",
                  item.grouped ? "mt-0.5" : "mt-3"
                )}
              >
                {!item.grouped && (
                  <span
                    className={cn(
                      "mb-0.5 flex items-baseline gap-2 px-1",
                      item.own && "flex-row-reverse"
                    )}
                  >
                    <span
                      className="text-sm font-semibold"
                      style={{ color: colorForUser(item.username) }}
                    >
                      {item.username}
                      {item.own && <span className="text-mist font-normal"> (you)</span>}
                    </span>
                    <span className="font-mono text-[0.7rem] text-mist">
                      {formatTime(item.timestamp)}
                    </span>
                    {/* Signature trust badge — shown beside the timestamp */}
                    <MessageTrustBadge
                      status={item.signature}
                      senderPublicKey={item.senderPublicKey}
                    />
                  </span>
                )}
                <p
                  className={cn(
                    "max-w-[75ch] rounded-md px-3 py-1.5 text-[0.925rem] leading-relaxed break-words",
                    item.own ? "border-r-2" : "border-l-2"
                  )}
                  style={{ borderColor: colorForUser(item.username) }}
                >
                  {item.text}
                </p>
              </div>
            )
          )}
          <div ref={bottomAnchor} />
        </div>

        {showScrollButton && (
          <button
            type="button"
            onClick={scrollToLatest}
            className="absolute bottom-20 left-1/2 -translate-x-1/2 rounded-full border border-hairline bg-card px-3 py-1.5 text-xs font-medium text-ink shadow-sm hover:bg-linen"
          >
            ↓ New messages
          </button>
        )}

        <div className="h-5 px-4 font-mono text-xs text-mist md:px-6">
          <TypingIndicator users={typingUsers} />
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex gap-2 border-t border-hairline bg-card p-3 md:px-6"
        >
          <Input
            autoFocus
            maxLength={500}
            autoComplete="off"
            placeholder="Type a message…"
            aria-label="Message"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              onTyping(e.target.value.trim().length > 0);
            }}
            className="h-10"
          />
          <Button type="submit" className="h-10 bg-moss text-white hover:bg-moss/90">
            Send
          </Button>
        </form>
      </div>
    </div>
  );
}
