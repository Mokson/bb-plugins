// @types/react-dom is intentionally not a dependency, so declare the two
// entry points that @testing-library/react's types import. This keeps
// skipLibCheck:false viable: the alternative (skipLibCheck:true) would mask
// type errors in every other library. If @types/react-dom is ever added,
// delete this file to avoid duplicate declarations.
declare module "react-dom/client" {
  import type { ReactNode } from "react";
  export interface Root {
    render(children: ReactNode): void;
    unmount(): void;
  }
  export type Container = Element | DocumentFragment;
  export interface RootOptions {
    onCaughtError?: unknown;
    onRecoverableError?: unknown;
    onUncaughtError?: unknown;
    identifierPrefix?: string;
  }
  export function createRoot(
    container: Element | DocumentFragment,
    options?: unknown,
  ): Root;
  export function hydrateRoot(
    container: Element | Document,
    children: ReactNode,
    options?: unknown,
  ): Root;
}

declare module "react-dom/test-utils" {
  export function act<T>(callback: () => T | Promise<T>): Promise<T>;
}
