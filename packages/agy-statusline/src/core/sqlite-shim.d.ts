declare const __AG_CAPSULE_CSS__: string;
declare const __AG_BROWSER_RUNTIME_CODE__: string;

declare module 'node:sqlite' {
  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    allowExtension?: boolean;
    timeout?: number;
  }

  export interface StatementSync {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Array<Record<string, unknown>>;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }

  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions);
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
}
