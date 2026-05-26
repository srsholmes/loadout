import { sep } from "node:path";
import { watch, type FSWatcher } from "node:fs";

/** Returns true for filenames the plugin watcher should ignore. */
export function shouldIgnore(filename: string | null): boolean {
  if (!filename) return true;
  for (const dir of [".cache", ".build", "node_modules"]) {
    if (filename.startsWith(dir)) return true;
    if (filename.includes(`${sep}${dir}${sep}`)) return true;
    if (filename.endsWith(`${sep}${dir}`)) return true;
  }
  return false;
}

export interface WatchHandle {
  close(): void;
}

export function watchDir(
  dir: string,
  onChange: (filename: string) => void,
  debounceMs = 300,
): WatchHandle {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFilename = "";
  const watcher: FSWatcher = watch(dir, { recursive: true }, (_eventType, filename) => {
    if (shouldIgnore(filename)) return;
    lastFilename = filename ?? "";
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => onChange(lastFilename), debounceMs);
  });
  return {
    close() {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
