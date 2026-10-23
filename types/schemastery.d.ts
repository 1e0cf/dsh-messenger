declare module '@deepseek-ai/schemastery' {
  export interface Schema<T = unknown> {
    required(required?: boolean): Schema<T>;
    default(value: T): Schema<T>;
  }

  export interface Static {
    string(): Schema<string>;
    array<T>(element: Schema<T>): Schema<T[]>;
    dict<T>(value: Schema<T>): Schema<Record<string, T>>;
    object<S extends Record<string, Schema>>(
      shape: S,
    ): Schema<{ [K in keyof S]: S[K] extends Schema<infer V> ? V : never }>;
  }

  export const Schema: Static;
  export default Schema;
}
