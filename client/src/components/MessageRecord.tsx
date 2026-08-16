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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-3 border-t border-hairline px-3 py-2 first:border-t-0 sm:grid-cols-[8rem_1fr]">
      <dt className="font-mono text-[0.65rem] tracking-wider text-mist uppercase">
        {label}
      </dt>
      <dd className="min-w-0 font-mono text-[0.7rem] leading-relaxed break-all text-ink">
        {children}
      </dd>
    </div>
  );
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
      <Row label="Row id">{message.id}</Row>
      <Row label="Ciphertext">
        {stored?.ciphertext ?? <span className="text-mist">not recorded</span>}
      </Row>
      <Row label="Nonce">
        {stored?.nonce ?? <span className="text-mist">not recorded</span>}
      </Row>
      <Row label="Signature">
        {stored?.signature ?? <span className="text-mist">not recorded</span>}
      </Row>
      <Row label="Sender key">
        {fingerprint ? (
          <>
            {fingerprint}
            <span className="text-mist"> · first 8 hex of SHA-256</span>
          </>
        ) : (
          <span className="text-mist">no key on this message</span>
        )}
      </Row>
      <Row label="Source">
        {message.fromHistory
          ? "read back from the database on login"
          : "written to the database, then broadcast"}
      </Row>
      <Row label="Checked">
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
