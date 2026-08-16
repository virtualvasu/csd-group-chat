import { ShieldAlert, type LucideIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { TrustStatus } from "@/types";

// Everything a trust state looks like lives in this table. Adding a state is a
// new entry here, and no caller has to change.
const TRUST_STATUS: Record<
  TrustStatus,
  { icon: LucideIcon; label: string; detail: string; className: string }
> = {
  failed: {
    icon: ShieldAlert,
    label: "Integrity check failed",
    detail:
      "The stored copy of this message no longer matches its authentication tag, so it was changed after it was sent.",
    className: "text-rust",
  },
};

// A small icon with a label and an explanation on hover, describing how far a
// message can be trusted.
export function MessageTrustBadge({
  status,
  className,
}: {
  status: TrustStatus;
  className?: string;
}) {
  const { icon: Icon, label, detail, className: statusClass } = TRUST_STATUS[status];

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
        <TooltipContent>{detail}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
