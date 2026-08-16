// MessageTrustBadge — shows whether a chat message's ECDSA signature is valid.
//
// Three states:
//   valid    — the server verified the signature against the stored public key.
//   invalid  — the signature did not verify (message may have been tampered with).
//   unsigned — no signature was provided (stale client, backward compat).
//
// On hover a tooltip shows the first 8 hex chars of SHA-256 of the sender's
// public key — a short visual fingerprint so users can confirm they are talking
// to the same device.

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getFingerprint } from "@/lib/identity";
import { cn } from "@/lib/utils";
import type { SignatureStatus } from "@/types";

const LABEL: Record<SignatureStatus, string> = {
  valid: "✓ Signed",
  invalid: "✗ Invalid",
  unsigned: "· Unsigned",
};

const STYLE: Record<SignatureStatus, string> = {
  // moss green — matches the app's positive colour
  valid:
    "border-transparent bg-[#ddeee3] text-[#2d5c3e] hover:bg-[#cce4d4]",
  // rust red — matches the app's error colour
  invalid:
    "border-transparent bg-[#f4dbd5] text-[#8c2e1a] hover:bg-[#eecdc4]",
  // neutral mist — for unsigned/backward-compat messages
  unsigned:
    "border-[#d0cdc3] text-[#767468] bg-transparent hover:bg-[#f0ede4]",
};

interface MessageTrustBadgeProps {
  status: SignatureStatus;
  /** base64 SPKI public key string, or null when unsigned */
  senderPublicKey: string | null;
}

export function MessageTrustBadge({
  status,
  senderPublicKey,
}: MessageTrustBadgeProps) {
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  useEffect(() => {
    if (senderPublicKey) {
      getFingerprint(senderPublicKey).then(setFingerprint).catch(() => {});
    }
  }, [senderPublicKey]);

  const tooltipText = fingerprint ? `key: ${fingerprint}` : "no key";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            className={cn(
              "cursor-default select-none font-mono text-[0.65rem]",
              STYLE[status]
            )}
          >
            {LABEL[status]}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top">
          <span className="font-mono">{tooltipText}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
