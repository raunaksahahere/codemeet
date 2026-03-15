import * as vscode from 'vscode';

const STORAGE_KEY = 'codemeet.privateNotes';

/**
 * Private notes panel — a webview with a textarea stored locally
 * in VS Code's globalState. Content is never sent over the network.
 */
export class PrivateNotesPanel implements vscode.Disposable {
  public static currentPanel: PrivateNotesPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly globalState: vscode.Memento;
  private disposables: vscode.Disposable[] = [];

  static createOrShow(extensionUri: vscode.Uri, globalState: vscode.Memento): PrivateNotesPanel {
    const column = vscode.ViewColumn.Beside;

    if (PrivateNotesPanel.currentPanel) {
      PrivateNotesPanel.currentPanel.panel.reveal(column);
      return PrivateNotesPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'codemeet.privateNotes',
      '🔒 Private Notes',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    PrivateNotesPanel.currentPanel = new PrivateNotesPanel(panel, globalState);
    return PrivateNotesPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel, globalState: vscode.Memento) {
    this.panel = panel;
    this.globalState = globalState;
    this.panel.webview.html = this.getHtml();

    // Load saved content
    const saved = this.globalState.get<string>(STORAGE_KEY, '');
    this.panel.webview.postMessage({ type: 'load', content: saved });

    this.panel.onDidDispose(() => {
      PrivateNotesPanel.currentPanel = undefined;
      this.dispose();
    }, null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg: { type: string; content?: string }) => {
        if (msg.type === 'contentChanged' && msg.content !== undefined) {
          this.globalState.update(STORAGE_KEY, msg.content);
        }
      },
      null,
      this.disposables,
    );
  }

  private getHtml(): string {
    return /* html */ `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Private Notes</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
            padding: 12px;
          }
          .header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
            font-size: 13px;
            font-weight: 600;
          }
          .header .icon { font-size: 16px; }
          .badge {
            font-size: 10px;
            padding: 2px 6px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 3px;
            font-weight: 400;
          }
          textarea {
            flex: 1;
            width: 100%;
            resize: none;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size, 13px);
            padding: 10px;
            border-radius: 4px;
            outline: none;
            line-height: 1.5;
          }
          textarea:focus {
            border-color: var(--vscode-focusBorder);
          }
          .footer {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 6px;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <span class="icon">🔒</span>
          <span>Private Notes</span>
          <span class="badge">LOCAL ONLY</span>
        </div>
        <textarea id="notes" placeholder="Your private notes... these are stored locally and never shared."></textarea>
        <div class="footer">🔒 These notes are stored locally and never sent over the network.</div>

        <script>
          const vscode = acquireVsCodeApi();
          const textarea = document.getElementById('notes');

          textarea.addEventListener('input', () => {
            vscode.postMessage({ type: 'contentChanged', content: textarea.value });
          });

          window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type === 'load') {
              textarea.value = msg.content || '';
            }
          });
        </script>
      </body>
      </html>
    `;
  }

  dispose(): void {
    PrivateNotesPanel.currentPanel = undefined;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
