import type { PluginLogger } from "@loadout/types";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

function ts(): string {
  return new Date().toISOString();
}

export const log: Logger = {
  info: (m) => console.log(`[${ts()}] INFO  ${m}`),
  warn: (m) => console.warn(`[${ts()}] WARN  ${m}`),
  error: (m) => console.error(`[${ts()}] ERROR ${m}`),
  debug: (m) => {
    if (process.env.LOADOUT_DEBUG === "1") console.debug(`[${ts()}] DEBUG ${m}`);
  },
};

export function createPluginLogger(pluginId: string): PluginLogger {
  const prefix = `[${pluginId}]`;
  return {
    info: (m) => log.info(`${prefix} ${m}`),
    warn: (m) => log.warn(`${prefix} ${m}`),
    error: (m) => log.error(`${prefix} ${m}`),
    debug: (m) => log.debug(`${prefix} ${m}`),
  };
}
