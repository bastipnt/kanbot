import { and, asc, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { db, type Executor, type Tx } from "../db/index.ts";
import { boards, comments, tasks, users, workspaceMembers, type TaskRow } from "../db/schema.ts";
import { isUuid } from "../lib/crypto.ts";
import { ApiError, badRequest, conflict, notFound } from "../lib/errors.ts";
import { computePosition, type Placement } from "../lib/position.ts";
import { actorOf, type Principal } from "../lib/principal.ts";
import { toComment, toTask, type Comment, type Task } from "../lib/serialize.ts";
import { authorize, loadBoard, loadTask } from "./access.ts";
import { lockedBoard } from "./boards.ts";
import { boardColumns, resolveColumn } from "./columns.ts";
import { mutate } from "./events.ts";

export interface TaskFields {
  title?: string;
  description?: string;
  assigneeId?: string | null;
  labels?: string[];
  /** ISO-8601 timestamp or null to clear. */
  dueAt?: string | null;
}

const cleanLabels = (labels: string[]) => [...new Set(labels.map((l) => l.trim()).filter(Boolean))];

async function assertAssignable(ex: Executor, workspaceId: string, userId: string | null | undefined) {
  if (!userId) return;
  if (!isUuid(userId)) throw badRequest("assigneeId must be a UUID");
  const [m] = await ex
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  if (!m) throw badRequest("assigneeId is not a member of this workspace");
}

async function columnTasks(ex: Executor, columnId: string) {
  return ex
    .select({ id: tasks.id, position: tasks.position })
    .from(tasks)
    .where(eq(tasks.columnId, columnId));
}

async function currentTask(tx: Tx, taskId: string): Promise<TaskRow> {
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw notFound("Task");
  return task;
}

/**
 * Creates a task at the end of the given column. `column` may be a column id or case-insensitive name;
 * when omitted the board's first column is used.
 */
export async function createTask(
  p: Principal,
  boardId: string,
  input: TaskFields & { title: string; column?: string },
): Promise<Task> {
  const board = await loadBoard(p, boardId);
  const actor = actorOf(p);
  return mutate(board.workspaceId, actor, async (tx, emit) => {
    await lockedBoard(tx, boardId);
    const col = input.column ? await resolveColumn(tx, boardId, input.column) : (await boardColumns(tx, boardId))[0];
    if (!col) throw badRequest("Board has no columns");
    await assertAssignable(tx, board.workspaceId, input.assigneeId);
    const position = computePosition(await columnTasks(tx, col.id));
    const [task] = await tx
      .insert(tasks)
      .values({
        boardId,
        columnId: col.id,
        title: input.title.trim(),
        description: input.description ?? "",
        position,
        assigneeId: input.assigneeId ?? null,
        labels: cleanLabels(input.labels ?? []),
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        createdByType: actor.type,
        createdById: actor.id,
        createdByName: actor.name,
      })
      .returning();
    emit({ type: "task.created", entityId: task!.id, payload: toTask(task!) });
    return toTask(task!);
  });
}

export async function getTask(p: Principal, taskId: string): Promise<{ task: Task; comments: Comment[] }> {
  const { task } = await loadTask(p, taskId);
  const rows = await db
    .select()
    .from(comments)
    .where(eq(comments.taskId, taskId))
    .orderBy(asc(comments.createdAt), asc(comments.id));
  return { task: toTask(task), comments: rows.map(toComment) };
}

export async function updateTask(p: Principal, taskId: string, patch: TaskFields): Promise<Task> {
  const { workspaceId } = await loadTask(p, taskId);
  return mutate(workspaceId, actorOf(p), async (tx, emit) => {
    await currentTask(tx, taskId);
    if (patch.assigneeId !== undefined) await assertAssignable(tx, workspaceId, patch.assigneeId);
    const [updated] = await tx
      .update(tasks)
      .set({
        ...(patch.title !== undefined && { title: patch.title.trim() }),
        ...(patch.description !== undefined && { description: patch.description }),
        ...(patch.assigneeId !== undefined && { assigneeId: patch.assigneeId }),
        ...(patch.labels !== undefined && { labels: cleanLabels(patch.labels) }),
        ...(patch.dueAt !== undefined && { dueAt: patch.dueAt ? new Date(patch.dueAt) : null }),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId))
      .returning();
    emit({ type: "task.updated", entityId: taskId, payload: toTask(updated!) });
    return toTask(updated!);
  });
}

/**
 * Move a task to a column (same board) and position. `column` is a column id or case-insensitive name.
 * Without beforeId/afterId the task goes to the end of the target column.
 */
export async function moveTask(p: Principal, taskId: string, input: { column: string } & Placement): Promise<Task> {
  const { workspaceId } = await loadTask(p, taskId);
  return mutate(workspaceId, actorOf(p), async (tx, emit) => {
    const task = await currentTask(tx, taskId);
    const col = await resolveColumn(tx, task.boardId, input.column);
    const position = computePosition(await columnTasks(tx, col.id), input, task.id);
    const [moved] = await tx
      .update(tasks)
      .set({ columnId: col.id, position, updatedAt: new Date() })
      .where(eq(tasks.id, taskId))
      .returning();
    emit({ type: "task.moved", entityId: taskId, payload: toTask(moved!) });
    return toTask(moved!);
  });
}

export async function deleteTask(p: Principal, taskId: string): Promise<void> {
  const { workspaceId } = await loadTask(p, taskId);
  await mutate(workspaceId, actorOf(p), async (tx, emit) => {
    const deleted = await tx.delete(tasks).where(eq(tasks.id, taskId)).returning({ id: tasks.id });
    if (deleted.length === 0) throw notFound("Task");
    emit({ type: "task.deleted", entityId: taskId, payload: { id: taskId } });
  });
}

export async function addComment(p: Principal, taskId: string, body: string): Promise<Comment> {
  const { workspaceId } = await loadTask(p, taskId);
  const actor = actorOf(p);
  return mutate(workspaceId, actor, async (tx, emit) => {
    await currentTask(tx, taskId);
    const [comment] = await tx
      .insert(comments)
      .values({ taskId, body, actorType: actor.type, actorId: actor.id, actorName: actor.name })
      .returning();
    emit({ type: "comment.created", entityId: comment!.id, payload: toComment(comment!) });
    return toComment(comment!);
  });
}

/**
 * Assign a task to a workspace member identified by id, email or (case-insensitive) name.
 * `null` unassigns.
 */
export async function assignTask(p: Principal, taskId: string, assignee: string | null): Promise<Task> {
  if (assignee === null) return updateTask(p, taskId, { assigneeId: null });
  const { workspaceId } = await loadTask(p, taskId);
  const needle = assignee.trim().toLowerCase();
  const matches = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        or(
          ...(isUuid(needle) ? [eq(users.id, needle)] : []),
          eq(sql`lower(${users.email})`, needle),
          eq(sql`lower(${users.name})`, needle),
        ),
      ),
    );
  if (matches.length === 0) throw new ApiError("not_found", `No workspace member matches "${assignee}"`);
  if (matches.length > 1) {
    throw conflict(`"${assignee}" matches several members (${matches.map((m) => m.email).join(", ")}); use an email`);
  }
  return updateTask(p, taskId, { assigneeId: matches[0]!.id });
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Case-insensitive search over title, description and exact label match. Most recently updated first. */
export async function searchTasks(
  p: Principal,
  workspaceId: string,
  q: string,
  opts: { boardId?: string; limit?: number } = {},
): Promise<Task[]> {
  await authorize(p, workspaceId);
  const conds: SQL[] = [eq(boards.workspaceId, workspaceId)];
  if (opts.boardId) {
    if (!isUuid(opts.boardId)) throw notFound("Board");
    conds.push(eq(tasks.boardId, opts.boardId));
  }
  const term = q.trim();
  if (term) {
    const pattern = `%${escapeLike(term)}%`;
    conds.push(
      or(
        ilike(tasks.title, pattern),
        ilike(tasks.description, pattern),
        sql`lower(${term}) = ANY (SELECT lower(l) FROM unnest(${tasks.labels}) AS l)`,
      )!,
    );
  }
  const rows = await db
    .select({ task: tasks })
    .from(tasks)
    .innerJoin(boards, eq(boards.id, tasks.boardId))
    .where(and(...conds))
    .orderBy(desc(tasks.updatedAt))
    .limit(Math.min(opts.limit ?? 100, 500));
  return rows.map((r) => toTask(r.task));
}
