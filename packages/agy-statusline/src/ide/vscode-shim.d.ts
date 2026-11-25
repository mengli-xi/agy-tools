declare module 'vscode' {
  export interface Disposable {
    dispose(): void;
  }

  export enum StatusBarAlignment {
    Left = 1,
    Right = 2
  }

  export enum ViewColumn {
    Active = -1,
    Beside = -2,
    One = 1,
    Two = 2
  }

  export class ThemeColor {
    constructor(id: string);
  }

  export class Uri {
    readonly fsPath: string;
    readonly scheme: string;
    static file(path: string): Uri;
    toString(): string;
  }

  export class MarkdownString {
    value: string;
    isTrusted?: boolean | { readonly enabledCommands: readonly string[] };
    supportThemeIcons?: boolean;
    supportHtml?: boolean;
    constructor(value?: string, supportThemeIcons?: boolean);
  }

  export interface StatusBarItem extends Disposable {
    alignment: StatusBarAlignment;
    priority?: number;
    text: string;
    tooltip?: string | MarkdownString;
    color?: string | ThemeColor;
    backgroundColor?: ThemeColor;
    command?: string;
    name?: string;
    show(): void;
    hide(): void;
  }

  export interface QuickPickItem {
    label: string;
    description?: string;
    detail?: string;
    picked?: boolean;
  }

  export interface Webview {
    html: string;
    options: { enableScripts?: boolean };
    postMessage(message: unknown): Thenable<boolean>;
    onDidReceiveMessage(listener: (e: unknown) => unknown): Disposable;
  }

  export interface WebviewPanel extends Disposable {
    readonly webview: Webview;
    readonly visible: boolean;
    title: string;
    reveal(viewColumn?: ViewColumn, preserveFocus?: boolean): void;
    onDidDispose(listener: () => unknown): Disposable;
    onDidChangeViewState(listener: (e: { readonly webviewPanel: WebviewPanel }) => unknown): Disposable;
  }

  export interface WorkspaceFolder {
    readonly uri: Uri;
    readonly name: string;
    readonly index: number;
  }

  export interface ExtensionContext {
    readonly subscriptions: Disposable[];
    readonly extensionPath: string;
  }

  export namespace window {
    export function createStatusBarItem(alignment?: StatusBarAlignment, priority?: number): StatusBarItem;
    export function createStatusBarItem(id: string, alignment: StatusBarAlignment, priority?: number): StatusBarItem;
    export function createWebviewPanel(
      viewType: string,
      title: string,
      showOptions: ViewColumn | { readonly viewColumn: ViewColumn; readonly preserveFocus?: boolean },
      options?: { readonly enableScripts?: boolean; readonly retainContextWhenHidden?: boolean }
    ): WebviewPanel;
    export function showQuickPick<T extends QuickPickItem>(
      items: readonly T[],
      options?: { readonly placeHolder?: string; readonly title?: string }
    ): Thenable<T | undefined>;
    export function showTextDocument(
      uri: Uri,
      options?: { readonly preview?: boolean; readonly viewColumn?: ViewColumn }
    ): Thenable<unknown>;
    export function showInformationMessage(message: string): Thenable<string | undefined>;
    export function showWarningMessage(message: string): Thenable<string | undefined>;
  }

  export namespace workspace {
    export const workspaceFolders: readonly WorkspaceFolder[] | undefined;
    export function onDidChangeWorkspaceFolders(listener: () => unknown): Disposable;
  }

  export namespace commands {
    export function registerCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable;
    export function executeCommand<T = unknown>(command: string, ...rest: unknown[]): Thenable<T>;
  }
}
