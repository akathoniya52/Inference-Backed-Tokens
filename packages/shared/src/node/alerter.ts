import type { Logger } from 'pino';

export type AlertLevel = 'info' | 'warn' | 'error';

/** G27: P1 ships the log transport; P6-T9 adds Telegram behind the same interface. */
export interface Alerter {
  alert(level: AlertLevel, title: string, body?: Record<string, unknown>): Promise<void>;
}

export function createLogAlerter(logger: Pick<Logger, AlertLevel>): Alerter {
  return {
    alert(level, title, body = {}) {
      logger[level]({ ...body, alert: true }, title);
      return Promise.resolve();
    },
  };
}
