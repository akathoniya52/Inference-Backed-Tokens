import type { Logger } from 'pino';
import { fetch as undiciFetch } from 'undici';

import { createLogAlerter, type Alerter, type AlertLevel } from './alerter.js';

export const TELEGRAM_API_BASE = 'https://api.telegram.org';
/** Telegram rejects messages over 4096 chars; the body is capped well below that. */
export const TELEGRAM_BODY_LIMIT = 3500;
const TELEGRAM_TIMEOUT_MS = 5_000;

export interface TelegramRequestInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export type TelegramFetch = (
  url: string,
  init: TelegramRequestInit,
) => Promise<{ ok: boolean; status: number }>;

export interface TelegramAlerterOptions {
  botToken: string;
  chatId: string;
  logger: Pick<Logger, AlertLevel>;
  fetch?: TelegramFetch;
  apiBase?: string;
}

export interface CreateAlerterOptions {
  botToken?: string;
  chatId?: string;
  logger: Pick<Logger, AlertLevel>;
  fetch?: TelegramFetch;
}

export function formatTelegramText(
  level: AlertLevel,
  title: string,
  body: Record<string, unknown>,
): string {
  const header = `[${level.toUpperCase()}] ${title}`;
  if (Object.keys(body).length === 0) return header;
  const json = JSON.stringify(body, null, 2);
  const capped =
    json.length > TELEGRAM_BODY_LIMIT ? `${json.slice(0, TELEGRAM_BODY_LIMIT)}…` : json;
  return `${header}\n${capped}`;
}

/** G27: Telegram is additive; every alert still goes through the log transport first. */
export function createTelegramAlerter({
  botToken,
  chatId,
  logger,
  fetch = undiciFetch,
  apiBase = TELEGRAM_API_BASE,
}: TelegramAlerterOptions): Alerter {
  const logAlerter = createLogAlerter(logger);
  const url = `${apiBase}/bot${botToken}/sendMessage`;
  const scrub = (message: string): string => message.split(botToken).join('***');

  async function send(text: string): Promise<void> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.warn(
          {
            err: { message: `telegram responded ${res.status}` },
            status: res.status,
            apiBase,
            chatId,
          },
          'telegram alert failed',
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { err: { message: scrub(message) }, status: undefined, apiBase, chatId },
        'telegram alert failed',
      );
    }
  }

  return {
    async alert(level, title, body = {}) {
      await logAlerter.alert(level, title, body);
      await send(formatTelegramText(level, title, body));
    },
  };
}

export function createAlerter({ botToken, chatId, logger, fetch }: CreateAlerterOptions): Alerter {
  if (botToken && chatId) {
    logger.info({ transport: 'telegram', chatId }, 'alerter transport selected');
    return createTelegramAlerter({ botToken, chatId, logger, fetch });
  }
  logger.info({ transport: 'log' }, 'alerter transport selected');
  return createLogAlerter(logger);
}
