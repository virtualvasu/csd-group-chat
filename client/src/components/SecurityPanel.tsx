// The security ledger: what protects this room, with live values.
//
// Everything the server does — the login proof, the cipher, the signature
// scheme, the state of the stored room — happens out of sight. This panel is
// where it surfaces, so the guarantees are readable from the interface instead
// of only from the source.
//
// The counts are derived from the timeline rather than reported by the server,
// which means they move as verdicts arrive and cannot drift from what the
// messages themselves say.

import { useEffect, useState } from "react";
import { getFingerprint } from "@/lib/identity";
import { cn } from "@/lib/utils";
import type { TimelineItem } from "@/types";

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-hairline pt-3">
      <h3 className="mb-1.5 font-mono text-[0.6rem] tracking-[0.12em] text-mist uppercase">
        {label}
      </h3>
      <dl className="space-y-1">{children}</dl>
    </section>
  );
}

function Line({
  term,
  children,
  tone = "ink",
}: {
  term: string;
  children: React.ReactNode;
  tone?: "ink" | "moss" | "rust" | "mist";
}) {
  const toneClass = {
    ink: "text-ink",
    moss: "text-moss",
    rust: "text-rust",
    mist: "text-mist",
  }[tone];

  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-xs text-mist">{term}</dt>
      <dd className={cn("truncate font-mono text-[0.7rem]", toneClass)}>
        {children}
      </dd>
    </div>
  );
}

export function SecurityPanel({
  username,
  publicKey,
  timeline,
}: {
  username: string;
  publicKey: string | null;
  timeline: TimelineItem[];
}) {
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [showScheme, setShowScheme] = useState(false);

  useEffect(() => {
    if (!publicKey) return;

    let active = true;
    getFingerprint(publicKey)
      .then((value) => {
        if (active) setFingerprint(value);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [publicKey]);

  const messages = timeline.filter((item) => item.kind === "chat");
  const signed = messages.filter((item) => item.signature === "valid").length;
  const tampered = messages.filter((item) => item.integrity === "failed").length;
  const unproven = messages.length - signed - tampered;

  return (
    <div className="space-y-3">
      <Section label="This session">
        <Line term="Signed in as">{username}</Line>
        <Line term="Your key">
          {fingerprint ?? <span className="text-mist">loading…</span>}
        </Line>
        <Line term="Proved by" tone="moss">
          signed challenge
        </Line>
      </Section>

      <Section label="Room record">
        <Line term="Stored">{messages.length}</Line>
        <Line term="Signature valid" tone={signed > 0 ? "moss" : "mist"}>
          {signed}
        </Line>
        <Line term="Tampered" tone={tampered > 0 ? "rust" : "mist"}>
          {tampered}
        </Line>
        {unproven > 0 && (
          <Line term="Unproven" tone="mist">
            {unproven}
          </Line>
        )}
      </Section>

      <section className="border-t border-hairline pt-3">
        <button
          type="button"
          onClick={() => setShowScheme((open) => !open)}
          aria-expanded={showScheme}
          className="mb-1.5 flex w-full items-center justify-between font-mono text-[0.6rem] tracking-[0.12em] text-mist uppercase transition-colors hover:text-ink"
        >
          How it is protected
          <span aria-hidden="true">{showScheme ? "▲" : "▼"}</span>
        </button>

        {showScheme && (
          <dl className="space-y-1">
            <Line term="At rest">AES-256-GCM</Line>
            <Line term="Tamper check">GCM auth tag</Line>
            <Line term="Signatures">ECDSA P-256</Line>
            <Line term="Cipher key" tone="mist">
              server only
            </Line>
            <Line term="Your private key" tone="mist">
              never leaves
            </Line>
          </dl>
        )}
      </section>
    </div>
  );
}
