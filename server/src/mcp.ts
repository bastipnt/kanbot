/**
 * MCP endpoint (`POST /mcp`, Streamable HTTP, stateless). Authenticated with an agent API key
 * (`Authorization: Bearer kb_...`); every tool acts in that key's workspace as Actor{type:"agent"}.
 * Tools are thin wrappers over `services/*` — no domain logic lives here.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { columnNameKey } from "./lib/columnNames.ts";
import { ApiError, errorBody } from "./lib/errors.ts";
import { bearerToken } from "./lib/http.ts";
import type { Principal } from "./lib/principal.ts";
import * as s from "./lib/schemas.ts";
import type { Task } from "./lib/serialize.ts";
import { authenticate } from "./services/auth.ts";
import * as boards from "./services/boards.ts";
import * as transfer from "./services/boardTransfer.ts";
import * as columns from "./services/columns.ts";
import * as tasks from "./services/tasks.ts";
import * as workspaces from "./services/workspaces.ts";

type AgentPrincipal = Extract<Principal, { kind: "agent" }>;

const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** Run a tool body; domain errors become tool errors (isError) with the contract's error JSON. */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await fn());
  } catch (err) {
    if (err instanceof ApiError) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify(errorBody(err.code, err.message)) }] };
    }
    throw err;
  }
}

/** Compact task shape for tool output. */
const brief = (t: Task) => ({
  id: t.id,
  handle: t.handle,
  title: t.title,
  columnId: t.columnId,
  assigneeId: t.assigneeId,
  labels: t.labels,
  metadata: t.metadata,
  dueAt: t.dueAt,
});

const boardRef = z
  .string()
  .min(1)
  .describe('Board id or case-insensitive board name. Call list_boards to see available boards.');

export function buildMcpServer(p: AgentPrincipal): McpServer {
  const workspaceId = p.apiKey.workspaceId;
  const server = new McpServer(
    { name: "kanbot", version: "1.0.0" },
    {
      instructions:
        "Kanbot is a kanban board. You act as an agent in one workspace. Typical flow: list_boards -> get_board " +
        "(columns with task counts) -> list_tasks (one column) -> act with create_task / move_task / update_task / " +
        "assign_task / add_comment. create_board makes a new board (default columns unless you pass names). " +
        "Columns can be referenced by id or by case-insensitive name, e.g. 'Ready for Dev'. " +
        "A taskId may also be the card's handle as shown by get_task, e.g. KAN-142.",
    },
  );

  server.registerTool(
    "list_boards",
    {
      title: "List boards",
      description: "List all boards in the workspace this API key belongs to.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run(async () => (await boards.listBoards(p, workspaceId)).map((b) => ({ id: b.id, name: b.name }))),
  );

  server.registerTool(
    "get_board",
    {
      title: "Get board",
      description:
        "Get a board with its columns in order (id, name, wipLimit, taskCount) but no tasks. Use list_tasks to read " +
        "one column's tasks. Pass includeTasks=true for every column's tasks too (large boards: avoid). " +
        "Task descriptions are omitted; use get_task for full details and comments.",
      inputSchema: {
        board: boardRef.optional().describe("Board id or name. Optional if the workspace has one board."),
        includeTasks: z.boolean().optional().describe("Also return the tasks of every column (default false)."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ board, includeTasks }) =>
      run(async () => {
        const b = await boards.findBoard(p, workspaceId, board);
        if (!includeTasks) {
          const sum = await columns.boardSummary(p, b.id);
          return {
            board: { id: b.id, name: b.name },
            columns: sum.columns.map((c) => ({ id: c.id, name: c.name, wipLimit: c.wipLimit, taskCount: c.taskCount })),
          };
        }
        const snap = await boards.getBoard(p, b.id);
        return {
          board: { id: b.id, name: b.name },
          columns: snap.columns.map((c) => {
            const colTasks = snap.tasks.filter((t) => t.columnId === c.id);
            return { id: c.id, name: c.name, wipLimit: c.wipLimit, taskCount: colTasks.length, tasks: colTasks.map(brief) };
          }),
        };
      }),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks in a column",
      description:
        "List the tasks of one column in board order, paged. If nextCursor is not null, call again with it as " +
        "cursor to get the next page. Task descriptions are omitted; use get_task for details.",
      inputSchema: {
        board: boardRef.optional().describe("Board id or name. Optional if the workspace has one board."),
        column: z.string().min(1).describe('Column id or case-insensitive name, e.g. "Review".'),
        limit: z.number().int().min(1).max(500).optional().describe("Tasks per page (default 50)."),
        cursor: z.string().min(1).optional().describe("nextCursor from the previous page."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ board, column, limit, cursor }) =>
      run(async () => {
        const b = await boards.findBoard(p, workspaceId, board);
        const page = await columns.listColumnTasks(p, b.id, column, { limit: limit ?? 50, cursor });
        return {
          column: { id: page.column.id, name: page.column.name, wipLimit: page.column.wipLimit },
          tasks: page.tasks.map(brief),
          nextCursor: page.nextCursor,
        };
      }),
  );

  server.registerTool(
    "search_tasks",
    {
      title: "Search tasks",
      description:
        "Search tasks across the workspace by text (case-insensitive match on title/description, or exact label). " +
        "Returns most recently updated first.",
      inputSchema: {
        query: z.string().max(500).describe("Text to search for. Empty string lists recent tasks."),
        board: boardRef.optional().describe("Restrict to this board (id or name)."),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum results (default 25)."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, board, limit }) =>
      run(async () => {
        const boardId = board ? (await boards.findBoard(p, workspaceId, board)).id : undefined;
        return (await tasks.searchTasks(p, workspaceId, query, { boardId, limit: limit ?? 25 })).map((t) => ({
          ...brief(t),
          boardId: t.boardId,
        }));
      }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description:
        "Get a task's details (markdown description) and comments, plus commentCount. By default all comments, " +
        "oldest first. With comments {limit, before?} only the newest `limit` comments come back, newest first " +
        "(limit 1 = the latest comment); if commentsNextCursor is not null, pass it as comments.before for older ones. " +
        "includeDescription false leaves the description out. references lists the cards named in the description and " +
        "comments by #task:<id> or bare id (title, board, column; broken: true if a #task:<id> matches no card).",
      inputSchema: {
        taskId: s.taskRef.describe("Task id or handle, e.g. KAN-142."),
        comments: z
          .object({
            limit: z.number().int().min(1).max(500).describe("Newest comments to return."),
            before: s.uuid.optional().describe("commentsNextCursor from the previous page."),
          })
          .optional(),
        includeDescription: z.boolean().optional().describe("false omits the description (default true)."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ taskId, comments, includeDescription }) => run(() => tasks.getTask(p, taskId, { comments, includeDescription })),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description: "Create a task at the bottom of a column. Defaults to the board's first column (usually Backlog).",
      inputSchema: {
        board: boardRef.optional().describe("Board id or name. Optional if the workspace has one board."),
        title: s.title.describe("Short task title."),
        column: z.string().min(1).optional().describe('Column id or case-insensitive name, e.g. "Ready for Dev".'),
        description: s.description.optional().describe("Markdown description."),
        labels: s.labels.optional().describe("Labels, e.g. [\"bug\", \"frontend\"]."),
        dueAt: s.dueAt.optional().describe("Due date as ISO-8601 timestamp, e.g. 2026-10-01T12:00:00Z."),
      },
    },
    ({ board, ...input }) =>
      run(async () => {
        const b = await boards.findBoard(p, workspaceId, board);
        return tasks.createTask(p, b.id, input);
      }),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description: "Update a task's title, description, labels and/or due date. Only provided fields change.",
      inputSchema: {
        taskId: s.taskRef.describe("Task id or handle, e.g. KAN-142."),
        title: s.title.optional(),
        description: s.description.optional().describe("Markdown description (replaces the existing one)."),
        labels: s.labels.optional().describe("Complete new label list (replaces existing labels). To change single labels use add_labels / remove_labels."),
        dueAt: s.dueAt.optional().describe("ISO-8601 due date, or null to clear."),
      },
      annotations: { idempotentHint: true },
    },
    ({ taskId, ...patch }) => run(() => tasks.updateTask(p, taskId, patch)),
  );

  server.registerTool(
    "add_labels",
    {
      title: "Add labels",
      description:
        "Add labels to a task without reading it first. Other labels are untouched and labels already present are " +
        "skipped, so concurrent edits are safe. Prefer this over update_task to add a label.",
      inputSchema: { taskId: s.taskRef.describe("Task id or handle, e.g. KAN-142."), labels: s.labelDelta.describe("Labels to add.") },
      annotations: { idempotentHint: true },
    },
    ({ taskId, labels }) => run(() => tasks.changeLabels(p, taskId, "add", labels)),
  );

  server.registerTool(
    "remove_labels",
    {
      title: "Remove labels",
      description:
        "Remove labels from a task without reading it first. Other labels are untouched and labels the task does " +
        "not have are ignored, so concurrent edits are safe.",
      inputSchema: { taskId: s.taskRef.describe("Task id or handle, e.g. KAN-142."), labels: s.labelDelta.describe("Labels to remove.") },
      annotations: { idempotentHint: true },
    },
    ({ taskId, labels }) => run(() => tasks.changeLabels(p, taskId, "remove", labels)),
  );

  server.registerTool(
    "set_task_metadata",
    {
      title: "Set task metadata",
      description:
        "Set and/or unset keys of a task's metadata map (workflow state such as step, branch or base) without " +
        "reading the card first. Other keys are untouched, so concurrent agents changing different keys are safe. " +
        "Keys are 1-64 characters of a-z, 0-9, '.', '_' and '-'; values are at most 512 characters; a task holds " +
        "at most 50 entries. To clear a key list it in unset.",
      inputSchema: {
        taskId: s.taskRef.describe("Task id or handle, e.g. KAN-142."),
        set: s.metadataSet.optional().describe('Keys to set, e.g. {"step": "review", "branch": "agent/x"}.'),
        unset: s.metadataUnset.optional().describe("Keys to remove."),
      },
      annotations: { idempotentHint: true },
    },
    ({ taskId, set, unset }) => run(() => tasks.changeMetadata(p, taskId, { set, unset })),
  );

  server.registerTool(
    "move_task",
    {
      title: "Move task",
      description:
        'Move a task to a column on its board, e.g. column "Ready for Dev". By default the task goes to the bottom ' +
        "of the column; pass beforeTaskId/afterTaskId to place it relative to another task in that column.",
      inputSchema: {
        taskId: s.taskRef.describe("Task id or handle, e.g. KAN-142."),
        column: z.string().min(1).describe('Target column id or case-insensitive name, e.g. "Ready for Dev".'),
        beforeTaskId: s.taskRef.optional().describe("Place directly above this task in the target column (id or handle)."),
        afterTaskId: s.taskRef.optional().describe("Place directly below this task in the target column (id or handle)."),
      },
    },
    ({ taskId, column, beforeTaskId, afterTaskId }) =>
      run(() => tasks.moveTask(p, taskId, { column, beforeId: beforeTaskId, afterId: afterTaskId })),
  );

  server.registerTool(
    "assign_task",
    {
      title: "Assign task",
      description: "Assign a task to a workspace member by email or name (case-insensitive), or unassign with null.",
      inputSchema: {
        taskId: s.taskRef.describe("Task id or handle, e.g. KAN-142."),
        assignee: z
          .string()
          .min(1)
          .nullable()
          .describe("Member email or name; null to unassign. Use list_members to see members."),
      },
      annotations: { idempotentHint: true },
    },
    ({ taskId, assignee }) => run(() => tasks.assignTask(p, taskId, assignee)),
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add comment",
      description: "Add a markdown comment to a task (e.g. a progress note or question).",
      inputSchema: { taskId: s.taskRef.describe("Task id or handle, e.g. KAN-142."), body: s.commentBody.describe("Markdown comment body.") },
    },
    ({ taskId, body }) => run(() => tasks.addComment(p, taskId, body)),
  );

  server.registerTool(
    "create_column",
    {
      title: "Create column",
      description: "Add a column to a board. By default it is appended at the right end.",
      inputSchema: {
        board: boardRef,
        name: s.name.describe("Column name."),
        afterColumn: z.string().min(1).optional().describe("Insert after this column (id or name)."),
        wipLimit: z.number().int().min(0).optional().describe("Optional work-in-progress limit."),
      },
    },
    ({ board, name, afterColumn, wipLimit }) =>
      run(async () => {
        const b = await boards.findBoard(p, workspaceId, board);
        return columns.createColumn(p, b.id, { name, after: afterColumn, wipLimit });
      }),
  );

  server.registerTool(
    "reorder_columns",
    {
      title: "Reorder columns",
      description: "Set the left-to-right order of a board's columns. Must list every column exactly once.",
      inputSchema: {
        board: boardRef,
        columns: z.array(z.string().min(1)).min(1).describe("All column ids or names in the desired order."),
      },
      annotations: { idempotentHint: true },
    },
    ({ board, columns: order }) =>
      run(async () => {
        const b = await boards.findBoard(p, workspaceId, board);
        return (await columns.reorderColumns(p, b.id, order)).map((c) => ({ id: c.id, name: c.name }));
      }),
  );

  server.registerTool(
    "list_members",
    {
      title: "List members",
      description: "List workspace members (userId, name, email, role). Use with assign_task.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run(() => workspaces.listMembers(p, workspaceId)),
  );

  server.registerTool(
    "create_board",
    {
      title: "Create board",
      description:
        "Create an empty board. Without `columns` it gets the default columns (Backlog, Ready for Dev, In Progress, " +
        "Review, Done). Returns the board id and its column ids and names in board order.",
      inputSchema: {
        name: s.name.describe("Board name."),
        columns: z
          .array(s.name)
          .min(1)
          .max(50)
          .refine((l) => new Set(l.map(columnNameKey)).size === l.length, "Column names must be unique")
          .optional()
          .describe("Column names, left to right. Omit for the default set."),
      },
    },
    ({ name, columns: names }) =>
      run(async () => {
        const { board, columns: cols } = await boards.createBoardWithColumns(p, workspaceId, name, names);
        return { id: board.id, name: board.name, columns: cols.map((c) => ({ id: c.id, name: c.name })) };
      }),
  );

  server.registerTool(
    "export_board",
    {
      title: "Export board",
      description:
        "Export a board with all columns, tasks and comments as a portable kanbot.board JSON document " +
        "(no ids; array order is board order). Pass it to import_board to copy the board.",
      inputSchema: { board: boardRef.optional().describe("Board id or name. Optional if the workspace has one board.") },
      annotations: { readOnlyHint: true },
    },
    ({ board }) =>
      run(async () => {
        const b = await boards.findBoard(p, workspaceId, board);
        return transfer.exportBoard(p, b.id);
      }),
  );

  server.registerTool(
    "import_board",
    {
      title: "Import board",
      description:
        "Create a new board from a kanbot.board document (as returned by export_board). Existing boards are never " +
        "changed. Assignees are matched to members by email; tasks and comments are attributed to you.",
      inputSchema: s.boardExport.shape,
    },
    (file) =>
      run(async () => {
        const b = await transfer.importBoard(p, workspaceId, file);
        return { id: b.id, name: b.name };
      }),
  );

  return server;
}

/** Handle one MCP HTTP request statelessly: fresh server + transport per request. */
export async function handleMcpRequest(req: Request): Promise<Response> {
  const token = bearerToken(req.headers.get("Authorization"));
  const principal = token ? await authenticate(token) : null;
  if (!principal || principal.kind !== "agent") {
    return Response.json(errorBody("unauthorized", "MCP requires an agent API key: Authorization: Bearer kb_..."), {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="kanbot"' },
    });
  }
  const server = buildMcpServer(principal);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // With JSON responses the body is fully produced once handleRequest resolves.
    void server.close();
  }
}
