import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => Bun.randomUUIDv7());
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
/**
 * Fractional-index position. The migration declares these columns `COLLATE "C"` so that
 * ORDER BY sorts bytewise, which is what fractional-indexing keys require.
 */
const position = () => text("position").notNull();

export const roleEnum = pgEnum("workspace_role", ["owner", "admin", "member"]);
export const actorTypeEnum = pgEnum("actor_type", ["user", "agent"]);

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email_lower_idx").on(sql`lower(${t.email})`)],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("refresh_tokens_hash_idx").on(t.tokenHash), index("refresh_tokens_user_idx").on(t.userId)],
);

export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text("name").notNull(),
  /** Last allocated event seq. Row is locked FOR UPDATE by every mutating transaction. */
  eventSeq: bigint("event_seq", { mode: "number" }).notNull().default(0),
  createdAt: createdAt(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    joinedAt: ts("joined_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index("workspace_members_user_idx").on(t.userId)],
);

export const invites = pgTable(
  "invites",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    role: roleEnum("role").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: ts("accepted_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invites_token_hash_idx").on(t.tokenHash)],
);

/** Server-wide single-use invites to create an account while registration is disabled (created via CLI). */
export const signupInvites = pgTable(
  "signup_invites",
  {
    id: id(),
    tokenHash: text("token_hash").notNull(),
    /** When set, only this (normalized) email may register with the invite. */
    email: text("email"),
    expiresAt: ts("expires_at").notNull(),
    usedBy: uuid("used_by").references(() => users.id, { onDelete: "set null" }),
    usedAt: ts("used_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("signup_invites_token_hash_idx").on(t.tokenHash)],
);

export const boards = pgTable(
  "boards",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("boards_workspace_idx").on(t.workspaceId)],
);

export const columns = pgTable(
  "columns",
  {
    id: id(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: position(),
    wipLimit: integer("wip_limit"),
    createdAt: createdAt(),
  },
  (t) => [index("columns_board_idx").on(t.boardId, t.position)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    columnId: uuid("column_id")
      .notNull()
      .references(() => columns.id),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    position: position(),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
    dueAt: ts("due_at"),
    createdByType: actorTypeEnum("created_by_type").notNull(),
    createdById: uuid("created_by_id").notNull(),
    createdByName: text("created_by_name").notNull(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("tasks_column_idx").on(t.columnId, t.position), index("tasks_board_idx").on(t.boardId)],
);

export const comments = pgTable(
  "comments",
  {
    id: id(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: uuid("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("comments_task_idx").on(t.taskId)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    lastUsedAt: ts("last_used_at"),
  },
  (t) => [uniqueIndex("api_keys_hash_idx").on(t.keyHash), index("api_keys_workspace_idx").on(t.workspaceId)],
);

export const events = pgTable(
  "events",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: uuid("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    type: text("type").notNull(),
    entityId: uuid("entity_id").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("events_workspace_seq_idx").on(t.workspaceId, t.seq)],
);

export type UserRow = typeof users.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type BoardRow = typeof boards.$inferSelect;
export type ColumnRow = typeof columns.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type Role = (typeof roleEnum.enumValues)[number];
