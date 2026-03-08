/**
 * Plugin logger — centralizes logging so operators can control output
 * via the gateway's logger interface.
 *
 * Call setLogger() at plugin registration to wire up the gateway logger.
 * Standalone scripts (backfill CLIs) use the default console fallback.
 */

export interface PluginLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

const defaultLogger: PluginLogger = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};

let logger: PluginLogger = defaultLogger;

export function setLogger(l: {
  info?: (msg: string) => void;
  warn: (msg: string) => void;
}): void {
  logger = {
    info: l.info ?? defaultLogger.info,
    warn: l.warn,
    error: defaultLogger.error,
  };
}

export function getLogger(): PluginLogger {
  return logger;
}
