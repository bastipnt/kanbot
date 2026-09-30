/** Board export/import as a portable `BoardExport` file (docs/api.md "Board export/import"). */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, type Executor } from "../db/index.ts";
import { boards, columns, comments, tasks, users, workspaceMembers } from "../db/schema.ts";
import { badRequest } from "../lib/errors.ts";
import { initialPositions } from "../lib/position.ts";
import { actorOf, type Actor, type Principal } from "../lib/principal.ts";
import type { BoardExport } from "../lib/schemas.ts";
import { toBoard, toColumn, toComment, toTask, type Board } from "../lib/serialize.ts";
import { authorize, loadBoard } from "./access.ts";
import { boardColumns } from "./columns.ts";
import { chunks, INSERT_CHUNK, mutate } from "./events.ts";
import { cleanLabels } from "./tasks.ts";

export const MAX_IMPORT_TASKS = 10_000;

export async function exportBoard(p: Principal, boardId: string): Promise<BoardExport> {
  const board = await loadBoard(p, boardId);
  const [cols, taskRows] = await Promise.all([
    boardColumns(db, board.id),
    db
      .select({ task: tasks, assigneeName: users.name, assigneeEmail: users.email })
      .from(tasks)
      .leftJoin(users, eq(users.id, tasks.assigneeId))
      .where(eq(tasks.boardId, board.id))
      .orderBy(asc(tasks.position), asc(tasks.id)),
  ]);
  const commentRows = await db
    .select({ comment: comments })
    .from(comments)
    .innerJoin(tasks, eq(tasks.id, comments.taskId))
    .where(eq(tasks.boardId, board.id))
    .orderBy(asc(comments.createdAt), asc(comments.id));

  const commentsByTask = Map.groupBy(
    commentRows.map((r) => toComment(r.comment)),
    (c) => c.taskId,
  );
  return {
    format: "kanbot.board",
    version: 1,
    exportedAt: new Date().toISOString(),
    board: { name: board.name },
    columns: cols.map((col) => ({
      name: col.name,
      wipLimit: col.wipLimit,
      tasks: taskRows
        .filter((r) => r.task.columnId === col.id)
        .map(({ task: row, assigneeName, assigneeEmail }) => {
          const t = toTask(row);
          return {
            title: t.title,
            description: t.description,
            labels: t.labels,
            dueAt: t.dueAt,
            assignee: assigneeEmail ? { name: assigneeName!, email: assigneeEmail } : null,
            createdBy: t.createdBy,
            createdAt: t.createdAt,
            comments: (commentsByTask.get(t.id) ?? []).map((c) => ({
              body: c.body,
              actor: c.actor,
              createdAt: c.createdAt,
            })),
          };
        }),
    })),
  };
}

/**
 * Create a new board in `workspaceId` from a `BoardExport`. Everything is written in one transaction and
 * attributed to the importing actor; see docs/api.md for how assignees and comment authors are mapped.
 */
export async function importBoard(p: Principal, workspaceId: string, file: BoardExport): Promise<Board> {
  await authorize(p, workspaceId);
  const taskCount = file.columns.reduce((n, c) => n + (c.tasks?.length ?? 0), 0);
  if (taskCount > MAX_IMPORT_TASKS) throw badRequest(`A board import may contain at most ${MAX_IMPORT_TASKS} tasks`);
  const actor = actorOf(p);

  return mutate(workspaceId, actor, async (tx, emit) => {
    const assignees = await memberIdsByEmail(tx, workspaceId, file);

    const [board] = await tx.insert(boards).values({ workspaceId, name: file.board.name.trim() }).returning();
    emit({ type: "board.created", entityId: board!.id, payload: toBoard(board!) });

    const colPositions = initialPositions(file.columns.length);
    const colRows = file.columns.map((c, i) => ({
      id: Bun.randomUUIDv7(),
      boardId: board!.id,
      name: c.name.trim(),
      position: colPositions[i]!,
      wipLimit: c.wipLimit ?? null,
    }));
    if (colRows.length > 0) {
      for (const col of await tx.insert(columns).values(colRows).returning()) {
        emit({ type: "column.created", entityId: col.id, payload: toColumn(col) });
      }
    }

    const taskRows: (typeof tasks.$inferInsert)[] = [];
    const commentRows: (typeof comments.$inferInsert)[] = [];
    file.columns.forEach((c, ci) => {
      const list = c.tasks ?? [];
      const positions = initialPositions(list.length);
      list.forEach((t, ti) => {
        const id = Bun.randomUUIDv7();
        taskRows.push({
          id,
          boardId: board!.id,
          columnId: colRows[ci]!.id,
          title: t.title.trim(),
          description: t.description ?? "",
          position: positions[ti]!,
          assigneeId: (t.assignee && assignees.get(t.assignee.email.toLowerCase())) ?? null,
          labels: cleanLabels(t.labels ?? []),
          dueAt: t.dueAt ? new Date(t.dueAt) : null,
          createdByType: actor.type,
          createdById: actor.id,
          createdByName: actor.name,
          createdAt: t.createdAt ? new Date(t.createdAt) : undefined,
        });
        for (const cm of t.comments ?? []) {
          commentRows.push({
            taskId: id,
            body: attributedBody(cm.body, cm.actor, actor),
            actorType: actor.type,
            actorId: actor.id,
            actorName: actor.name,
            createdAt: cm.createdAt ? new Date(cm.createdAt) : undefined,
          });
        }
      });
    });

    for (const chunk of chunks(taskRows, INSERT_CHUNK)) {
      for (const task of await tx.insert(tasks).values(chunk).returning()) {
        emit({ type: "task.created", entityId: task.id, payload: toTask(task) });
      }
    }
    for (const chunk of chunks(commentRows, INSERT_CHUNK)) {
      for (const comment of await tx.insert(comments).values(chunk).returning()) {
        emit({ type: "comment.created", entityId: comment.id, payload: toComment(comment) });
      }
    }
    return toBoard(board!);
  });
}

/** Lower-cased email -> user id for workspace members referenced as assignees in the file. */
async function memberIdsByEmail(
  ex: Executor,
  workspaceId: string,
  file: BoardExport,
): Promise<Map<string, string>> {
  const emails = [
    ...new Set(file.columns.flatMap((c) => (c.tasks ?? []).flatMap((t) => (t.assignee ? [t.assignee.email.toLowerCase()] : [])))),
  ];
  if (emails.length === 0) return new Map();
  const rows = await ex
    .select({ id: users.id, email: sql<string>`lower(${users.email})` })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(sql`lower(${users.email})`, emails)));
  return new Map(rows.map((r) => [r.email, r.id]));
}

/** Authorship in a file can't be verified, so a foreign author is kept as text, not as the comment's actor. */
function attributedBody(body: string, original: Pick<Actor, "name"> | undefined, importer: Actor): string {
  if (!original || original.name === importer.name) return body;
  return `*Originally by ${original.name}*\n\n${body}`;
}
