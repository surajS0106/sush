// What an account may do with shared sessions: the seat and plan hooks.
// There is no billing here, only the points where a plan is checked:
// starting a share (how long it lasts), making an invite (which role it
// gives), joining and admitting (how many guests), and, on the host, who may
// drive (the host reads these limits from `GET /api/shares/limits`).
//
// Plans are off unless SUSH_PLANS=on: then everyone gets "team", which is
// what the relay always allowed. With plans on, accounts whose email is in
// SUSH_TEAM_EMAILS (comma separated) get "team" and everyone else "free".

import { MAX_GUESTS } from "./db";

export type GuestRole = "viewer" | "collaborator" | "driver";

export interface Plan {
  name: "free" | "team";
  /** Guests one share admits at most. */
  maxGuests: number;
  /** Roles guests may have. */
  roles: GuestRole[];
  /** How long a share may last. */
  maxTtlHours: number;
  /** Whether shares may be end-to-end encrypted (always: it costs the relay nothing). */
  e2e: boolean;
}

const PLANS: Record<Plan["name"], Plan> = {
  free: { name: "free", maxGuests: 1, roles: ["viewer", "collaborator"], maxTtlHours: 12, e2e: true },
  team: { name: "team", maxGuests: MAX_GUESTS, roles: ["viewer", "collaborator", "driver"], maxTtlHours: 24, e2e: true },
};

const teamEmails = () =>
  new Set(
    (process.env.SUSH_TEAM_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );

/** The plan an account is on. */
export function planFor(user: { email: string }): Plan {
  if (process.env.SUSH_PLANS !== "on") return PLANS.team;
  return teamEmails().has(user.email.toLowerCase()) ? PLANS.team : PLANS.free;
}
