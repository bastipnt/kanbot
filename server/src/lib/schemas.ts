/** Shared zod schemas for request validation (REST) and tool inputs (MCP). */
import { z } from "zod";

export const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a UUID");
export const idParam = z.object({ id: uuid });

export const name = z.string().trim().min(1).max(200);
export const title = z.string().trim().min(1).max(500);
export const description = z.string().max(50_000);
export const labels = z.array(z.string().trim().min(1).max(64)).max(50);
export const dueAt = z.iso.datetime({ offset: true }).nullable();
export const wipLimit = z.number().int().min(0).max(10_000).nullable();
export const email = z.email().max(320);
export const password = z.string().min(8).max(256);
export const commentBody = z.string().trim().min(1).max(20_000);

const timestamp = z.iso.datetime({ offset: true });
const actor = z.object({ type: z.enum(["user", "agent"]), id: z.string(), name: z.string().max(200) });

/** Portable board file (docs/api.md `BoardExport`). Array order is board order; ids are not carried over. */
export const boardExport = z.object({
  format: z.literal("kanbot.board"),
  version: z.literal(1),
  exportedAt: timestamp.optional(),
  board: z.object({ name }),
  columns: z
    .array(
      z.object({
        name,
        wipLimit: wipLimit.optional(),
        tasks: z
          .array(
            z.object({
              title,
              description: description.optional(),
              labels: labels.optional(),
              dueAt: dueAt.optional(),
              assignee: z.object({ name: z.string(), email: z.string() }).nullish(),
              createdBy: actor.optional(),
              createdAt: timestamp.optional(),
              comments: z
                .array(z.object({ body: commentBody, actor: actor.optional(), createdAt: timestamp.optional() }))
                .max(1_000)
                .optional(),
            }),
          )
          .max(10_000)
          .optional(),
      }),
    )
    .max(200),
});
export type BoardExport = z.infer<typeof boardExport>;
