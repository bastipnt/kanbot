import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { boards, columns, tasks } from "../db/schema.ts";

export interface TaskReference {
  id: string;
  /** True when an explicit `#task:<id>` names no task in this workspace. */
  broken: boolean;
  title?: string;
  boardId?: string;
  boardName?: string;
  columnId?: string;
  columnName?: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MAX_REFERENCES = 100;

/**
 * Task ids in markdown: `#task:<id>` (explicit) or a bare UUID. A bare UUID that is no task is dropped, since it
 * may be a user, board or comment id; an unresolved explicit one is reported as broken.
 */
export function extractReferenceIds(texts: string[]): { id: string; explicit: boolean }[] {
  const found = new Map<string, boolean>();
  const re = new RegExp(`(#task:)?\\b(${UUID})\\b`, "gi");
  for (const text of texts) {
    for (const m of text.matchAll(re)) {
      const id = m[2]!.toLowerCase();
      found.set(id, (found.get(id) ?? false) || m[1] !== undefined);
    }
  }
  return [...found].slice(0, MAX_REFERENCES).map(([id, explicit]) => ({ id, explicit }));
}

/** Resolves ids against one workspace; other workspaces' cards look the same as missing ones. */
export async function resolveReferences(
  workspaceId: string,
  texts: string[],
  selfId: string,
): Promise<TaskReference[]> {
  const ids = extractReferenceIds(texts).filter((r) => r.id !== selfId);
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      boardId: boards.id,
      boardName: boards.name,
      columnId: columns.id,
      columnName: columns.name,
    })
    .from(tasks)
    .innerJoin(boards, eq(boards.id, tasks.boardId))
    .innerJoin(columns, eq(columns.id, tasks.columnId))
    .where(and(eq(boards.workspaceId, workspaceId), inArray(tasks.id, ids.map((r) => r.id))));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap(({ id, explicit }): TaskReference[] => {
    const row = byId.get(id);
    if (row) return [{ ...row, broken: false }];
    return explicit ? [{ id, broken: true }] : [];
  });
}
