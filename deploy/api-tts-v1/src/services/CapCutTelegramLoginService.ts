import env from '@/configs/env';
import capCutQrLoginService, {
  type CapCutQrLoginTicket,
} from '@/services/CapCutQrLoginService';
import logger from '@/services/logger';
import telegramService, {
  notifyTelegramSafely,
} from '@/services/TelegramService';
import type { CapCutSessionState } from '@/types/capcut';

class CapCutTelegramLoginService {
  private loginPromise: Promise<CapCutSessionState> | null = null;

  isConfigured() {
    return env.TELEGRAM_QR_LOGIN_ENABLED && telegramService.isConfigured();
  }

  async login() {
    if (!this.isConfigured()) {
      throw new Error(
        'Telegram QR login is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.'
      );
    }

    if (this.loginPromise) {
      return this.loginPromise;
    }

    this.loginPromise = this.runLoginLoop().finally(() => {
      this.loginPromise = null;
    });

    return this.loginPromise;
  }

  private async runLoginLoop() {
    const deadline = Date.now() + env.TELEGRAM_QR_LOGIN_TIMEOUT_SECONDS * 1000;
    let ticket: CapCutQrLoginTicket | null = null;

    await notifyTelegramSafely(
      () =>
        telegramService.sendMessage(
          'CapCut session co ve da het han. Backend dang tao QR login moi...'
        ),
      'CapCut QR login started'
    );

    while (Date.now() < deadline) {
      if (!ticket || isTicketExpired(ticket)) {
        ticket = await capCutQrLoginService.createTicket();

        await notifyTelegramSafely(
          () =>
            telegramService.sendCapCutQr(
              ticket?.qrcodeBase64 ?? '',
              ticket?.expireTime ? ticket.expireTime * 1000 : undefined
            ),
          'CapCut QR code'
        );
      }

      const result = await capCutQrLoginService.poll(ticket);

      if (result.authenticated) {
        const session = result.session;

        await notifyTelegramSafely(
          () => telegramService.sendCapCutLoginSuccess(session?.workspaceId),
          'CapCut QR login success'
        );

        if (result.warning) {
          await notifyTelegramSafely(
            () => telegramService.sendMessage(`CapCut QR login warning:\n${result.warning}`),
            'CapCut QR login warning'
          );
        }

        if (!session) {
          throw new Error(
            result.warning ??
              'CapCut QR login succeeded but no validated session was returned'
          );
        }

        return session;
      }

      if (result.status === 'expired') {
        ticket = null;
        continue;
      }

      await wait(result.retryAfterMs ?? env.TELEGRAM_QR_POLL_INTERVAL_MS);
    }

    logger.warn('Telegram CapCut QR login timed out');
    await notifyTelegramSafely(
      () =>
        telegramService.sendMessage(
          'CapCut QR login da timeout. Backend se thu lai khi co request hoac chu ky kiem tra tiep theo.'
        ),
      'CapCut QR login timeout'
    );

    throw new Error('CapCut Telegram QR login timed out');
  }
}

const isTicketExpired = (ticket: CapCutQrLoginTicket) =>
  Boolean(ticket.expireTime && Date.now() >= ticket.expireTime * 1000);

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export const capCutTelegramLoginService = new CapCutTelegramLoginService();
export default capCutTelegramLoginService;
