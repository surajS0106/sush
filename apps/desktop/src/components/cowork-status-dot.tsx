import { useCoworkStatus, type SessionStatus } from "@/lib/sessions";
import { cn } from "@/lib/utils";

const LABELS: Record<SessionStatus, string> = {
  working: "A Cowork session is in progress",
  "needs-input": "A Cowork session is waiting for you",
};

/** A Cowork session is running (pulsing) or waiting on the user (solid). Size and position come from `className`. */
export function StatusDot({ status, className }: { status: SessionStatus; className?: string }) {
  return (
    <span className={cn("flex size-2 shrink-0 rounded-full", className)} role="status" aria-label={LABELS[status]}>
      <span className="relative size-full">
        {status === "working" && (
          <span className="absolute inset-0 rounded-full bg-brand opacity-60 motion-safe:animate-ping" />
        )}
        <span className="absolute inset-0 rounded-full bg-brand" />
      </span>
    </span>
  );
}

/**
 * The combined Cowork status as a badge on an icon button's top-right corner;
 * the button must be `relative`. `className` sets the ring that cuts it out of
 * the background behind the button.
 */
export function CoworkStatusBadge({ className }: { className?: string }) {
  const status = useCoworkStatus();
  if (!status) return null;
  return <StatusDot status={status} className={cn("pointer-events-none absolute top-0.5 right-0.5 ring-2", className)} />;
}
