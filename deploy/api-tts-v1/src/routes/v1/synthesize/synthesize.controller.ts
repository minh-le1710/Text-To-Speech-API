import type { Request, Response } from 'express';
import { SynthesizeQuerySchema } from '@/schemas/synthesize';
import { SynthesizeDocxBodySchema } from '@/schemas/synthesizeDocx';
import capCutService from '@/services/CapCutService';
import {
  docxSynthesisService,
  type SynthesizeDocxJobStatus,
} from '@/services/DocxSynthesisService';
import logger from '@/services/logger';

/**
 * 音声合成エンドポイント
 */
export const synthesize = async (req: Request, res: Response) => {
  const synthesizeQueryValidation = SynthesizeQuerySchema.safeParse(req.query);

  if (!synthesizeQueryValidation.success) {
    res.status(400).json({
      error: 'Validation Error',
      details: synthesizeQueryValidation.error.issues,
    });
    return;
  }

  const synthesizeQuery = synthesizeQueryValidation.data;

  if (synthesizeQuery.method === 'stream') {
    try {
      const audioStream = await capCutService.synthesizeStream(synthesizeQuery);

      audioStream.stream.on('error', (error) => {
        logger.error('Failed to synthesize audio stream', error);

        if (!res.headersSent) {
          res.status(502).json({ error: 'Failed to synthesize audio' });
          return;
        }

        res.end();
      });

      res.on('close', () => {
        if (!audioStream.stream.destroyed) {
          audioStream.stream.destroy();
        }
      });

      if (audioStream.contentLength) {
        res.setHeader('Content-Length', audioStream.contentLength);
      }

      if (audioStream.fileName) {
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${audioStream.fileName}"`
        );
      }

      res.status(200);
      res.type(audioStream.contentType);
      audioStream.stream.pipe(res);
      return;
    } catch (error) {
      logger.error('Failed to synthesize audio stream', error);
      res.status(502).json({ error: 'Failed to synthesize audio' });
      return;
    }
  }

  try {
    const audioResult = await capCutService.synthesizeBuffer(synthesizeQuery);

    if (audioResult.contentLength) {
      res.setHeader('Content-Length', audioResult.contentLength);
    }

    if (audioResult.fileName) {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${audioResult.fileName}"`
      );
    }

    res.type(audioResult.contentType).status(200).end(audioResult.buffer);
  } catch (error) {
    logger.error('Failed to synthesize audio', error);
    res.status(502).json({ error: 'Failed to synthesize audio' });
  }
};

export const synthesizeDocx = async (req: Request, res: Response) => {
  const synthesizeBodyValidation = SynthesizeDocxBodySchema.safeParse(req.body);

  if (!synthesizeBodyValidation.success) {
    res.status(400).json({
      error: 'Validation Error',
      details: synthesizeBodyValidation.error.issues,
    });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: 'file is required' });
    return;
  }

  try {
    const audioResult = await docxSynthesisService.synthesizeToFile({
      fileBuffer: req.file.buffer,
      originalFileName: req.file.originalname,
      outputFileName: synthesizeBodyValidation.data.filename,
      type: synthesizeBodyValidation.data.type,
      voice: synthesizeBodyValidation.data.voice,
      pitch: synthesizeBodyValidation.data.pitch,
      speed: synthesizeBodyValidation.data.speed,
      volume: synthesizeBodyValidation.data.volume,
    });

    res.setHeader('Content-Length', audioResult.contentLength);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${audioResult.fileName}"`
    );
    res.setHeader('X-CapCut-TTS-Job-Id', audioResult.jobId);
    res.setHeader(
      'X-CapCut-TTS-Total-Chunks',
      String(audioResult.totalChunks)
    );
    res.setHeader(
      'X-CapCut-TTS-Completed-Chunks',
      String(audioResult.completedChunks)
    );
    res.setHeader(
      'X-CapCut-TTS-Resumed-Chunks',
      String(audioResult.resumedChunks)
    );

    res.type(audioResult.contentType).status(200);
    res.sendFile(audioResult.filePath, (error) => {
      if (!error) {
        return;
      }

      logger.error('Failed to send DOCX audio file', error);

      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to send DOCX audio file' });
      }
    });
  } catch (error) {
    logger.error('Failed to synthesize DOCX audio', error);

    if (
      error instanceof Error &&
      [
        'Only .docx files are supported',
        'The uploaded .docx file did not contain readable text',
        'No readable text was found in the uploaded .docx file',
      ].includes(error.message)
    ) {
      res.status(400).json({ error: error.message });
      return;
    }

    res.status(502).json({ error: 'Failed to synthesize DOCX audio' });
  }
};

export const createSynthesizeDocxJob = async (
  req: Request,
  res: Response
) => {
  const synthesizeBodyValidation = SynthesizeDocxBodySchema.safeParse(req.body);

  if (!synthesizeBodyValidation.success) {
    res.status(400).json({
      error: 'Validation Error',
      details: synthesizeBodyValidation.error.issues,
    });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: 'file is required' });
    return;
  }

  try {
    const job = await docxSynthesisService.enqueueJob({
      fileBuffer: req.file.buffer,
      originalFileName: req.file.originalname,
      outputFileName: synthesizeBodyValidation.data.filename,
      type: synthesizeBodyValidation.data.type,
      voice: synthesizeBodyValidation.data.voice,
      pitch: synthesizeBodyValidation.data.pitch,
      speed: synthesizeBodyValidation.data.speed,
      volume: synthesizeBodyValidation.data.volume,
    });

    res
      .status(job.status === 'completed' ? 200 : 202)
      .json(toDocxJobResponse(job));
  } catch (error) {
    logger.error('Failed to create DOCX synthesis job', error);

    if (isDocxClientError(error)) {
      res.status(400).json({ error: error.message });
      return;
    }

    res.status(502).json({ error: 'Failed to create DOCX synthesis job' });
  }
};

export const getSynthesizeDocxJob = async (req: Request, res: Response) => {
  const jobId = getJobIdParam(req);

  if (!isValidJobId(jobId)) {
    res.status(400).json({ error: 'Invalid job id' });
    return;
  }

  const job = await docxSynthesisService.getJobStatus(jobId);

  if (!job) {
    res.status(404).json({ error: 'DOCX synthesis job was not found' });
    return;
  }

  res.status(200).json(toDocxJobResponse(job));
};

export const resumeSynthesizeDocxJob = async (
  req: Request,
  res: Response
) => {
  const jobId = getJobIdParam(req);

  if (!isValidJobId(jobId)) {
    res.status(400).json({ error: 'Invalid job id' });
    return;
  }

  try {
    const job = await docxSynthesisService.resumeJob(jobId);

    if (!job) {
      res.status(404).json({ error: 'DOCX synthesis job was not found' });
      return;
    }

    res
      .status(job.status === 'completed' ? 200 : 202)
      .json(toDocxJobResponse(job));
  } catch (error) {
    logger.error('Failed to resume DOCX synthesis job', error);
    res.status(409).json({
      error: error instanceof Error ? error.message : 'Failed to resume job',
    });
  }
};

export const downloadSynthesizeDocxJob = async (
  req: Request,
  res: Response
) => {
  const jobId = getJobIdParam(req);

  if (!isValidJobId(jobId)) {
    res.status(400).json({ error: 'Invalid job id' });
    return;
  }

  const job = await docxSynthesisService.getJobStatus(jobId);

  if (!job) {
    res.status(404).json({ error: 'DOCX synthesis job was not found' });
    return;
  }

  if (!job.downloadReady) {
    res.status(409).json({
      error: 'DOCX synthesis job is not ready for download',
      job: toDocxJobResponse(job),
    });
    return;
  }

  const audioResult = await docxSynthesisService.getCompletedJobFile(jobId);

  if (!audioResult) {
    res.status(409).json({
      error: 'DOCX synthesis job output is not available',
      job: toDocxJobResponse(job),
    });
    return;
  }

  res.setHeader('Content-Length', audioResult.contentLength);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${audioResult.fileName}"`
  );

  res.type(audioResult.contentType).status(200);
  res.sendFile(audioResult.filePath, (error) => {
    if (!error) {
      return;
    }

    logger.error('Failed to send DOCX job audio file', error);

    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to send DOCX job audio file' });
    }
  });
};

const isDocxClientError = (error: unknown): error is Error =>
  error instanceof Error &&
  [
    'Only .docx files are supported',
    'The uploaded .docx file did not contain readable text',
    'No readable text was found in the uploaded .docx file',
  ].includes(error.message);

const isValidJobId = (jobId: string | undefined) =>
  Boolean(jobId && /^[a-f0-9]{32}$/i.test(jobId));

const getJobIdParam = (req: Request) => {
  const value = req.params.jobId;
  return Array.isArray(value) ? value[0] : value;
};

const toDocxJobResponse = (job: SynthesizeDocxJobStatus) => ({
  jobId: job.jobId,
  status: job.status,
  fileName: job.fileName,
  totalChunks: job.totalChunks,
  completedChunks: job.completedChunks,
  progress: job.progress,
  progressPercent: Math.round(job.progress * 10000) / 100,
  active: job.active,
  downloadReady: job.downloadReady,
  contentType: job.contentType,
  contentLength: job.contentLength,
  errorMessage: job.errorMessage,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  completedAt: job.completedAt,
  statusUrl: `/v1/synthesize/docx/jobs/${job.jobId}`,
  downloadUrl: `/v1/synthesize/docx/jobs/${job.jobId}/download`,
  resumeUrl: `/v1/synthesize/docx/jobs/${job.jobId}/resume`,
});
