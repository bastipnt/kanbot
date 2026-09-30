import { Hono } from "hono";
import { z } from "zod";
import { principal, validate, type AppEnv } from "../lib/http.ts";
import * as s from "../lib/schemas.ts";
import * as boards from "../services/boards.ts";
import * as columns from "../services/columns.ts";
import * as tasks from "../services/tasks.ts";

const placement = { beforeId: s.uuid.nullish(), afterId: s.uuid.nullish() };
const nn = <T>(v: T | null | undefined) => v ?? undefined;

export const boardRoutes = new Hono<AppEnv>()

  // Boards
  .get("/workspaces/:id/boards", async (c) => c.json(await boards.listBoards(principal(c), c.req.param("id"))))
  .post("/workspaces/:id/boards", validate("json", z.object({ name: s.name })), async (c) =>
    c.json(await boards.createBoard(principal(c), c.req.param("id"), c.req.valid("json").name)),
  )
  .get("/boards/:id", async (c) => c.json(await boards.getBoard(principal(c), c.req.param("id"))))
  .patch("/boards/:id", validate("json", z.object({ name: s.name })), async (c) =>
    c.json(await boards.updateBoard(principal(c), c.req.param("id"), c.req.valid("json"))),
  )
  .delete("/boards/:id", async (c) => {
    await boards.deleteBoard(principal(c), c.req.param("id"));
    return c.body(null, 204);
  })

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
  .get("/tasks/:id", async (c) => c.json(await tasks.getTask(principal(c), c.req.param("id"))))
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
  .post(
    "/tasks/:id/move",
    validate("json", z.object({ columnId: z.string().min(1), ...placement })),
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
