import type { ApiKeyRow, UserRow } from "../db/schema.ts";

/** Who is making a request: a logged-in user or an agent authenticated with an API key. */
export type Principal = { kind: "user"; user: UserRow } | { kind: "agent"; apiKey: ApiKeyRow };

/** Actor as exposed in the API contract and recorded on events/tasks/comments. */
export interface Actor {
  type: "user" | "agent";
  id: string;
  name: string;
}

export function actorOf(p: Principal): Actor {
  return p.kind === "user"
    ? { type: "user", id: p.user.id, name: p.user.name }
    : { type: "agent", id: p.apiKey.id, name: p.apiKey.name };
}
