// What the server replayed from the database when you logged in.
//
// The messages themselves are already in the timeline, so this panel exists to
// answer a narrower question: which of them came out of storage rather than
// arriving live, and what condition were they in when they were read back.

import { MessageTrustBadge } from "@/components/MessageTrustBadge";
import { colorForUser } from "@/lib/userColor";
import type { ChatMessageItem, TimelineItem } from "@/types";

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function HistoryPanel({ timeline }: { timeline: TimelineItem[] }) {
  const restored = timeline.filter(
    (item): item is ChatMessageItem => item.kind === "chat" && item.fromHistory
  );

  return (
    <div className="border-b border-hairline bg-linen px-4 py-3 md:px-6">
      <p className="mb-2 font-mono text-[0.65rem] tracking-wider text-mist uppercase">
        Restored from the database
      </p>

      {restored.length === 0 ? (
        <p className="text-sm text-mist">
          Nothing stored yet. Send a message, reload the page, and it will be
          here.
        </p>
      ) : (
        <ol className="max-h-56 divide-y divide-hairline overflow-y-auto rounded-md border border-hairline bg-paper">
          {restored.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2"
            >
              <span
                className="text-sm font-semibold"
                style={{ color: colorForUser(item.username) }}
              >
                {item.username}
              </span>
              <span className="font-mono text-[0.7rem] text-mist">
                {formatTime(item.timestamp)}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-ink">
                {item.text ?? (
                  <span className="text-mist italic">could not be read</span>
                )}
              </span>
              <MessageTrustBadge
                status={item.integrity ?? item.signature}
                senderPublicKey={item.senderPublicKey}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
