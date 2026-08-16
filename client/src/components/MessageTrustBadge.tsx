// MessageTrustBadge — a small icon and label describing how far a message can
// be trusted, with the reasoning on hover.
//
// It renders one verdict at a time. Callers pass either the signature verdict
// (did the right person send this?) or the integrity verdict (does the stored
// copy still match what was written?), because those are separate checks.
//
// When the sender's public key is known, the tooltip also carries a short
// fingerprint — the first 8 hex chars of its SHA-256 — so two people can read
// it aloud and confirm they are talking to the same device rather than to
// someone who claimed the username later.

import { useEffect, useState } from "react";
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  type LucideIcon,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getFingerprint } from "@/lib/identity";
import { cn } from "@/lib/utils";
import type { TrustStatus } from "@/types";

// Everything a trust state looks like lives in this table. Adding a state is a
// new entry here, and no caller has to change.
const TRUST_STATUS: Record<
  TrustStatus,
  { icon: LucideIcon; label: string; detail: string; className: string }
> = {
  valid: {
    icon: ShieldCheck,
    label: "Signed",
    detail:
      "This message carries a valid signature from the key its sender registered, so it was written by them and has not been altered since.",
    className: "text-moss",
  },
  invalid: {
    icon: ShieldX,
    label: "Invalid signature",
    detail:
      "The signature on this message does not match the key its sender registered. Treat the message as coming from someone else.",
    className: "text-rust",
  },
  unsigned: {
    icon: Shield,
    label: "Unsigned",
    detail:
      "This message arrived without a signature, so there is nothing proving who sent it. Messages stored before signing was added look like this.",
    className: "text-mist",
  },
  unknown: {
    icon: ShieldQuestion,
    label: "Signature unknown",
    detail:
      "The stored copy of this message could not be read, so its signature cannot be checked either way.",
    className: "text-mist",
  },
  failed: {
    icon: ShieldAlert,
    label: "Integrity check failed",
    detail:
      "The stored copy of this message no longer matches its authentication tag, so it was changed after it was sent.",
    className: "text-rust",
  },
};

export function MessageTrustBadge({
  status,
  senderPublicKey = null,
  className,
}: {
  status: TrustStatus;
  /** base64 SPKI public key string, or null when there is no key to show */
  senderPublicKey?: string | null;
  className?: string;
}) {
  const { icon: Icon, label, detail, className: statusClass } = TRUST_STATUS[status];
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  // Hashing is async, so the badge renders without the fingerprint first and
  // picks it up on the next paint. A key that will not hash simply leaves the
  // line off rather than failing the whole badge.
  useEffect(() => {
    if (!senderPublicKey) {
      setFingerprint(null);
      return;
    }

    let active = true;
    getFingerprint(senderPublicKey)
      .then((value) => {
        if (active) setFingerprint(value);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [senderPublicKey]);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className={cn(
              "inline-flex items-center gap-1 font-mono text-[0.7rem]",
              statusClass,
              className
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {detail}
          {fingerprint && (
            <span className="mt-1 block font-mono opacity-80">key: {fingerprint}</span>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
