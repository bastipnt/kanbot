import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { api, baseUrl, connectWs, createTask, registerUser, setup } from "./helpers.ts";

async function mcpClient(secret: string) {
  const client = new Client({ name: "kanbot-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl()}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: Boolean(res.isError), data: JSON.parse(res.content[0]!.text) };
}

async function agentSetup() {
  const s = await setup("Owner");
  const key = await api("POST", `/workspaces/${s.ws.id}/api-keys`, { token: s.user.token, body: { name: "Claude" } });
  return { ...s, secret: key.body.secret as string, apiKeyId: key.body.apiKey.id as string };
}

describe("mcp", () => {
  test("rejects requests without an agent API key", async () => {
    const res = await fetch(`${baseUrl()}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.code).toBe("unauthorized");

    const user = await registerUser();
    const res2 = await fetch(`${baseUrl()}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res2.status).toBe(401);
  });

  test("lists all contract tools", async () => {
    const { secret } = await agentSetup();
    const client = await mcpClient(secret);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "list_boards",
        "get_board",
        "search_tasks",
        "get_task",
        "create_task",
        "update_task",
        "move_task",
        "assign_task",
        "add_comment",
        "create_column",
        "reorder_columns",
        "list_members",
      ].sort(),
    );
    for (const t of tools) expect(t.description?.length).toBeGreaterThan(10);
    await client.close();
  });

  test("move_task by column name records an agent event and pushes it over WebSocket", async () => {
    const { user, ws, board, col, secret, apiKeyId } = await agentSetup();
    const task = await createTask(user, board.id, col("Backlog").id, "Implement login");
    const sock = connectWs(user.token, ws.id);
    await sock.opened;
    await sock.next((m) => m.kind === "hello");

    const client = await mcpClient(secret);
    const moved = await call(client, "move_task", { taskId: task.id, column: "ready FOR dev" });
    expect(moved.isError).toBe(false);
    expect(moved.data).toMatchObject({ id: task.id, columnId: col("Ready for Dev").id });

    const events = await api("GET", `/workspaces/${ws.id}/events`, { token: user.token });
    const last = events.body.events.at(-1);
    expect(last).toMatchObject({
      type: "task.moved",
      entityId: task.id,
      actor: { type: "agent", id: apiKeyId, name: "Claude" },
      payload: { columnId: col("Ready for Dev").id },
    });

    const pushed = await sock.next((m) => m.kind === "event" && m.event.type === "task.moved");
    expect(pushed.event.actor).toEqual({ type: "agent", id: apiKeyId, name: "Claude" });
    sock.ws.close();

    const unknown = await call(client, "move_task", { taskId: task.id, column: "Nope" });
    expect(unknown.isError).toBe(true);
    expect(unknown.data.error.code).toBe("not_found");
    expect(unknown.data.error.message).toContain("Ready for Dev");
    await client.close();
  });

  test("tool round trip: boards, tasks, comments, assignment, columns, members", async () => {
    const { user, board, secret } = await agentSetup();
    const client = await mcpClient(secret);

    const boards = await call(client, "list_boards");
    expect(boards.data).toEqual([{ id: board.id, name: "Board" }]);

    const created = await call(client, "create_task", { title: "Agent task", column: "In Progress", labels: ["ai"] });
    expect(created.isError).toBe(false);
    expect(created.data.createdBy.type).toBe("agent");

    const defaultCol = await call(client, "create_task", { board: "board", title: "Goes to backlog" });
    const snap = await call(client, "get_board", { board: board.id });
    const byName = Object.fromEntries(snap.data.columns.map((c: any) => [c.name, c.tasks.map((t: any) => t.title)]));
    expect(byName["In Progress"]).toEqual(["Agent task"]);
    expect(byName["Backlog"]).toEqual(["Goes to backlog"]);
    expect(defaultCol.data.columnId).toBe(snap.data.columns[0].id);

    const updated = await call(client, "update_task", { taskId: created.data.id, description: "Details", dueAt: null });
    expect(updated.data.description).toBe("Details");

    const assigned = await call(client, "assign_task", { taskId: created.data.id, assignee: user.email.toUpperCase() });
    expect(assigned.data.assigneeId).toBe(user.id);
    const byUserName = await call(client, "assign_task", { taskId: created.data.id, assignee: "owner" });
    expect(byUserName.data.assigneeId).toBe(user.id);
    const unassigned = await call(client, "assign_task", { taskId: created.data.id, assignee: null });
    expect(unassigned.data.assigneeId).toBeNull();

    const comment = await call(client, "add_comment", { taskId: created.data.id, body: "Started work" });
    expect(comment.data.actor).toMatchObject({ type: "agent", name: "Claude" });

    const got = await call(client, "get_task", { taskId: created.data.id });
    expect(got.data.comments.map((c: any) => c.body)).toEqual(["Started work"]);

    const found = await call(client, "search_tasks", { query: "agent" });
    expect(found.data.map((t: any) => t.id)).toEqual([created.data.id]);

    const col = await call(client, "create_column", { board: "Board", name: "QA", afterColumn: "review" });
    expect(col.data.name).toBe("QA");

    const order = ["Done", "QA", "Review", "In Progress", "Ready for Dev", "Backlog"];
    const reordered = await call(client, "reorder_columns", { board: "Board", columns: order });
    expect(reordered.data.map((c: any) => c.name)).toEqual(order);
    const rest = await api("GET", `/boards/${board.id}`, { token: user.token });
    expect(rest.body.columns.map((c: any) => c.name)).toEqual(order);

    const incomplete = await call(client, "reorder_columns", { board: "Board", columns: ["Done"] });
    expect(incomplete.isError).toBe(true);

    const members = await call(client, "list_members");
    expect(members.data).toEqual([expect.objectContaining({ userId: user.id, role: "owner" })]);
    await client.close();
  });

  test("agent cannot reach tasks in another workspace", async () => {
    const { secret } = await agentSetup();
    const other = await setup("Other");
    const foreign = await createTask(other.user, other.board.id, other.col("Backlog").id, "foreign");
    const client = await mcpClient(secret);
    const res = await call(client, "move_task", { taskId: foreign.id, column: "Done" });
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe("forbidden");
    await client.close();
  });
});
