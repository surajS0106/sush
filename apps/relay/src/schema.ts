// The relay's D1 tables, from which drizzle-kit generates `migrations/`
// (`bun run db:generate` after a change). The same tables as the Bun relay's
// SQLite: better-auth's (user, session, account, verification) and the shares
// (`apps/server/src/share/db.ts`, `metrics.ts`). Queries are written against
// D1 directly (`db.ts`, `routes.ts`, `room.ts`); this only defines the shape.

import { customType, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** better-auth's own column type for times, as its migrations write it on the Bun relay. */
const date = customType<{ data: Date; driverData: string }>({ dataType: () => "date" });

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified").notNull(),
  image: text("image"),
  createdAt: date("createdAt").notNull(),
  updatedAt: date("updatedAt").notNull(),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: date("expiresAt").notNull(),
    token: text("token").notNull().unique(),
    createdAt: date("createdAt").notNull(),
    updatedAt: date("updatedAt").notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: date("accessTokenExpiresAt"),
    refreshTokenExpiresAt: date("refreshTokenExpiresAt"),
    scope: text("scope"),
    password: text("password"),
    createdAt: date("createdAt").notNull(),
    updatedAt: date("updatedAt").notNull(),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: date("expiresAt").notNull(),
    createdAt: date("createdAt").notNull(),
    updatedAt: date("updatedAt").notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const share = sqliteTable("share", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  title: text("title").notNull(),
  created_at: integer("created_at").notNull(),
  expires_at: integer("expires_at").notNull(),
  ended_at: integer("ended_at"),
  metrics: integer("metrics").notNull().default(0),
  metrics_done: integer("metrics_done").notNull().default(0),
  e2e: integer("e2e").notNull().default(0),
});

export const shareInvite = sqliteTable("share_invite", {
  id: text("id").primaryKey(),
  share_id: text("share_id")
    .notNull()
    .references(() => share.id, { onDelete: "cascade" }),
  token_hash: text("token_hash").notNull().unique(),
  role_cap: text("role_cap").notNull(),
  created_at: integer("created_at").notNull(),
  expires_at: integer("expires_at").notNull(),
  max_uses: integer("max_uses").notNull(),
  uses: integer("uses").notNull().default(0),
  revoked_at: integer("revoked_at"),
});

export const shareMember = sqliteTable(
  "share_member",
  {
    share_id: text("share_id")
      .notNull()
      .references(() => share.id, { onDelete: "cascade" }),
    user_id: text("user_id").notNull(),
    role_cap: text("role_cap").notNull(),
    joined_at: integer("joined_at").notNull(),
    admitted: integer("admitted").notNull().default(0),
    kicked_at: integer("kicked_at"),
  },
  (t) => [primaryKey({ columns: [t.share_id, t.user_id] })],
);

export const shareMetric = sqliteTable(
  "share_metric",
  {
    week: text("week").notNull(),
    metric: text("metric").notNull(),
    bucket: text("bucket").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.week, t.metric, t.bucket] })],
);
