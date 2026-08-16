// The database row behind one message, unfolded underneath it.
//
// This is the answer to "how do I know any of this is real?". Every value here
// is the stored record itself — the bytes the database holds, the nonce they
// were sealed with, the signature that came with them — rather than a summary
// the interface wrote about them. The two verdicts at the bottom are recomputed
// by the server on every read, never stored, so a tampered row cannot vouch for
// itself.

import { useEffect, useState } from "react";
import { MessageTrustBadge } from "@/components/MessageTrustBadge";
import { getFingerprint } from "@/lib/identity";
import type { ChatMessageItem } from "@/types";

function Row({
  label,
  note,
  children,
}: {
  label: string;
  /** What the value is, in scheme terms. Kept out of the value itself so the
      bytes stay copyable and the explanation stays readable. */
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-3 border-t border-hairline px-3 py-2 first:border-t-0 sm:grid-cols-[8rem_1fr]">
      <dt className="font-mono text-[0.65rem] tracking-wider text-mist uppercase">
        {label}
      </dt>
      <dd className="min-w-0">
        <span className="block font-mono text-[0.7rem] leading-relaxed break-all text-ink">
          {children}
        </span>
        {note && (
          <span className="mt-0.5 block text-[0.65rem] text-mist">{note}</span>
        )}
      </dd>
    </div>
  );
}

function formatStamp(value: number | null) {
  if (value === null) return "not recorded";

  return new Date(value).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function MessageRecord({ message }: { message: ChatMessageItem }) {
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const stored = message.stored;

  useEffect(() => {
    if (!message.senderPublicKey) {
      setFingerprint(null);
      return;
    }

    let active = true;
    getFingerprint(message.senderPublicKey)
      .then((value) => {
        if (active) setFingerprint(value);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [message.senderPublicKey]);

  return (
    <dl className="mt-1.5 w-full max-w-[75ch] overflow-hidden rounded-md border border-hairline bg-linen">
      <Row label="Row id" note="MongoDB _id for this message">
        {message.id}
      </Row>
      <Row
        label="Ciphertext"
        note="AES-256-GCM, with the 16-byte authentication tag on the end"
      >
        {stored?.ciphertext ?? <span className="text-mist">not recorded</span>}
      </Row>
      <Row label="Nonce" note="12 random bytes, unique to this message">
        {stored?.nonce ?? <span className="text-mist">not recorded</span>}
      </Row>
      <Row
        label="Signature"
        note="ECDSA P-256 over sender, timestamp and text"
      >
        {stored?.signature ?? <span className="text-mist">not recorded</span>}
      </Row>
      <Row label="Sender key" note="first 8 hex of the SHA-256 of their public key">
        {fingerprint ?? (
          <span className="text-mist">no key on this message</span>
        )}
      </Row>
      <Row label="Signed at" note="the sender's clock, and what the signature covers">
        {formatStamp(stored?.clientTimestamp ?? null)}
      </Row>
      <Row label="Stored at" note="the server's clock when it accepted the message">
        {formatStamp(message.timestamp)}
      </Row>
      <Row label="Source">
        {message.fromHistory
          ? "read back from the database on login"
          : "written to the database, then broadcast"}
      </Row>
      <Row label="Checked" note="recomputed on every read, never read back from storage">
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <MessageTrustBadge
            status={message.signature}
            senderPublicKey={message.senderPublicKey}
          />
          {message.integrity && <MessageTrustBadge status={message.integrity} />}
        </span>
      </Row>
    </dl>
  );
}
