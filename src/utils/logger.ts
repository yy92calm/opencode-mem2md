/**
 * Simple logging utility.
 *
 * OpenCode V2 (2.0.x) removed the V1 `client.app.log()` plugin API, so plugin
 * logs go to console. The OpenCode host captures plugin console output in its
 * debug logs; warn/error also stay visible on stderr and are never swallowed.
 */

function sendLog(level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', service: string, message: string, context?: Record<string, unknown>) {
  const line = `[${service}] ${level.toUpperCase()} ${message}`;
  if (level === 'error' || level === 'fatal') {
    console.error(line, context);
  } else if (level === 'warn') {
    console.warn(line, context);
  } else if (level === 'info') {
    console.info(line, context);
  } else {
    console.debug(line, context);
  }
}

export const logger = {
  debug(service: string, message: string, context?: Record<string, unknown>) {
    sendLog('debug', service, message, context);
  },

  info(service: string, message: string, context?: Record<string, unknown>) {
    sendLog('info', service, message, context);
  },

  warn(service: string, message: string, context?: Record<string, unknown>) {
    sendLog('warn', service, message, context);
  },

  error(service: string, message: string, context?: Record<string, unknown>, error?: Error) {
    sendLog('error', service, message, { ...context, error: error?.message });
  },

  fatal(service: string, message: string, context?: Record<string, unknown>, error?: Error) {
    sendLog('fatal', service, message, { ...context, error: error?.message });
  },
};
