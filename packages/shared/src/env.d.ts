// Minimal host APIs available in browsers, workers and Node; shared code must not depend on anything else.
declare function setTimeout(fn: () => void, ms?: number): unknown;
declare function clearTimeout(id: unknown): void;
declare const performance: { now(): number };
declare const console: { log(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
