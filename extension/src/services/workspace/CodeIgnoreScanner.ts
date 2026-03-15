import * as fs from 'fs';
import * as path from 'path';
import ignore, { Ignore } from 'ignore';

/**
 * Parses .codeignore files (gitignore-compatible syntax) to determine
 * which files/folders should be excluded from workspace sync.
 */
export class CodeIgnoreScanner {
  private ig: Ignore;

  constructor(private readonly workspaceRoot: string) {
    this.ig = ignore();
    this.loadCodeIgnore();
  }

  /** Reload .codeignore from disk. */
  reload(): void {
    this.ig = ignore();
    this.loadCodeIgnore();
  }

  /** Check if a relative path should be ignored. */
  isIgnored(relativePath: string): boolean {
    // Always ignore these regardless of .codeignore
    const alwaysIgnore = ['node_modules', '.git', '.DS_Store', 'dist', '.vscode-test'];
    for (const pattern of alwaysIgnore) {
      if (relativePath === pattern || relativePath.startsWith(pattern + '/')) {
        return true;
      }
    }

    return this.ig.ignores(relativePath);
  }

  /** Filter a list of relative paths, returning only non-ignored ones. */
  filter(relativePaths: string[]): string[] {
    return relativePaths.filter((p) => !this.isIgnored(p));
  }

  private loadCodeIgnore(): void {
    const codeignorePath = path.join(this.workspaceRoot, '.codeignore');
    try {
      if (fs.existsSync(codeignorePath)) {
        const content = fs.readFileSync(codeignorePath, 'utf-8');
        this.ig.add(content);
        console.log('[CodeMeet] Loaded .codeignore');
      }
    } catch (err) {
      console.warn('[CodeMeet] Failed to read .codeignore:', err);
    }
  }
}
