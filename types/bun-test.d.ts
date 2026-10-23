declare module 'bun:test' {
  export declare function test(name: string, fn: () => void | Promise<void>): void;
}
