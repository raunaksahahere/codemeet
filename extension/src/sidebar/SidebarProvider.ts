import * as vscode from 'vscode';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlContent();
  }

  private _getHtmlContent(): string {
    return /* html */ `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>CodeMeet</title>
        <style>
          body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            padding: 16px;
            margin: 0;
          }
          h2 {
            font-size: 14px;
            font-weight: 600;
            margin: 0 0 12px 0;
          }
          p {
            font-size: 13px;
            line-height: 1.5;
            color: var(--vscode-descriptionForeground);
          }
          .status {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 16px;
            padding: 8px 12px;
            background: var(--vscode-editor-background);
            border-radius: 4px;
          }
          .dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--vscode-charts-yellow);
          }
          .dot.connected {
            background: var(--vscode-charts-green);
          }
        </style>
      </head>
      <body>
        <h2>CodeMeet</h2>
        <p>Real-time collaborative coding over P2P WebRTC.</p>
        <div class="status">
          <span class="dot"></span>
          <span>Not connected</span>
        </div>
        <p style="margin-top: 16px; font-size: 12px;">
          Use <strong>CodeMeet: Start Room</strong> or <strong>CodeMeet: Join Room</strong> from the Command Palette to begin.
        </p>
      </body>
      </html>
    `;
  }
}
