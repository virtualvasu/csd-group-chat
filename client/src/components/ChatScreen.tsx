import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MessageTrustBadge } from "@/components/MessageTrustBadge";
import { MessageRecord } from "@/components/MessageRecord";
import { HistoryPanel } from "@/components/HistoryPanel";
import { SecurityPanel } from "@/components/SecurityPanel";
import { cn } from "@/lib/utils";
import { colorForUser } from "@/lib/userColor";
import type { ConnectionStatus, TimelineItem } from "@/types";

// Which form of a message the timeline is showing. "text" is what was written;
// "stored" is the ciphertext the database actually holds for it. Reading the
// same conversation both ways is the point — it makes "messages are not stored
// as plaintext" something you can see rather than something you are told.
type MessageView = "text" | "stored";

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

function ViewToggle({
  view,
  onChange,
}: {
  view: MessageView;
  onChange: (view: MessageView) => void;
}) {
  const options: { value: MessageView; label: string }[] = [
    { value: "text", label: "Message" },
    { value: "stored", label: "Stored bytes" },
  ];

  return (
    <div
      role="group"
      aria-label="Message view"
      className="inline-flex rounded-md border border-hairline bg-linen p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={view === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-[0.2rem] px-2.5 py-1 font-mono text-[0.7rem] transition-colors",
            view === option.value
              ? "bg-paper text-ink shadow-sm"
              : "text-mist hover:text-ink"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
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
  historyCount,
  publicKey,
  onSend,
  onTyping,
}: {
  username: string;
  connectionStatus: ConnectionStatus;
  onlineUsers: string[];
  typingUsers: string[];
  timeline: TimelineItem[];
  historyCount: number;
  publicKey: string | null;
  onSend: (text: string) => void;
  onTyping: (typing: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [view, setView] = useState<MessageView>("text");
  const [showHistory, setShowHistory] = useState(false);
  const [openRecordId, setOpenRecordId] = useState<string | null>(null);
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
      <aside className="flex shrink-0 flex-col gap-3 overflow-y-auto border-b border-hairline bg-linen p-4 md:h-full md:w-64 md:border-b-0 md:border-r">
        <div className="flex items-baseline justify-between gap-2">
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

        <SecurityPanel
          username={username}
          publicKey={publicKey}
          timeline={timeline}
        />
      </aside>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-hairline bg-card px-4 py-2.5 md:px-6">
          <button
            type="button"
            onClick={() => setShowHistory((open) => !open)}
            aria-expanded={showHistory}
            className="rounded-md border border-hairline bg-linen px-2.5 py-1 font-mono text-[0.7rem] text-mist transition-colors hover:text-ink"
          >
            {historyCount === 1
              ? "1 message restored"
              : `${historyCount} messages restored`}
            <span aria-hidden="true"> {showHistory ? "▲" : "▼"}</span>
          </button>

          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-mist sm:inline">
              Click a message to see its stored record
            </span>
            <ViewToggle view={view} onChange={setView} />
          </div>
        </header>

        {showHistory && <HistoryPanel timeline={timeline} />}

        {view === "stored" && (
          <p className="shrink-0 border-b border-hairline bg-linen px-4 py-2 text-xs text-mist md:px-6">
            Showing the ciphertext each message is stored as. This is what the
            database holds — the readable text exists only in transit and on
            screen.
          </p>
        )}

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 space-y-1.5 overflow-y-auto px-4 py-4 md:px-6"
        >
          {timeline.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
              <p className="font-display text-lg text-ink">No messages yet</p>
              <p className="max-w-xs text-sm text-mist">
                Send one, then reload the page — it will come back from the
                database, signed and checked.
              </p>
            </div>
          )}

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
                    {/* Who sent this. Left off when the message failed its
                        integrity check, because the verdict there is only ever
                        "unknown" and the block below already says so. */}
                    {!item.integrity && (
                      <MessageTrustBadge
                        status={item.signature}
                        senderPublicKey={item.senderPublicKey}
                      />
                    )}
                  </span>
                )}
                {item.integrity ? (
                  // The text of this one is not shown at all. What the database
                  // holds is not what was sent, so there is nothing here worth
                  // displaying as the message.
                  <button
                    type="button"
                    aria-expanded={openRecordId === item.id}
                    onClick={() =>
                      setOpenRecordId((current) =>
                        current === item.id ? null : item.id
                      )
                    }
                    className={cn(
                      "flex max-w-[75ch] cursor-pointer flex-col gap-1 rounded-md border border-rust/40 bg-rust/5 px-3 py-1.5 text-left transition-colors hover:bg-rust/10",
                      item.own ? "items-end" : "items-start"
                    )}
                  >
                    <MessageTrustBadge status={item.integrity} />
                    <p className="text-[0.925rem] leading-relaxed text-mist italic">
                      The stored copy of this message no longer matches its
                      authentication tag, so it was changed after it was sent.
                    </p>
                  </button>
                ) : (
                  // The bubble is a button: pressing it unfolds the database row
                  // behind the message. Nothing about the message is hidden by
                  // this, so it stays a plain toggle rather than a dialog.
                  <button
                    type="button"
                    aria-expanded={openRecordId === item.id}
                    onClick={() =>
                      setOpenRecordId((current) =>
                        current === item.id ? null : item.id
                      )
                    }
                    className={cn(
                      "max-w-[75ch] cursor-pointer rounded-md px-3 py-1.5 text-left text-[0.925rem] leading-relaxed break-words transition-colors hover:bg-linen",
                      item.own ? "border-r-2" : "border-l-2"
                    )}
                    style={{ borderColor: colorForUser(item.username) }}
                  >
                    {view === "stored" ? (
                      <span className="font-mono text-[0.7rem] break-all text-mist">
                        {item.stored?.ciphertext ?? "not recorded"}
                      </span>
                    ) : (
                      item.text
                    )}
                  </button>
                )}

                {openRecordId === item.id && <MessageRecord message={item} />}
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
