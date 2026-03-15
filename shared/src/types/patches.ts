/** Serializable range within a text document. */
export interface PatchRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/** A minimal edit patch sent over the DataChannel. */
export interface EditPatch {
  /** Relative file path from workspace root. */
  file: string;
  /** The range that was replaced. */
  range: PatchRange;
  /** The replacement text. */
  text: string;
  /** Monotonic revision counter per file. */
  rev: number;
  /** ID of the user who made the edit. */
  userId: string;
}
