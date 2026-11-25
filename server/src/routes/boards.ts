import { Hono } from "hono";
import { z } from "zod";
import { badRequest } from "../lib/errors.ts";
import { principal, validate, type AppEnv } from "../lib/http.ts";
import * as s from "../lib/schemas.ts";
import * as boards from "../services/boards.ts";
import * as transfer from "../services/boardTransfer.ts";
import * as columns from "../services/columns.ts";
import * as tasks from "../services/tasks.ts";

const placement = { beforeId: s.uuid.nullish(), afterId: s.uuid.nullish() };
/** Task placement takes task references (ids or handles); column placement stays with column ids. */
const taskPlacement = { beforeId: s.taskRef.nullish(), afterId: s.taskRef.nullish() };
const nn = <T>(v: T | null | undefined) => v ?? undefined;

/** `Content-Disposition` with an ASCII fallback and the exact UTF-8 name (RFC 6266). */
const attachment = (filename: string) =>
  `attachment; filename="${filename.replace(/[^\x20-\x7e]|["\\/]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`;

export const boardRoutes = new Hono<AppEnv>()

  // Boards
  .get("/workspaces/:id/boards", async (c) => c.json(await boards.listBoards(principal(c), c.req.param("id"))))
  .post("/workspaces/:id/boards", validate("json", z.object({ name: s.name })), async (c) =>
    c.json(await boards.createBoard(principal(c), c.req.param("id"), c.req.valid("json").name)),
  )
  .get("/boards/:id", async (c) => c.json(await boards.getBoard(principal(c), c.req.param("id"))))
  .get("/boards/:id/columns", async (c) => c.json(await columns.boardSummary(principal(c), c.req.param("id"))))
  .get(
    "/boards/:id/columns/:column/tasks",
    validate(
      "query",
      z.object({ limit: z.coerce.number().int().min(1).max(500).default(50), cursor: z.string().max(500).optional() }),
    ),
    async (c) =>
      c.json(await columns.listColumnTasks(principal(c), c.req.param("id"), c.req.param("column"), c.req.valid("query"))),
  )
  .patch("/boards/:id", validate("json", z.object({ name: s.name })), async (c) =>
    c.json(await boards.updateBoard(principal(c), c.req.param("id"), c.req.valid("json"))),
  )
  .delete("/boards/:id", async (c) => {
    await boards.deleteBoard(principal(c), c.req.param("id"));
    return c.body(null, 204);
  })
  .get("/boards/:id/export", async (c) => {
    const file = await transfer.exportBoard(principal(c), c.req.param("id"));
    c.header("Content-Disposition", attachment(`${file.board.name}.json`));
    return c.json(file);
  })
  .post("/workspaces/:id/boards/import", validate("json", s.boardExport), async (c) =>
    c.json(await transfer.importBoard(principal(c), c.req.param("id"), c.req.valid("json"))),
  )

  // Columns
  .post(
    "/boards/:id/columns",
    validate("json", z.object({ name: s.name, afterId: s.uuid.nullish(), wipLimit: s.wipLimit.optional() })),
    async (c) => {
      const { afterId, ...rest } = c.req.valid("json");
      return c.json(await columns.createColumn(principal(c), c.req.param("id"), { ...rest, after: afterId }));
    },
  )
  .patch(
    "/columns/:id",
    validate("json", z.object({ name: s.name.optional(), wipLimit: s.wipLimit.optional(), ...placement })),
    async (c) => {
      const b = c.req.valid("json");
      return c.json(
        await columns.updateColumn(principal(c), c.req.param("id"), {
          name: b.name,
          wipLimit: b.wipLimit,
          beforeId: nn(b.beforeId),
          afterId: nn(b.afterId),
        }),
      );
    },
  )
  .delete("/columns/:id", async (c) => {
    await columns.deleteColumn(principal(c), c.req.param("id"));
    return c.body(null, 204);
  })

  // Tasks
  .post(
    "/boards/:id/tasks",
    validate(
      "json",
      z.object({
        title: s.title,
        columnId: z.string().min(1),
        description: s.description.optional(),
        assigneeId: s.uuid.nullish(),
        labels: s.labels.optional(),
        dueAt: s.dueAt.optional(),
      }),
    ),
    async (c) => {
      const { columnId, ...rest } = c.req.valid("json");
      return c.json(await tasks.createTask(principal(c), c.req.param("id"), { ...rest, column: columnId }));
    },
  )
  .get(
    "/tasks/:id",
    validate(
      "query",
      z.object({
        commentLimit: z.coerce.number().int().min(1).max(500).optional(),
        commentsBefore: s.uuid.optional(),
        description: z.enum(["true", "false"]).optional(),
      }),
    ),
    async (c) => {
      const q = c.req.valid("query");
      if (q.commentsBefore && !q.commentLimit) throw badRequest("commentsBefore needs commentLimit");
      return c.json(
        await tasks.getTask(principal(c), c.req.param("id"), {
          comments: q.commentLimit ? { limit: q.commentLimit, before: q.commentsBefore } : undefined,
          includeDescription: q.description !== "false",
        }),
      );
    },
  )
  .patch(
    "/tasks/:id",
    validate(
      "json",
      z.object({
        title: s.title.optional(),
        description: s.description.optional(),
        assigneeId: s.uuid.nullable().optional(),
        labels: s.labels.optional(),
        dueAt: s.dueAt.optional(),
      }),
    ),
    async (c) => c.json(await tasks.updateTask(principal(c), c.req.param("id"), c.req.valid("json"))),
  )
  .post("/tasks/:id/labels/add", validate("json", z.object({ labels: s.labelDelta })), async (c) =>
    c.json(await tasks.changeLabels(principal(c), c.req.param("id"), "add", c.req.valid("json").labels)),
  )
  .post("/tasks/:id/labels/remove", validate("json", z.object({ labels: s.labelDelta })), async (c) =>
    c.json(await tasks.changeLabels(principal(c), c.req.param("id"), "remove", c.req.valid("json").labels)),
  )
  .post(
    "/tasks/:id/move",
    validate("json", z.object({ columnId: z.string().min(1), ...taskPlacement })),
    async (c) => {
      const b = c.req.valid("json");
      return c.json(
        await tasks.moveTask(principal(c), c.req.param("id"), {
          column: b.columnId,
          beforeId: nn(b.beforeId),
          afterId: nn(b.afterId),
        }),
      );
    },
  )
  .delete("/tasks/:id", async (c) => {
    await tasks.deleteTask(principal(c), c.req.param("id"));
    return c.body(null, 204);
  })
  .post("/tasks/:id/comments", validate("json", z.object({ body: s.commentBody })), async (c) =>
    c.json(await tasks.addComment(principal(c), c.req.param("id"), c.req.valid("json").body)),
  );
