// Electrobun (`electrobun@1.16.x`) ships raw `.ts` source files via its
// `exports` field instead of `.d.ts` declarations, and one of those
// source files (`node_modules/electrobun/dist/api/browser/index.ts:36`)
// has a real type error TypeScript can't suppress with `skipLibCheck`
// (skipLibCheck only ignores `.d.ts` files, not `.ts` sources reached
// via import).
//
// Until upstream Electrobun ships proper declarations, this module
// declaration + the `paths` entry in `tsconfig.json` redirect every
// `electrobun/{bun,view}` import here so `tsc --noEmit` doesn't try
// to type-check the upstream source.
//
// Runtime resolution (Bun, Vite) is independent of tsconfig `paths`
// and continues to load the real Electrobun bundle from node_modules,
// so this shim is type-only.
//
// Every existing call site uses `@ts-ignore` on the `electrobun/*`
// import line because the prior workaround was per-import suppression
// — keep those comments in place; they're harmless against this
// `any`-typed shim and the day Electrobun ships real types they
// transition cleanly to documented narrow types.

declare module "electrobun/bun" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const BrowserWindow: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const BrowserView: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const GlobalShortcut: any;
}

declare module "electrobun/view" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Electroview: any;
}
