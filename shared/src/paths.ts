/**
 * Canonical shared-path handling. A shared path is always a relative, POSIX-style,
 * normalized path ("src/index.ts"). Anything that could escape the project root or be
 * interpreted differently on another OS is rejected rather than "fixed up".
 */

const MAX_PATH_LENGTH = 512;
const MAX_SEGMENT_LENGTH = 255;

/** Returns the path unchanged when it is canonical and safe, otherwise null. */
export function normalizeRelPath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  if (input.length === 0 || input.length > MAX_PATH_LENGTH) return null;
  // NUL, backslashes (Windows separators / UNC), absolute POSIX and drive-letter paths.
  if (input.includes('\0') || input.includes('\\')) return null;
  if (input.startsWith('/') || /^[a-zA-Z]:/.test(input)) return null;
  const segments = input.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return null;
    if (seg.length > MAX_SEGMENT_LENGTH) return null;
    // ':' blocks drive letters and NTFS alternate data streams; trailing dot/space are
    // silently stripped by Windows and can alias another file.
    if (seg.includes(':') || /[. ]$/.test(seg)) return null;
    // Control characters have no business in a shared project path.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(seg)) return null;
  }
  return input;
}

export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/** True when `candidate` equals `dir` or lives below it. */
export function isWithin(dir: string, candidate: string): boolean {
  return candidate === dir || candidate.startsWith(dir + '/');
}
