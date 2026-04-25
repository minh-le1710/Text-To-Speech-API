import fs from 'node:fs/promises';
import env from '@/configs/env';
import logger from '@/services/logger';

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: TelegramChat;
    text?: string;
    caption?: string;
    document?: TelegramDocument;
    date?: number;
  };
}

interface TelegramFile {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}

interface DocxNotification {
  fileName: string;
  wordCount: number;
  charCount: number;
  totalChunks: number;
  completedChunks: number;
  resumedChunks: number;
  duration?: string;
  byteLength: number;
  jobId: string;
}

class TelegramService {
  isConfigured() {
    return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
  }

  hasBotToken() {
    return Boolean(env.TELEGRAM_BOT_TOKEN);
  }

  async sendMessage(text: string) {
    if (!this.isConfigured()) {
      return false;
    }

    await this.requestJson('sendMessage', {
      method: 'POST',
      body: new URLSearchParams({
        chat_id: env.TELEGRAM_CHAT_ID ?? '',
        text: text.slice(0, 4096),
        disable_web_page_preview: 'true',
      }),
    });

    return true;
  }

  async sendDocumentFile(filePath: string, fileName: string, caption?: string) {
    if (!this.isConfigured()) {
      return false;
    }

    const buffer = await fs.readFile(filePath);
    const formData = new FormData();

    formData.set('chat_id', env.TELEGRAM_CHAT_ID ?? '');
    formData.set(
      'document',
      new Blob([new Uint8Array(buffer)], { type: 'audio/mpeg' }),
      fileName
    );

    if (caption) {
      formData.set('caption', caption.slice(0, 1024));
    }

    await this.requestJson('sendDocument', {
      method: 'POST',
      body: formData,
    });

    return true;
  }

  async sendPhotoBase64(photoBase64: string, caption: string) {
    if (!this.isConfigured()) {
      return false;
    }

    const buffer = Buffer.from(
      photoBase64.replace(/^data:image\/\w+;base64,/i, ''),
      'base64'
    );
    const formData = new FormData();

    formData.set('chat_id', env.TELEGRAM_CHAT_ID ?? '');
    formData.set(
      'photo',
      new Blob([new Uint8Array(buffer)], { type: 'image/png' }),
      'capcut-login-qr.png'
    );
    formData.set('caption', caption.slice(0, 1024));

    await this.requestJson('sendPhoto', {
      method: 'POST',
      body: formData,
    });

    return true;
  }

  async sendCapCutQr(photoBase64: string, expiresAt?: number) {
    const lines = [
      'CapCut session can dang nhap lai.',
      '',
      'Hay mo CapCut Mobile, quet QR nay va xac nhan login.',
    ];

    if (expiresAt) {
      lines.push(`QR het han luc: ${new Date(expiresAt).toLocaleString()}`);
    }

    return this.sendPhotoBase64(photoBase64, lines.join('\n'));
  }

  async sendCapCutLoginSuccess(workspaceId?: string) {
    return this.sendMessage(
      [
        'CapCut QR login thanh cong.',
        workspaceId ? `Workspace: ${workspaceId}` : undefined,
        'Session da duoc luu lai de backend tiep tuc chay.',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  async sendDocxCompleted(result: DocxNotification) {
    if (!env.TELEGRAM_DOCX_NOTIFICATIONS) {
      return false;
    }

    return this.sendMessage(
      [
        'Ket qua DOCX -> MP3:',
        '',
        `File: ${result.fileName}`,
        `${formatNumber(result.wordCount)} tu, ${formatNumber(
          result.charCount
        )} ky tu.`,
        `Chia thanh ${formatNumber(result.totalChunks)} chunk.`,
        `${formatNumber(result.completedChunks)}/${formatNumber(
          result.totalChunks
        )} chunk completed va da checkpoint.`,
        result.resumedChunks > 0
          ? `Dung lai ${formatNumber(result.resumedChunks)} chunk tu checkpoint.`
          : undefined,
        result.duration ? `MP3 dai khoang ${result.duration}.` : undefined,
        `Dung luong khoang ${formatBytes(result.byteLength)}.`,
        `Job: ${result.jobId}`,
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  async sendDocxFailed(result: {
    fileName: string;
    jobId?: string;
    completedChunks?: number;
    totalChunks?: number;
    errorMessage: string;
  }) {
    if (!env.TELEGRAM_DOCX_NOTIFICATIONS) {
      return false;
    }

    return this.sendMessage(
      [
        'DOCX -> MP3 bi loi.',
        '',
        `File: ${result.fileName}`,
        result.jobId ? `Job: ${result.jobId}` : undefined,
        result.completedChunks !== undefined && result.totalChunks !== undefined
          ? `Tien do: ${formatNumber(result.completedChunks)}/${formatNumber(
              result.totalChunks
            )} chunk.`
          : undefined,
        `Loi: ${result.errorMessage}`,
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  async getUpdates(options: {
    offset?: number;
    timeoutSeconds?: number;
    allowedUpdates?: string[];
  } = {}) {
    if (!this.hasBotToken()) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }

    const body = new URLSearchParams({
      allowed_updates: JSON.stringify(options.allowedUpdates ?? ['message']),
    });

    if (options.offset !== undefined) {
      body.set('offset', String(options.offset));
    }

    if (options.timeoutSeconds !== undefined) {
      body.set('timeout', String(options.timeoutSeconds));
    }

    const response = await this.requestJson<TelegramUpdate[]>('getUpdates', {
      method: 'POST',
      body,
    });

    return response.result ?? [];
  }

  async downloadFile(fileId: string) {
    if (!this.hasBotToken()) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }

    const file = await this.requestJson<TelegramFile>('getFile', {
      method: 'POST',
      body: new URLSearchParams({
        file_id: fileId,
      }),
    });
    const filePath = file.result?.file_path;

    if (!filePath) {
      throw new Error('Telegram getFile did not return file_path');
    }

    const response = await fetch(
      `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`
    );

    if (!response.ok) {
      throw new Error(
        `Telegram file download failed: ${response.status} ${response.statusText}`
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  private async requestJson<T = unknown>(method: string, init: RequestInit) {
    if (!env.TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }

    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
      init
    );
    const payload = (await response.json().catch(() => null)) as
      | TelegramApiResponse<T>
      | null;

    if (!response.ok || !payload?.ok) {
      const description = payload?.description ?? response.statusText;
      const code = payload?.error_code ?? response.status;
      throw new Error(`Telegram ${method} failed: ${code} ${description}`);
    }

    return payload;
  }
}

const formatNumber = (value: number) => new Intl.NumberFormat('vi-VN').format(value);

const formatBytes = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
};

export const notifyTelegramSafely = async (
  action: () => Promise<unknown>,
  context: string
) => {
  try {
    await action();
  } catch (error) {
    logger.warn(`Telegram notification failed: ${context}`, { error });
  }
};

export const telegramService = new TelegramService();
export default telegramService;
