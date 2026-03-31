import pino from 'pino';
import type { LogLevel } from '../config/types.js';

let logger = pino({
  level: process.stdout.isTTY ? 'warn' : 'info',  // suppress INFO in interactive terminal
  transport: process.stdout.isTTY
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          ignore: 'pid,hostname',
          translateTime: 'SYS:HH:MM:ss',
        },
      }
    : undefined,
});

export function setLogLevel(level: LogLevel): void {
  logger = logger.child({});
  logger.level = level;
}

export { logger };
