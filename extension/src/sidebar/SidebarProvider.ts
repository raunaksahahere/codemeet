import * as vscode from 'vscode';
import type { RoomState } from '../services/RoomService';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    _roomService: { getState(): RoomState | null },
  ) {}

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

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage((message: { command: string }) => {
      switch (message.command) {
        case 'startRoom':
          vscode.commands.executeCommand('codemeet.startRoom');
          break;
        case 'joinRoom':
          vscode.commands.executeCommand('codemeet.joinRoom');
          break;
        case 'leaveRoom':
          vscode.commands.executeCommand('codemeet.leaveRoom');
          break;
      }
    });
  }

  public updateState(state: RoomState | null): void {
    if (this.view) {
      this.view.webview.postMessage({ type: 'stateUpdate', state });
    }
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
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            padding: 12px;
          }
          h2 { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
          p { font-size: 12px; line-height: 1.5; color: var(--vscode-descriptionForeground); }
          .status-bar {
            display: flex; align-items: center; gap: 8px;
            padding: 8px 10px; margin: 8px 0;
            background: var(--vscode-editor-background);
            border-radius: 4px; font-size: 12px;
          }
          .dot {
            width: 8px; height: 8px; border-radius: 50%;
            flex-shrink: 0;
          }
          .dot.disconnected { background: var(--vscode-charts-yellow); }
          .dot.connected { background: var(--vscode-charts-green); }
          button {
            display: block; width: 100%; padding: 8px 12px;
            margin-top: 8px; border: none; border-radius: 4px;
            font-size: 12px; cursor: pointer;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
          }
          button:hover { background: var(--vscode-button-hoverBackground); }
          button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
          }
          button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
          .member-list { list-style: none; margin: 8px 0; }
          .member-item {
            display: flex; align-items: center; gap: 8px;
            padding: 4px 0; font-size: 12px;
          }
          .member-dot {
            width: 10px; height: 10px; border-radius: 50%;
            flex-shrink: 0;
          }
          .room-id {
            font-family: var(--vscode-editor-font-family);
            font-size: 13px; font-weight: 600;
            padding: 4px 8px; margin: 4px 0;
            background: var(--vscode-textCodeBlock-background);
            border-radius: 3px; display: inline-block;
          }
          .section { margin-top: 16px; }
          .hidden { display: none; }
        </style>
      </head>
      <body>
        <h2>CodeMeet</h2>

        <!-- Disconnected view -->
        <div id="disconnected-view">
          <div class="status-bar">
            <span class="dot disconnected"></span>
            <span>Not connected</span>
          </div>
          <button onclick="send('startRoom')">Start Room</button>
          <button class="secondary" onclick="send('joinRoom')">Join Room</button>
          <p style="margin-top:12px">Create or join a room to start collaborating.</p>
        </div>

        <!-- Connected view -->
        <div id="connected-view" class="hidden">
          <div class="status-bar">
            <span class="dot connected"></span>
            <span>Connected</span>
          </div>
          <div class="section">
            <p>Room</p>
            <span id="room-id" class="room-id">—</span>
          </div>
          <div class="section">
            <p>Members</p>
            <ul id="member-list" class="member-list"></ul>
          </div>
          <button class="secondary" onclick="send('leaveRoom')" style="margin-top:16px">
            Disconnect
          </button>
        </div>

        <script>
          const vscode = acquireVsCodeApi();
          function send(cmd) { vscode.postMessage({ command: cmd }); }

          window.addEventListener('message', (event) => {
            const { type, state } = event.data;
            if (type !== 'stateUpdate') return;

            const disconnected = document.getElementById('disconnected-view');
            const connected = document.getElementById('connected-view');

            if (!state) {
              disconnected.classList.remove('hidden');
              connected.classList.add('hidden');
              return;
            }

            disconnected.classList.add('hidden');
            connected.classList.remove('hidden');

            document.getElementById('room-id').textContent = state.roomId;

            const list = document.getElementById('member-list');
            list.innerHTML = '';
            for (const m of state.members) {
              const li = document.createElement('li');
              li.className = 'member-item';
              li.innerHTML =
                '<span class="member-dot" style="background:' + m.color + '"></span>' +
                '<span>' + m.displayName + '</span>';
              list.appendChild(li);
            }
          });
        </script>
      </body>
      </html>
    `;
  }
}
