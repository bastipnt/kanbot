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
