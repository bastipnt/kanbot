/** Shared zod schemas for request validation (REST) and tool inputs (MCP). */
import { z } from "zod";
import { duplicateColumnNamesMessage } from "./columnNames.ts";

export const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a UUID");
export const idParam = z.object({ id: uuid });
/** A task reference: its id or `KEY-n` handle. Resolution is the service's (docs/api.md "Task handles"). */
export const taskRef = z.string().trim().min(1).max(64);

export const name = z.string().trim().min(1).max(200);
export const title = z.string().trim().min(1).max(500);
export const description = z.string().max(50_000);
export const labels = z.array(z.string().trim().min(1).max(64)).max(50);
/** Labels to add to or remove from a task (at least one). */
export const labelDelta = labels.min(1);
/**
 * Metadata is the string map agents keep on a card (step, branch, base). Keys are lowercase words, so a
 * human never has to read a stamp; a card holds at most 50 entries.
 */
export const metadataKey = z.string().regex(/^[a-z0-9._-]{1,64}$/, "keys are 1-64 of a-z, 0-9, . _ -");
export const metadataSet = z.record(metadataKey, z.string().max(512));
export const metadataUnset = z.array(metadataKey).max(50);
/** A metadata change sets and/or unsets keys; a body with neither is rejected. */
export const metadataPatch = z
  .object({ set: metadataSet.optional(), unset: metadataUnset.optional() })
  .refine((b) => b.set !== undefined || b.unset !== undefined, "set or unset is required");
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
    .max(200)
    // A column name identifies a column on a board, also right after an import.
    .superRefine((cols, ctx) => {
      const message = duplicateColumnNamesMessage(cols.map((c) => c.name));
      if (message) ctx.addIssue({ code: "custom", message });
    }),
});
export type BoardExport = z.infer<typeof boardExport>;
