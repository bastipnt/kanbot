/** Row -> API contract shapes (docs/api.md "Models"). */
import type {
  ApiKeyRow,
  BoardRow,
  ColumnRow,
  CommentRow,
  EventRow,
  Role,
  TaskRow,
  UserRow,
  WorkspaceRow,
} from "../db/schema.ts";
import type { Actor } from "./principal.ts";

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export const toUser = (u: UserRow) => ({ id: u.id, email: u.email, name: u.name, createdAt: iso(u.createdAt) });
export type User = ReturnType<typeof toUser>;

export const toWorkspace = (w: WorkspaceRow, role: Role) => ({
  id: w.id,
  name: w.name,
  role,
  createdAt: iso(w.createdAt),
});
export type Workspace = ReturnType<typeof toWorkspace>;

export const toMember = (m: { userId: string; name: string; email: string; role: Role; joinedAt: Date }) => ({
  userId: m.userId,
  name: m.name,
  email: m.email,
  role: m.role,
  joinedAt: iso(m.joinedAt),
});
export type Member = ReturnType<typeof toMember>;

export const toBoard = (b: BoardRow) => ({
  id: b.id,
  workspaceId: b.workspaceId,
  name: b.name,
  createdAt: iso(b.createdAt),
  updatedAt: iso(b.updatedAt),
});
export type Board = ReturnType<typeof toBoard>;

export const toColumn = (c: ColumnRow) => ({
  id: c.id,
  boardId: c.boardId,
  name: c.name,
  position: c.position,
  wipLimit: c.wipLimit,
});
export type Column = ReturnType<typeof toColumn>;

export const toTask = (t: TaskRow) => ({
  id: t.id,
  boardId: t.boardId,
  columnId: t.columnId,
  title: t.title,
  description: t.description,
  position: t.position,
  assigneeId: t.assigneeId,
  labels: t.labels,
  dueAt: isoOrNull(t.dueAt),
  createdBy: { type: t.createdByType, id: t.createdById, name: t.createdByName } satisfies Actor,
  createdAt: iso(t.createdAt),
  updatedAt: iso(t.updatedAt),
});
export type Task = ReturnType<typeof toTask>;

export const toComment = (c: CommentRow) => ({
  id: c.id,
  taskId: c.taskId,
  body: c.body,
  actor: { type: c.actorType, id: c.actorId, name: c.actorName } satisfies Actor,
  createdAt: iso(c.createdAt),
});
export type Comment = ReturnType<typeof toComment>;

export const toApiKey = (k: ApiKeyRow) => ({
  id: k.id,
  workspaceId: k.workspaceId,
  name: k.name,
  prefix: k.prefix,
  createdAt: iso(k.createdAt),
  lastUsedAt: isoOrNull(k.lastUsedAt),
});
export type ApiKey = ReturnType<typeof toApiKey>;

export const toEvent = (e: EventRow) => ({
  seq: e.seq,
  workspaceId: e.workspaceId,
  actor: { type: e.actorType, id: e.actorId, name: e.actorName } satisfies Actor,
  type: e.type,
  entityId: e.entityId,
  payload: e.payload,
  createdAt: iso(e.createdAt),
});
export type Event = ReturnType<typeof toEvent>;
