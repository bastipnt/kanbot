/**
 * Task handles: `KEY-n`, e.g. `KAN-142`. The key is derived on read from the board name, so a rename
 * changes every handle's prefix while the numbers stay put.
 */

/** First letters of the board name's words, uppercase, at most three; `BRD` when the name yields none. */
export function boardKey(name: string): string {
  const initials = name
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => [...word][0]!)
    .join("")
    .slice(0, 3)
    .toUpperCase();
  return initials || "BRD";
}

export const taskHandle = (boardName: string, number: number) => `${boardKey(boardName)}-${number}`;
