import type { Event } from "../lib/serialize.ts";

export interface Subscriber {
  /** Set for user connections so they can be dropped when the user leaves the workspace. */
  userId?: string;
  /** Set for agent connections so they can be dropped when the API key is revoked. */
  apiKeyId?: string;
  onEvent(event: Event): void;
  onKick?(): void;
}

/** In-process fan-out of committed events to realtime subscribers, keyed by workspace. */
class Hub {
  private readonly subs = new Map<string, Set<Subscriber>>();

  subscribe(workspaceId: string, sub: Subscriber): () => void {
    let set = this.subs.get(workspaceId);
    if (!set) this.subs.set(workspaceId, (set = new Set()));
    set.add(sub);
    return () => {
      set.delete(sub);
      if (set.size === 0 && this.subs.get(workspaceId) === set) this.subs.delete(workspaceId);
    };
  }

  /** Must only be called after the transaction that wrote the event has committed. */
  publish(event: Event): void {
    for (const sub of this.subs.get(event.workspaceId) ?? []) {
      try {
        sub.onEvent(event);
      } catch (err) {
        console.error("realtime subscriber failed", err);
      }
    }
  }

  /** Disconnect all of a user's subscriptions to a workspace (e.g. after member removal). */
  kick(workspaceId: string, userId: string): void {
    for (const sub of [...(this.subs.get(workspaceId) ?? [])]) {
      if (sub.userId === userId) sub.onKick?.();
    }
  }

  /** Disconnect all subscriptions authenticated with an API key (e.g. after it was deleted). */
  kickApiKey(workspaceId: string, apiKeyId: string): void {
    for (const sub of [...(this.subs.get(workspaceId) ?? [])]) {
      if (sub.apiKeyId === apiKeyId) sub.onKick?.();
    }
  }

  subscriberCount(workspaceId: string): number {
    return this.subs.get(workspaceId)?.size ?? 0;
  }
}

export const hub = new Hub();
