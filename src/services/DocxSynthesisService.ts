import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import mammoth from 'mammoth';
import env from '@/configs/env';
import capCutService from '@/services/CapCutService';
import { docxJobStore } from '@/services/DocxJobStore';
import logger from '@/services/logger';
import telegramService, {
  notifyTelegramSafely,
} from '@/services/TelegramService';
import type { AudioResult, SynthesizeOptions } from '@/types/capcut';
import {
  normalizeText,
  sanitizeFileName,
  splitTextIntoChunks,
} from '@/utils/documentUtils';

export interface SynthesizeDocxOptions
  extends Omit<SynthesizeOptions, 'text'> {
  fileBuffer: Buffer;
  originalFileName?: string;
  outputFileName?: string;
}

export interface SynthesizeDocxFileResult {
  filePath: string;
  contentType: string;
  contentLength: string;
  fileName: string;
  jobId: string;
  totalChunks: number;
  completedChunks: number;
  resumedChunks: number;
}

export interface SynthesizeDocxJobStatus {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  fileName: string;
  totalChunks: number;
  completedChunks: number;
  progress: number;
  active: boolean;
  downloadReady: boolean;
  contentType: string;
  contentLength?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface SynthesizeDocxJobFile {
  filePath: string;
  contentType: string;
  contentLength: string;
  fileName: string;
}

interface PreparedDocxJob {
  jobId: string;
  sourceHash: string;
  outputFileName: string;
  jobDir: string;
  chunkDir: string;
  inputFilePath: string;
  finalFilePath: string;
  chunks: string[];
  wordCount: number;
  charCount: number;
}

class DocxSynthesisService {
  private readonly jobWorkdir = path.resolve(
    process.cwd(),
    env.DOCX_JOB_WORKDIR
  );

  private readonly activeJobs = new Map<
    string,
    Promise<SynthesizeDocxFileResult>
  >();

  async synthesizeBuffer(options: SynthesizeDocxOptions): Promise<AudioResult> {
    const fileResult = await this.synthesizeToFile(options);
    const buffer = await fs.readFile(fileResult.filePath);

    return {
      buffer,
      contentType: fileResult.contentType,
      contentLength: fileResult.contentLength,
      fileName: fileResult.fileName,
    };
  }

  async synthesizeToFile(
    options: SynthesizeDocxOptions
  ): Promise<SynthesizeDocxFileResult> {
    const preparedJob = await this.prepareDocxJob(options);

    const activeJob = this.activeJobs.get(preparedJob.jobId);

    if (activeJob) {
      return activeJob;
    }

    const jobPromise = this.runPreparedJob(options, preparedJob).finally(() => {
      this.activeJobs.delete(preparedJob.jobId);
    });

    this.activeJobs.set(preparedJob.jobId, jobPromise);

    return jobPromise;
  }

  async enqueueJob(
    options: SynthesizeDocxOptions
  ): Promise<SynthesizeDocxJobStatus> {
    const preparedJob = await this.prepareDocxJob(options);

    await this.initializePreparedJob(options, preparedJob);

    const status = await this.getJobStatus(preparedJob.jobId);

    if (!status) {
      throw new Error('DOCX job was not created');
    }

    if (status.status !== 'completed' || !status.downloadReady) {
      this.startBackgroundJob(options, preparedJob);
    }

    return status;
  }

  async resumeJob(jobId: string): Promise<SynthesizeDocxJobStatus | undefined> {
    const job = docxJobStore.getJob(jobId);

    if (!job) {
      return undefined;
    }

    if (this.activeJobs.has(jobId)) {
      return this.getJobStatus(jobId);
    }

    if (
      job.status === 'completed' &&
      (await this.isUsableFile(job.finalFilePath))
    ) {
      return this.getJobStatus(jobId);
    }

    const inputFilePath = this.resolveStoredInputPath(job.jobDir);

    if (!(await this.isUsableFile(inputFilePath))) {
      throw new Error(
        'Stored DOCX input is not available for this job. Upload the file again to resume.'
      );
    }

    const options: SynthesizeDocxOptions = {
      fileBuffer: await fs.readFile(inputFilePath),
      originalFileName: job.originalFileName,
      outputFileName: job.outputFileName,
      type: job.type,
      voice: job.voice,
      pitch: job.pitch,
      speed: job.speed,
      volume: job.volume,
    };
    const preparedJob = await this.prepareDocxJob(options);

    this.startBackgroundJob(options, preparedJob);

    return this.getJobStatus(jobId);
  }

  async getJobStatus(
    jobId: string
  ): Promise<SynthesizeDocxJobStatus | undefined> {
    const job = docxJobStore.getJob(jobId);

    if (!job) {
      return undefined;
    }

    const downloadReady =
      job.status === 'completed' && (await this.isUsableFile(job.finalFilePath));

    return {
      jobId: job.id,
      status: job.status,
      fileName: job.outputFileName,
      totalChunks: job.totalChunks,
      completedChunks: job.completedChunks,
      progress:
        job.totalChunks > 0 ? job.completedChunks / job.totalChunks : 0,
      active: this.activeJobs.has(job.id),
      downloadReady,
      contentType: job.contentType,
      contentLength:
        job.finalByteLength !== undefined
          ? String(job.finalByteLength)
          : undefined,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
    };
  }

  async getCompletedJobFile(
    jobId: string
  ): Promise<SynthesizeDocxJobFile | undefined> {
    const job = docxJobStore.getJob(jobId);

    if (!job) {
      return undefined;
    }

    if (
      job.status !== 'completed' ||
      !(await this.isUsableFile(job.finalFilePath))
    ) {
      return undefined;
    }

    const stat = await fs.stat(job.finalFilePath);

    return {
      filePath: job.finalFilePath,
      contentType: job.contentType,
      contentLength: String(stat.size),
      fileName: job.outputFileName,
    };
  }

  private async prepareDocxJob(
    options: SynthesizeDocxOptions
  ): Promise<PreparedDocxJob> {
    this.assertDocxFileName(options.originalFileName);

    const text = await this.extractText(options.fileBuffer);
    const chunks = splitTextIntoChunks(text, env.TTS_MAX_CHARS_PER_CHUNK);

    if (chunks.length === 0) {
      throw new Error('No readable text was found in the uploaded .docx file');
    }

    return this.prepareJob(options, text, chunks);
  }

  private startBackgroundJob(
    options: SynthesizeDocxOptions,
    preparedJob: PreparedDocxJob
  ) {
    if (this.activeJobs.has(preparedJob.jobId)) {
      return;
    }

    const jobPromise = this.runPreparedJob(options, preparedJob).finally(
      () => {
        this.activeJobs.delete(preparedJob.jobId);
      }
    );

    void jobPromise.catch((error) => {
      logger.error('Background DOCX synthesis job failed', {
        jobId: preparedJob.jobId,
        error,
      });
    });

    this.activeJobs.set(preparedJob.jobId, jobPromise);
  }

  private assertDocxFileName(originalFileName?: string) {
    if (
      originalFileName &&
      !originalFileName.toLowerCase().endsWith('.docx')
    ) {
      throw new Error('Only .docx files are supported');
    }
  }

  private async extractText(fileBuffer: Buffer) {
    const result = await mammoth.extractRawText({
      buffer: fileBuffer,
    });
    const text = normalizeText(result.value);

    if (!text) {
      throw new Error('The uploaded .docx file did not contain readable text');
    }

    return text;
  }

  private prepareJob(
    options: SynthesizeDocxOptions,
    text: string,
    chunks: string[]
  ): PreparedDocxJob {
    const outputFileName = this.resolveOutputFileName(
      options.originalFileName,
      options.outputFileName
    );
    const sourceHash = this.createHash(text);
    const jobHash = this.createHash(
      JSON.stringify({
        sourceHash,
        outputFileName,
        type: String(options.type),
        voice: options.voice ?? '',
        pitch: options.pitch,
        speed: options.speed,
        volume: options.volume,
        maxCharsPerChunk: env.TTS_MAX_CHARS_PER_CHUNK,
      })
    );
    const jobId = jobHash.slice(0, 32);
    const jobDir = path.join(this.jobWorkdir, jobId);

    return {
      jobId,
      sourceHash,
      outputFileName,
      jobDir,
      chunkDir: path.join(jobDir, 'chunks'),
      inputFilePath: this.resolveStoredInputPath(jobDir),
      finalFilePath: path.join(jobDir, 'output.mp3'),
      chunks,
      wordCount: countWords(text),
      charCount: text.length,
    };
  }

  private async runPreparedJob(
    options: SynthesizeDocxOptions,
    preparedJob: PreparedDocxJob
  ): Promise<SynthesizeDocxFileResult> {
    await this.initializePreparedJob(options, preparedJob);

    const existingJob = docxJobStore.getJob(preparedJob.jobId);

    if (
      existingJob?.status === 'completed' &&
      (await this.isUsableFile(preparedJob.finalFilePath))
    ) {
      logger.info('Reusing completed DOCX synthesis job', {
        jobId: preparedJob.jobId,
        filePath: preparedJob.finalFilePath,
      });

      const finalStat = await fs.stat(preparedJob.finalFilePath);
      await this.notifyCompleted(preparedJob, finalStat.size, 0);

      return this.toFileResult(preparedJob, existingJob.contentType, 0);
    }

    docxJobStore.markJobRunning(preparedJob.jobId);

    let contentType = existingJob?.contentType ?? 'audio/mpeg';
    let resumedChunks = 0;

    try {
      const chunkRecords = docxJobStore.getChunks(preparedJob.jobId);

      for (const chunkRecord of chunkRecords) {
        const expectedTextHash = this.createHash(
          preparedJob.chunks[chunkRecord.chunkIndex]
        );

        if (
          chunkRecord.status === 'completed' &&
          chunkRecord.textHash === expectedTextHash &&
          (await this.isUsableFile(chunkRecord.audioPath))
        ) {
          resumedChunks += 1;
          continue;
        }

        if (chunkRecord.status === 'completed') {
          docxJobStore.markChunkPending(
            preparedJob.jobId,
            chunkRecord.chunkIndex,
            'Completed checkpoint did not have a usable audio file'
          );
        }

        logger.info('Synthesizing DOCX chunk', {
          jobId: preparedJob.jobId,
          chunk: chunkRecord.chunkIndex + 1,
          totalChunks: preparedJob.chunks.length,
        });

        docxJobStore.markChunkRunning(
          preparedJob.jobId,
          chunkRecord.chunkIndex
        );

        try {
          const audio = await capCutService.synthesizeBuffer({
            text: preparedJob.chunks[chunkRecord.chunkIndex],
            type: options.type,
            voice: options.voice,
            pitch: options.pitch,
            speed: options.speed,
            volume: options.volume,
          });

          await this.writeChunkFile(chunkRecord.audioPath, audio.buffer);
          contentType = audio.contentType;
          docxJobStore.markChunkCompleted(
            preparedJob.jobId,
            chunkRecord.chunkIndex,
            audio.buffer.length
          );
        } catch (error) {
          const errorMessage = this.formatError(error);

          docxJobStore.markChunkFailed(
            preparedJob.jobId,
            chunkRecord.chunkIndex,
            errorMessage
          );
          throw new Error(
            `DOCX synthesis failed at chunk ${
              chunkRecord.chunkIndex + 1
            }/${preparedJob.chunks.length}: ${errorMessage}`
          );
        }
      }

      const chunkPaths = preparedJob.chunks.map((_, index) =>
        this.resolveChunkPath(preparedJob.chunkDir, index)
      );

      await this.concatAudioFiles(
        chunkPaths,
        preparedJob.finalFilePath,
        preparedJob.jobDir
      );

      const finalStat = await fs.stat(preparedJob.finalFilePath);
      docxJobStore.markJobCompleted(
        preparedJob.jobId,
        contentType,
        preparedJob.finalFilePath,
        finalStat.size
      );
      await this.notifyCompleted(preparedJob, finalStat.size, resumedChunks);

      return this.toFileResult(preparedJob, contentType, resumedChunks);
    } catch (error) {
      const errorMessage = this.formatError(error);

      docxJobStore.markJobFailed(preparedJob.jobId, errorMessage);
      await this.notifyFailed(preparedJob, errorMessage);
      throw error;
    }
  }

  private async initializePreparedJob(
    options: SynthesizeDocxOptions,
    preparedJob: PreparedDocxJob
  ) {
    await fs.mkdir(preparedJob.chunkDir, { recursive: true });
    await fs.writeFile(preparedJob.inputFilePath, options.fileBuffer);

    docxJobStore.upsertJob({
      id: preparedJob.jobId,
      sourceHash: preparedJob.sourceHash,
      originalFileName: options.originalFileName,
      outputFileName: preparedJob.outputFileName,
      type: options.type,
      voice: options.voice,
      pitch: options.pitch,
      speed: options.speed,
      volume: options.volume,
      maxCharsPerChunk: env.TTS_MAX_CHARS_PER_CHUNK,
      totalChunks: preparedJob.chunks.length,
      contentType: 'audio/mpeg',
      jobDir: preparedJob.jobDir,
      finalFilePath: preparedJob.finalFilePath,
    });

    docxJobStore.upsertChunks(
      preparedJob.jobId,
      preparedJob.chunks.map((chunk, index) => ({
        chunkIndex: index,
        textHash: this.createHash(chunk),
        textLength: chunk.length,
        audioPath: this.resolveChunkPath(preparedJob.chunkDir, index),
      }))
    );
  }

  private resolveOutputFileName(
    originalFileName?: string,
    outputFileName?: string
  ) {
    const preferredName = outputFileName?.trim()
      ? outputFileName.trim()
      : originalFileName
        ? path.basename(originalFileName, path.extname(originalFileName))
        : 'output';
    const sanitizedBase = sanitizeFileName(preferredName.replace(/\.mp3$/i, ''));
    const fileName = sanitizedBase || 'output';

    return `${fileName}.mp3`;
  }

  private async concatAudioFiles(
    chunkPaths: string[],
    outputPath: string,
    workingDirectory: string
  ) {
    if (chunkPaths.length === 0) {
      throw new Error('No audio chunks were generated');
    }

    if (chunkPaths.length === 1) {
      await fs.copyFile(chunkPaths[0], outputPath);
      return;
    }

    if (!ffmpegPath) {
      throw new Error('ffmpeg-static is not available');
    }

    const concatListPath = path.join(workingDirectory, 'concat-list.txt');
    const fileList = chunkPaths
      .map((chunkPath) => {
        const normalizedPath = chunkPath
          .replace(/\\/g, '/')
          .replace(/'/g, "'\\''");
        return `file '${normalizedPath}'`;
      })
      .join('\n');

    await fs.writeFile(concatListPath, fileList, 'utf8');

    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn(
        String(ffmpegPath),
        [
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          concatListPath,
          '-c',
          'copy',
          outputPath,
        ],
        {
          windowsHide: true,
        }
      ) as ChildProcessWithoutNullStreams;
      let stderr = '';

      ffmpeg.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      ffmpeg.on('error', reject);
      ffmpeg.on('close', (code: number | null) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
      });
    });
  }

  private resolveChunkPath(chunkDir: string, index: number) {
    return path.join(
      chunkDir,
      `${String(index + 1).padStart(6, '0')}.mp3.tmp`
    );
  }

  private resolveStoredInputPath(jobDir: string) {
    return path.join(jobDir, 'input.docx');
  }

  private async writeChunkFile(filePath: string, buffer: Buffer) {
    const partialPath = `${filePath}.part`;

    await fs.writeFile(partialPath, buffer);
    await fs.rename(partialPath, filePath);
  }

  private async isUsableFile(filePath: string) {
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  private async toFileResult(
    preparedJob: PreparedDocxJob,
    contentType: string,
    resumedChunks: number
  ): Promise<SynthesizeDocxFileResult> {
    const stat = await fs.stat(preparedJob.finalFilePath);
    const job = docxJobStore.getJob(preparedJob.jobId);

    return {
      filePath: preparedJob.finalFilePath,
      contentType,
      contentLength: String(stat.size),
      fileName: preparedJob.outputFileName,
      jobId: preparedJob.jobId,
      totalChunks: preparedJob.chunks.length,
      completedChunks: job?.completedChunks ?? preparedJob.chunks.length,
      resumedChunks,
    };
  }

  private async notifyCompleted(
    preparedJob: PreparedDocxJob,
    finalByteLength: number,
    resumedChunks: number
  ) {
    const job = docxJobStore.getJob(preparedJob.jobId);
    const duration = await this.probeAudioDuration(preparedJob.finalFilePath);

    await notifyTelegramSafely(
      () =>
        telegramService.sendDocxCompleted({
          fileName: preparedJob.outputFileName,
          wordCount: preparedJob.wordCount,
          charCount: preparedJob.charCount,
          totalChunks: preparedJob.chunks.length,
          completedChunks: job?.completedChunks ?? preparedJob.chunks.length,
          resumedChunks,
          duration,
          byteLength: finalByteLength,
          jobId: preparedJob.jobId,
        }),
      'DOCX synthesis completed'
    );
  }

  private async notifyFailed(preparedJob: PreparedDocxJob, errorMessage: string) {
    const job = docxJobStore.getJob(preparedJob.jobId);

    await notifyTelegramSafely(
      () =>
        telegramService.sendDocxFailed({
          fileName: preparedJob.outputFileName,
          jobId: preparedJob.jobId,
          completedChunks: job?.completedChunks,
          totalChunks: preparedJob.chunks.length,
          errorMessage,
        }),
      'DOCX synthesis failed'
    );
  }

  private async probeAudioDuration(filePath: string) {
    if (!ffmpegPath) {
      return undefined;
    }

    return new Promise<string | undefined>((resolve) => {
      const ffmpeg = spawn(String(ffmpegPath), ['-hide_banner', '-i', filePath], {
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
      let stderr = '';

      ffmpeg.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      ffmpeg.on('error', () => resolve(undefined));
      ffmpeg.on('close', () => {
        resolve(stderr.match(/Duration:\s*([^,]+)/)?.[1]?.trim());
      });
    });
  }

  private createHash(value: string) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private formatError(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

export const docxSynthesisService = new DocxSynthesisService();
