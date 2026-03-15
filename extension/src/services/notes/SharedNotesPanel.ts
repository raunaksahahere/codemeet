import * as vscode from 'vscode';
import type { NoteUpdatePayload, NoteTypingPayload } from '@codemeet/shared';
import type { TypedSocket } from '../ConnectionManager.js';

/**
 * Shared notes panel — a webview with a live textarea that broadcasts
 * content changes to all room peers via Socket.IO relay.
 */
export class SharedNotesPanel implements vscode.Disposable {
  public static currentPanel: SharedNotesPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private socket: TypedSocket | null = null;
  private roomId: string | null = null;
  private userId = '';
  private displayName = '';
  private rev = 0;
  private disposables: vscode.Disposable[] = [];
  private typingTimeout: ReturnType<typeof setTimeout> | null = null;

  static createOrShow(
    extensionUri: vscode.Uri,
    socket: TypedSocket,
    roomId: string,
    userId: string,
    displayName: string,
  ): SharedNotesPanel {
    const column = vscode.ViewColumn.Beside;

    if (SharedNotesPanel.currentPanel) {
      SharedNotesPanel.currentPanel.panel.reveal(column);
      SharedNotesPanel.currentPanel.connect(socket, roomId, userId, displayName);
      return SharedNotesPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'codemeet.sharedNotes',
      '📝 Shared Notes',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    SharedNotesPanel.currentPanel = new SharedNotesPanel(panel, extensionUri);
    SharedNotesPanel.currentPanel.connect(socket, roomId, userId, displayName);
    return SharedNotesPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel, _extensionUri: vscode.Uri) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => {
      SharedNotesPanel.currentPanel = undefined;
      this.dispose();
    }, null, this.disposables);

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      (msg: { type: string; content?: string }) => {
        if (msg.type === 'contentChanged' && msg.content !== undefined) {
          this.onLocalChange(msg.content);
        }
      },
      null,
      this.disposables,
    );
  }

  private connect(socket: TypedSocket, roomId: string, userId: string, displayName: string): void {
    this.socket = socket;
    this.roomId = roomId;
    this.userId = userId;
    this.displayName = displayName;
    this.rev = 0;

    // Listen for remote note updates
    socket.on('note-update', (data: NoteUpdatePayload) => {
      if (data.roomId === this.roomId && data.userId !== this.userId) {
        this.panel.webview.postMessage({
          type: 'remoteUpdate',
          content: data.content,
          displayName: data.displayName,
        });
      }
    });

    // Listen for typing indicators
    socket.on('note-typing', (data: NoteTypingPayload) => {
      if (data.roomId === this.roomId && data.userId !== this.userId) {
        this.panel.webview.postMessage({
          type: 'typingIndicator',
          displayName: data.displayName,
          isTyping: data.isTyping,
        });
      }
    });
  }

  private onLocalChange(content: string): void {
    if (!this.socket || !this.roomId) return;

    this.rev++;
    this.socket.emit('note-update', {
      roomId: this.roomId,
      userId: this.userId,
      displayName: this.displayName,
      content,
      rev: this.rev,
    });

    // Send typing indicator
    this.socket.emit('note-typing', {
      roomId: this.roomId,
      userId: this.userId,
      displayName: this.displayName,
      isTyping: true,
    });

    // Clear typing after 2s of no input
    if (this.typingTimeout) clearTimeout(this.typingTimeout);
    this.typingTimeout = setTimeout(() => {
      this.socket?.emit('note-typing', {
        roomId: this.roomId!,
        userId: this.userId,
        displayName: this.displayName,
        isTyping: false,
      });
    }, 2000);
  }

  private getHtml(): string {
    return /* html */ `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Shared Notes</title>
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
          .typing-indicator {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            min-height: 18px;
            margin-bottom: 6px;
            font-style: italic;
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
          <span class="icon">📝</span>
          <span>Shared Notes</span>
        </div>
        <div id="typing" class="typing-indicator"></div>
        <textarea id="notes" placeholder="Type notes here... visible to all peers in the room."></textarea>
        <div class="footer">Changes are shared in real-time with all room members.</div>

        <script>
          const vscode = acquireVsCodeApi();
          const textarea = document.getElementById('notes');
          const typingEl = document.getElementById('typing');
          let isRemoteUpdate = false;
          const typingPeers = new Set();

          textarea.addEventListener('input', () => {
            if (isRemoteUpdate) return;
            vscode.postMessage({ type: 'contentChanged', content: textarea.value });
          });

          window.addEventListener('message', (event) => {
            const msg = event.data;

            if (msg.type === 'remoteUpdate') {
              const cursorPos = textarea.selectionStart;
              const prevLen = textarea.value.length;
              isRemoteUpdate = true;
              textarea.value = msg.content;
              isRemoteUpdate = false;
              // Try to preserve cursor position
              const diff = textarea.value.length - prevLen;
              textarea.selectionStart = textarea.selectionEnd = cursorPos + diff;
            }

            if (msg.type === 'typingIndicator') {
              if (msg.isTyping) {
                typingPeers.add(msg.displayName);
              } else {
                typingPeers.delete(msg.displayName);
              }
              if (typingPeers.size > 0) {
                const names = Array.from(typingPeers).join(', ');
                typingEl.textContent = names + (typingPeers.size === 1 ? ' is typing...' : ' are typing...');
              } else {
                typingEl.textContent = '';
              }
            }
          });
        </script>
      </body>
      </html>
    `;
  }

  dispose(): void {
    SharedNotesPanel.currentPanel = undefined;
    if (this.typingTimeout) clearTimeout(this.typingTimeout);
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
