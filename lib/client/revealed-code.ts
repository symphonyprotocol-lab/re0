/**
 * The plaintext shown for one redeem code, kept with that code's id. The
 * console table keys its rows by position, so after paging or filtering the
 * same `RevealCode` can be handed another code: a plaintext held for the old
 * id is never shown next to the new one (review C7).
 */
export type Revealed = { id: string; code: string } | null;

export function revealedFor(revealed: Revealed, id: string): string | null {
  return revealed && revealed.id === id ? revealed.code : null;
}
