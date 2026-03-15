/** Fixed color palette for peer cursor decorations. */
const PALETTE = [
  '#e06c75', // red
  '#61afef', // blue
  '#98c379', // green
  '#e5c07b', // yellow
  '#c678dd', // purple
  '#56b6c2', // cyan
  '#d19a66', // orange
  '#be5046', // dark red
  '#ef596f', // pink
  '#abb2bf', // grey
  '#ff6e64', // light red
  '#61efef', // light blue
  '#98c3bd', // light green
  '#e5c0e5', // light yellow
  '#c678dd', // light purple
  '#56b6c2', // light cyan
  '#d19a66', // light orange
  '#be5046', // light dark red
  '#ef596f', // light pink
];

/**
 * Deterministic color from a string (socket ID) hash.
 * Survives reconnects as long as the socket ID stays the same.
 */
export function colorFromId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export { PALETTE };
