ALTER TABLE "boards" ADD COLUMN "task_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "number" integer;--> statement-breakpoint
-- Backfill oldest first within each board, so an existing board numbers its tasks 1..n in creation order.
WITH numbered AS (
	SELECT "id", row_number() OVER (PARTITION BY "board_id" ORDER BY "created_at", "id") AS n
	FROM "tasks"
)
UPDATE "tasks" SET "number" = numbered.n FROM numbered WHERE "tasks"."id" = numbered."id";--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "number" SET NOT NULL;--> statement-breakpoint
UPDATE "boards" SET "task_seq" = COALESCE((SELECT max("number") FROM "tasks" WHERE "tasks"."board_id" = "boards"."id"), 0);--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_board_number_idx" ON "tasks" USING btree ("board_id","number");
