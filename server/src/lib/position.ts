import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { badRequest } from "./errors.ts";

export interface Positioned {
  id: string;
  position: string;
}

export interface Placement {
  /** Place the item immediately before this sibling. */
  beforeId?: string | null;
  /** Place the item immediately after this sibling. */
  afterId?: string | null;
}

/** Bytewise comparison, matching fractional-indexing's ordering and Postgres `COLLATE "C"`. */
export const comparePositions = (a: Positioned, b: Positioned) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Compute a fractional-index key for an item placed among `siblings` (the target list, in any order).
 * `selfId` is excluded from the siblings so an item can be re-positioned within its own list.
 * With no placement hints the item goes to the end.
 */
export function computePosition(siblings: Positioned[], placement: Placement = {}, selfId?: string): string {
  const list = siblings.filter((s) => s.id !== selfId).sort(comparePositions);
  const indexOf = (id: string, field: string) => {
    const i = list.findIndex((s) => s.id === id);
    if (i === -1) throw badRequest(`${field} ${id} is not a sibling in the target list`);
    return i;
  };

  let lower: string | null;
  let upper: string | null;
  const { beforeId, afterId } = placement;

  if (afterId && beforeId) {
    lower = list[indexOf(afterId, "afterId")]!.position;
    upper = list[indexOf(beforeId, "beforeId")]!.position;
    if (lower >= upper) throw badRequest("afterId must come before beforeId");
  } else if (afterId) {
    const i = indexOf(afterId, "afterId");
    lower = list[i]!.position;
    upper = list[i + 1]?.position ?? null;
  } else if (beforeId) {
    const i = indexOf(beforeId, "beforeId");
    upper = list[i]!.position;
    lower = list[i - 1]?.position ?? null;
  } else {
    lower = list.at(-1)?.position ?? null;
    upper = null;
  }
  return generateKeyBetween(lower, upper);
}

/** `n` evenly spread keys for a fresh list. */
export const initialPositions = (n: number): string[] => generateNKeysBetween(null, null, n);
