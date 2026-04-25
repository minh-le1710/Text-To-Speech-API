import env from '@/configs/env';
import {
  docxSynthesisService,
  type SynthesizeDocxJobStatus,
  type SynthesizeDocxOptions,
} from '@/services/DocxSynthesisService';
import logger from '@/services/logger';
import telegramService, {
  notifyTelegramSafely,
  type TelegramDocument,
  type TelegramUpdate,
} from '@/services/TelegramService';

type TelegramDocxOptions = Pick<
  SynthesizeDocxOptions,
  'type' | 'voice' | 'pitch' | 'speed' | 'volume' | 'outputFileName'
>;

class TelegramDocxBotService {
  private running = false;

  private offset: number | undefined;

  private queue = Promise.resolve();

  start() {
    if (this.running) {
      return;
    }

    if (!env.TELEGRAM_DOCX_UPLOADS_ENABLED) {
      logger.info('Telegram DOCX upload bot is disabled');
      return;
    }

    if (!telegramService.isConfigured()) {
      logger.warn(
        'Telegram DOCX upload bot is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.'
      );
      return;
    }

    this.running = true;
    void this.pollUpdates();
  }

  private async pollUpdates() {
    logger.info('Telegram DOCX upload bot started');

    try {
      await this.skipOldUpdates();
    } catch (error) {
      logger.warn('Failed to skip old Telegram updates before polling', {
        error,
      });
    }

    while (this.running) {
      try {
        const updates = await telegramService.getUpdates({
          offset: this.offset,
          timeoutSeconds: env.TELEGRAM_DOCX_POLL_TIMEOUT_SECONDS,
          allowedUpdates: ['message'],
        });

        for (const update of updates) {
          this.offset = Math.max(this.offset ?? 0, update.update_id + 1);
          void this.handleUpdate(update);
        }
      } catch (error) {
        logger.warn('Telegram DOCX upload polling failed. Retrying soon', {
          error,
        });
        await wait(5000);
      }
    }
  }

  private async skipOldUpdates() {
    const updates = await telegramService.getUpdates({
      timeoutSeconds: 1,
      allowedUpdates: ['message'],
    });
    const lastUpdate = updates.at(-1);

    if (lastUpdate) {
      this.offset = lastUpdate.update_id + 1;
      logger.info('Telegram DOCX upload bot skipped old updates', {
        skipped: updates.length,
        nextOffset: this.offset,
      });
    }
  }

  private async handleUpdate(update: TelegramUpdate) {
    const message = update.message;

    if (!message) {
      return;
    }

    if (String(message.chat.id) !== env.TELEGRAM_CHAT_ID) {
      logger.warn('Ignoring Telegram update from unauthorized chat', {
        chatId: message.chat.id,
      });
      return;
    }

    if (message.text?.startsWith('/start') || message.text?.startsWith('/help')) {
      await telegramService.sendMessage(this.helpText());
      return;
    }

    if (!message.document) {
      return;
    }

    if (!this.isDocxDocument(message.document)) {
      await telegramService.sendMessage(
        'Bot hien chi nhan file .docx. Hay gui sach dang .docx de minh chuyen sang MP3.'
      );
      return;
    }

    this.enqueueDocument(message.document, message.caption);
  }

  private enqueueDocument(document: TelegramDocument, caption?: string) {
    const job = this.queue.then(() => this.processDocument(document, caption));

    this.queue = job.catch((error) => {
      logger.error('Telegram DOCX upload job failed', { error });
    });

    void job.catch((error) =>
      notifyTelegramSafely(
        () =>
          telegramService.sendMessage(
            [
              'DOCX -> MP3 qua Telegram bi loi.',
              '',
              `File: ${document.file_name ?? 'telegram-upload.docx'}`,
              `Loi: ${formatError(error)}`,
            ].join('\n')
          ),
        'Telegram DOCX upload failed'
      )
    );
  }

  private async processDocument(document: TelegramDocument, caption?: string) {
    const originalFileName = document.file_name ?? 'telegram-upload.docx';
    const maxBytes = env.DOCX_MAX_FILE_MB * 1024 * 1024;

    if (document.file_size && document.file_size > maxBytes) {
      throw new Error(
        `File qua lon: ${formatBytes(document.file_size)}. Gioi han hien tai la ${env.DOCX_MAX_FILE_MB} MB.`
      );
    }

    const options = this.parseCaption(caption);

    await telegramService.sendMessage(
      [
        'Da nhan file DOCX tu Telegram.',
        '',
        `File: ${originalFileName}`,
        document.file_size ? `Dung luong: ${formatBytes(document.file_size)}` : undefined,
        options.voice ? `Giong: ${options.voice}` : undefined,
        'Dang tai file va tao job...',
      ]
        .filter(Boolean)
        .join('\n')
    );

    const fileBuffer = await telegramService.downloadFile(document.file_id);

    if (fileBuffer.length > maxBytes) {
      throw new Error(
        `File qua lon: ${formatBytes(fileBuffer.length)}. Gioi han hien tai la ${env.DOCX_MAX_FILE_MB} MB.`
      );
    }

    const job = await docxSynthesisService.enqueueJob({
      fileBuffer,
      originalFileName,
      outputFileName: options.outputFileName,
      type: options.type,
      voice: options.voice,
      pitch: options.pitch,
      speed: options.speed,
      volume: options.volume,
    });

    await telegramService.sendMessage(
      [
        'Da tao job DOCX -> MP3.',
        '',
        `Job: ${job.jobId}`,
        `File MP3: ${job.fileName}`,
        `Tien do: ${formatProgress(job)}`,
        'Bot se gui file MP3 ve day khi chay xong.',
      ].join('\n')
    );

    await this.waitForCompletion(job.jobId);
  }

  private async waitForCompletion(jobId: string) {
    let lastReportedCompleted = -1;
    let lastReportedAt = 0;

    while (this.running) {
      const status = await docxSynthesisService.getJobStatus(jobId);

      if (!status) {
        throw new Error(`Khong tim thay job ${jobId}`);
      }

      if (status.status === 'failed') {
        throw new Error(status.errorMessage ?? `Job ${jobId} bi loi`);
      }

      if (status.status === 'completed' && status.downloadReady) {
        await this.sendCompletedFile(status);
        return;
      }

      const now = Date.now();
      const shouldReport =
        status.completedChunks !== lastReportedCompleted &&
        now - lastReportedAt >= env.TELEGRAM_DOCX_STATUS_INTERVAL_SECONDS * 1000;

      if (shouldReport) {
        lastReportedCompleted = status.completedChunks;
        lastReportedAt = now;
        await telegramService.sendMessage(
          [
            'DOCX -> MP3 dang chay.',
            '',
            `Job: ${status.jobId}`,
            `Tien do: ${formatProgress(status)}`,
          ].join('\n')
        );
      }

      await wait(5000);
    }
  }

  private async sendCompletedFile(status: SynthesizeDocxJobStatus) {
    const file = await docxSynthesisService.getCompletedJobFile(status.jobId);

    if (!file) {
      throw new Error(`Job ${status.jobId} da xong nhung khong thay file MP3`);
    }

    try {
      await telegramService.sendDocumentFile(
        file.filePath,
        file.fileName,
        [
          'MP3 da xong.',
          `File: ${file.fileName}`,
          `Job: ${status.jobId}`,
          `Dung luong: ${formatBytes(Number(file.contentLength))}`,
        ].join('\n')
      );
    } catch (error) {
      logger.warn('Telegram DOCX MP3 file delivery failed', {
        jobId: status.jobId,
        error,
      });
      await telegramService.sendMessage(
        [
          'MP3 da xong nhung Telegram khong nhan file.',
          '',
          `File: ${file.fileName}`,
          `Job: ${status.jobId}`,
          `Dung luong: ${formatBytes(Number(file.contentLength))}`,
          `Loi gui file: ${formatError(error)}`,
        ].join('\n')
      );
    }
  }

  private parseCaption(caption?: string): TelegramDocxOptions {
    const options: TelegramDocxOptions = {
      type: env.TELEGRAM_DOCX_DEFAULT_TYPE,
      voice: env.TELEGRAM_DOCX_DEFAULT_VOICE,
      pitch: 10,
      speed: 10,
      volume: 10,
    };
    const text = caption?.trim();

    if (!text) {
      return options;
    }

    if (!/[=:]/.test(text) && !text.startsWith('/')) {
      return {
        ...options,
        voice: text,
      };
    }

    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([\w-]+)\s*[:=]\s*(.+?)\s*$/);

      if (!match) {
        continue;
      }

      const key = match[1].toLowerCase();
      const value = match[2].trim();

      if (['voice', 'giong', 'giọng'].includes(key)) {
        options.voice = value;
      } else if (key === 'type') {
        options.type = parseType(value);
      } else if (['filename', 'file', 'name'].includes(key)) {
        options.outputFileName = value;
      } else if (key === 'pitch') {
        options.pitch = parseInteger(value, options.pitch);
      } else if (key === 'speed') {
        options.speed = parseInteger(value, options.speed);
      } else if (key === 'volume') {
        options.volume = parseInteger(value, options.volume);
      }
    }

    return options;
  }

  private isDocxDocument(document: TelegramDocument) {
    const fileName = document.file_name?.toLowerCase() ?? '';

    return (
      fileName.endsWith('.docx') ||
      document.mime_type ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
  }

  private helpText() {
    return [
      'Gui file .docx vao bot nay, minh se chuyen sang MP3 va gui file ve lai Telegram.',
      '',
      `Giong mac dinh: ${env.TELEGRAM_DOCX_DEFAULT_VOICE ?? 'mac dinh he thong'}`,
      `Gioi han DOCX: ${env.DOCX_MAX_FILE_MB} MB.`,
      '',
      'Co the them caption de doi giong:',
      'voice=chi mai',
      'speed=10',
      'volume=10',
      'filename=ten-file.mp3',
    ].join('\n');
  }
}

const parseType = (value: string) => {
  const numericValue = Number(value);

  return Number.isInteger(numericValue) ? numericValue : value;
};

const parseInteger = (value: string, fallback: number) => {
  const numericValue = Number(value);

  return Number.isInteger(numericValue) ? numericValue : fallback;
};

const formatProgress = (status: SynthesizeDocxJobStatus) =>
  `${formatNumber(status.completedChunks)}/${formatNumber(
    status.totalChunks
  )} chunk (${Math.round(status.progress * 1000) / 10}%)`;

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

const formatError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export const telegramDocxBotService = new TelegramDocxBotService();

export const startTelegramDocxBotTask = () => {
  telegramDocxBotService.start();
};
