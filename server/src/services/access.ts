/** Permission checks and permission-checked entity loaders shared by all services. */
import { and, eq } from "drizzle-orm";
import { db, type Executor } from "../db/index.ts";
import {
  boards,
  columns,
  tasks,
  workspaceMembers,
  workspaces,
  type BoardRow,
  type ColumnRow,
  type Role,
  type TaskRow,
} from "../db/schema.ts";
import { isUuid } from "../lib/crypto.ts";
import { forbidden, notFound } from "../lib/errors.ts";
import type { Principal } from "../lib/principal.ts";

const rank: Record<Role, number> = { member: 0, admin: 1, owner: 2 };
export const roleAtLeast = (role: Role, min: Role) => rank[role] >= rank[min];

/**
 * Ensure `p` may act in `workspaceId` with at least `minRole`. Returns the effective role.
 * Users must be members; API keys are confined to their own workspace and act as `member`
 * (admin-only operations are not available to agents).
 */
export async function authorize(p: Principal, workspaceId: string, minRole: Role = "member", ex: Executor = db): Promise<Role> {
  if (!isUuid(workspaceId)) throw notFound("Workspace");
  if (p.kind === "agent") {
    if (p.apiKey.workspaceId !== workspaceId) throw forbidden("API key is not valid for this workspace");
    if (minRole !== "member") throw forbidden("This action requires a user with the admin role");
    return "member";
  }
  const [row] = await ex
    .select({ id: workspaces.id, role: workspaceMembers.role })
    .from(workspaces)
    .leftJoin(
      workspaceMembers,
      and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, p.user.id)),
    )
    .where(eq(workspaces.id, workspaceId));
  if (!row) throw notFound("Workspace");
  if (!row.role) throw forbidden("You are not a member of this workspace");
  if (!roleAtLeast(row.role, minRole)) throw forbidden(`This action requires the ${minRole} role`);
  return row.role;
}

/** Destructive operations (deleting tasks/columns/boards) are reserved for user accounts. */
export function requireUser(p: Principal): void {
  if (p.kind !== "user") throw forbidden("This action requires a user account");
}

export async function loadBoard(p: Principal, boardId: string, ex: Executor = db): Promise<BoardRow> {
  if (!isUuid(boardId)) throw notFound("Board");
  const [board] = await ex.select().from(boards).where(eq(boards.id, boardId));
  if (!board) throw notFound("Board");
  await authorize(p, board.workspaceId, "member", ex);
  return board;
}

export async function loadColumn(
  p: Principal,
  columnId: string,
  ex: Executor = db,
): Promise<{ column: ColumnRow; workspaceId: string }> {
  if (!isUuid(columnId)) throw notFound("Column");
  const [row] = await ex
    .select({ column: columns, workspaceId: boards.workspaceId })
    .from(columns)
    .innerJoin(boards, eq(boards.id, columns.boardId))
    .where(eq(columns.id, columnId));
  if (!row) throw notFound("Column");
  await authorize(p, row.workspaceId, "member", ex);
  return row;
}

export async function loadTask(
  p: Principal,
  taskId: string,
  ex: Executor = db,
): Promise<{ task: TaskRow; workspaceId: string }> {
  if (!isUuid(taskId)) throw notFound("Task");
  const [row] = await ex
    .select({ task: tasks, workspaceId: boards.workspaceId })
    .from(tasks)
    .innerJoin(boards, eq(boards.id, tasks.boardId))
    .where(eq(tasks.id, taskId));
  if (!row) throw notFound("Task");
  await authorize(p, row.workspaceId, "member", ex);
  return row;
}
