// Electrobun 2 no longer ships its SDK in node_modules at all: the
// `electrobun` npm package is a CLI bootstrap, and the SDK (raw `.ts`
// sources, no `.d.ts`) is projected by Hutch into
// apps/loadout-overlay/.hutch/devkit/ on `electrobun prepare`. That
// directory is generated, git-ignored, and absent in CI's typecheck job,
// so we can't point tsconfig at it.
//
// Instead this module declaration + the `paths` entry in `tsconfig.json`
// redirect every `electrobun/{main,view}` import here, so `tsc --noEmit`
// neither needs the devkit nor type-checks upstream source.
//
// Runtime resolution is independent of tsconfig `paths`: Hutch aliases
// the main-process bundle onto the devkit itself, and vite.config.ts does
// the same for the webview. This shim is type-only.
//
// Every existing call site uses `@ts-ignore` on the `electrobun/*`
// import line because the prior workaround was per-import suppression
// — keep those comments in place; they're harmless against this
// `any`-typed shim and the day Electrobun ships real types they
// transition cleanly to documented narrow types.

declare module "electrobun/main" {
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
