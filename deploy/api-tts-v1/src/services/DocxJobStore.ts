import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import env from '@/configs/env';

export type DocxJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface DocxJobRecord {
  id: string;
  sourceHash: string;
  originalFileName?: string;
  outputFileName: string;
  type: string;
  voice?: string;
  pitch: number;
  speed: number;
  volume: number;
  maxCharsPerChunk: number;
  totalChunks: number;
  completedChunks: number;
  status: DocxJobStatus;
  contentType: string;
  jobDir: string;
  finalFilePath: string;
  finalByteLength?: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface DocxChunkRecord {
  jobId: string;
  chunkIndex: number;
  textHash: string;
  textLength: number;
  status: DocxJobStatus;
  audioPath: string;
  byteLength?: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertDocxJobInput {
  id: string;
  sourceHash: string;
  originalFileName?: string;
  outputFileName: string;
  type: number | string;
  voice?: string;
  pitch: number;
  speed: number;
  volume: number;
  maxCharsPerChunk: number;
  totalChunks: number;
  contentType: string;
  jobDir: string;
  finalFilePath: string;
}

export interface UpsertDocxChunkInput {
  chunkIndex: number;
  textHash: string;
  textLength: number;
  audioPath: string;
}

const toOptionalString = (value: unknown) =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const toNumber = (value: unknown) => Number(value ?? 0);

const toJobRecord = (row: Record<string, unknown>): DocxJobRecord => ({
  id: String(row.id),
  sourceHash: String(row.source_hash),
  originalFileName: toOptionalString(row.original_file_name),
  outputFileName: String(row.output_file_name),
  type: String(row.type),
  voice: toOptionalString(row.voice),
  pitch: toNumber(row.pitch),
  speed: toNumber(row.speed),
  volume: toNumber(row.volume),
  maxCharsPerChunk: toNumber(row.max_chars_per_chunk),
  totalChunks: toNumber(row.total_chunks),
  completedChunks: toNumber(row.completed_chunks),
  status: String(row.status) as DocxJobStatus,
  contentType: String(row.content_type),
  jobDir: String(row.job_dir),
  finalFilePath: String(row.final_file_path),
  finalByteLength:
    row.final_byte_length === null || row.final_byte_length === undefined
      ? undefined
      : toNumber(row.final_byte_length),
  errorMessage: toOptionalString(row.error_message),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  completedAt: toOptionalString(row.completed_at),
});

const toChunkRecord = (row: Record<string, unknown>): DocxChunkRecord => ({
  jobId: String(row.job_id),
  chunkIndex: toNumber(row.chunk_index),
  textHash: String(row.text_hash),
  textLength: toNumber(row.text_length),
  status: String(row.status) as DocxJobStatus,
  audioPath: String(row.audio_path),
  byteLength:
    row.byte_length === null || row.byte_length === undefined
      ? undefined
      : toNumber(row.byte_length),
  errorMessage: toOptionalString(row.error_message),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

class DocxJobStore {
  private readonly dbPath = path.resolve(process.cwd(), env.DOCX_JOB_DB_PATH);

  private database?: DatabaseSync;

  upsertJob(input: UpsertDocxJobInput) {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        INSERT INTO docx_jobs (
          id,
          source_hash,
          original_file_name,
          output_file_name,
          type,
          voice,
          pitch,
          speed,
          volume,
          max_chars_per_chunk,
          total_chunks,
          completed_chunks,
          status,
          content_type,
          job_dir,
          final_file_path,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_hash = excluded.source_hash,
          original_file_name = excluded.original_file_name,
          output_file_name = excluded.output_file_name,
          type = excluded.type,
          voice = excluded.voice,
          pitch = excluded.pitch,
          speed = excluded.speed,
          volume = excluded.volume,
          max_chars_per_chunk = excluded.max_chars_per_chunk,
          total_chunks = excluded.total_chunks,
          content_type = COALESCE(NULLIF(docx_jobs.content_type, ''), excluded.content_type),
          job_dir = excluded.job_dir,
          final_file_path = excluded.final_file_path,
          status = CASE
            WHEN docx_jobs.status = 'completed' THEN docx_jobs.status
            ELSE excluded.status
          END,
          error_message = CASE
            WHEN docx_jobs.status = 'completed' THEN docx_jobs.error_message
            ELSE NULL
          END,
          completed_at = CASE
            WHEN docx_jobs.status = 'completed' THEN docx_jobs.completed_at
            ELSE NULL
          END,
          updated_at = excluded.updated_at
        `
      )
      .run(
        input.id,
        input.sourceHash,
        input.originalFileName ?? null,
        input.outputFileName,
        String(input.type),
        input.voice ?? null,
        input.pitch,
        input.speed,
        input.volume,
        input.maxCharsPerChunk,
        input.totalChunks,
        input.contentType,
        input.jobDir,
        input.finalFilePath,
        now,
        now
      );
  }

  upsertChunks(jobId: string, chunks: UpsertDocxChunkInput[]) {
    const now = new Date().toISOString();

    this.transaction(() => {
      const statement = this.db.prepare(
        `
        INSERT INTO docx_chunks (
          job_id,
          chunk_index,
          text_hash,
          text_length,
          status,
          audio_path,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
        ON CONFLICT(job_id, chunk_index) DO UPDATE SET
          text_hash = excluded.text_hash,
          text_length = excluded.text_length,
          audio_path = excluded.audio_path,
          status = CASE
            WHEN docx_chunks.status = 'completed'
              AND docx_chunks.text_hash = excluded.text_hash
            THEN docx_chunks.status
            ELSE 'pending'
          END,
          byte_length = CASE
            WHEN docx_chunks.status = 'completed'
              AND docx_chunks.text_hash = excluded.text_hash
            THEN docx_chunks.byte_length
            ELSE NULL
          END,
          error_message = CASE
            WHEN docx_chunks.status = 'completed'
              AND docx_chunks.text_hash = excluded.text_hash
            THEN docx_chunks.error_message
            ELSE NULL
          END,
          updated_at = excluded.updated_at
        `
      );

      for (const chunk of chunks) {
        statement.run(
          jobId,
          chunk.chunkIndex,
          chunk.textHash,
          chunk.textLength,
          chunk.audioPath,
          now,
          now
        );
      }
    });

    this.refreshJobProgress(jobId);
  }

  getJob(jobId: string) {
    const row = this.db
      .prepare('SELECT * FROM docx_jobs WHERE id = ?')
      .get(jobId);

    return row ? toJobRecord(row) : undefined;
  }

  getChunks(jobId: string) {
    return this.db
      .prepare(
        'SELECT * FROM docx_chunks WHERE job_id = ? ORDER BY chunk_index ASC'
      )
      .all(jobId)
      .map(toChunkRecord);
  }

  markJobRunning(jobId: string) {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        UPDATE docx_jobs
        SET status = 'running',
            error_message = NULL,
            updated_at = ?
        WHERE id = ?
        `
      )
      .run(now, jobId);
  }

  markJobCompleted(
    jobId: string,
    contentType: string,
    finalFilePath: string,
    finalByteLength: number
  ) {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        UPDATE docx_jobs
        SET status = 'completed',
            completed_chunks = total_chunks,
            content_type = ?,
            final_file_path = ?,
            final_byte_length = ?,
            error_message = NULL,
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
        `
      )
      .run(contentType, finalFilePath, finalByteLength, now, now, jobId);
  }

  markJobFailed(jobId: string, errorMessage: string) {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        UPDATE docx_jobs
        SET status = 'failed',
            completed_chunks = (
              SELECT COUNT(*)
              FROM docx_chunks
              WHERE job_id = ? AND status = 'completed'
            ),
            error_message = ?,
            updated_at = ?
        WHERE id = ?
        `
      )
      .run(jobId, errorMessage, now, jobId);
  }

  markChunkRunning(jobId: string, chunkIndex: number) {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        UPDATE docx_chunks
        SET status = 'running',
            error_message = NULL,
            updated_at = ?
        WHERE job_id = ? AND chunk_index = ?
        `
      )
      .run(now, jobId, chunkIndex);
  }

  markChunkPending(jobId: string, chunkIndex: number, reason: string) {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        UPDATE docx_chunks
        SET status = 'pending',
            byte_length = NULL,
            error_message = ?,
            updated_at = ?
        WHERE job_id = ? AND chunk_index = ?
        `
      )
      .run(reason, now, jobId, chunkIndex);

    this.refreshJobProgress(jobId);
  }

  markChunkCompleted(jobId: string, chunkIndex: number, byteLength: number) {
    const now = new Date().toISOString();

    this.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE docx_chunks
          SET status = 'completed',
              byte_length = ?,
              error_message = NULL,
              updated_at = ?
          WHERE job_id = ? AND chunk_index = ?
          `
        )
        .run(byteLength, now, jobId, chunkIndex);

      this.db
        .prepare(
          `
          UPDATE docx_jobs
          SET completed_chunks = (
                SELECT COUNT(*)
                FROM docx_chunks
                WHERE job_id = ? AND status = 'completed'
              ),
              updated_at = ?
          WHERE id = ?
          `
        )
        .run(jobId, now, jobId);
    });
  }

  markChunkFailed(jobId: string, chunkIndex: number, errorMessage: string) {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        UPDATE docx_chunks
        SET status = 'failed',
            error_message = ?,
            updated_at = ?
        WHERE job_id = ? AND chunk_index = ?
        `
      )
      .run(errorMessage, now, jobId, chunkIndex);

    this.refreshJobProgress(jobId);
  }

  refreshJobProgress(jobId: string) {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        UPDATE docx_jobs
        SET completed_chunks = (
              SELECT COUNT(*)
              FROM docx_chunks
              WHERE job_id = ? AND status = 'completed'
            ),
            updated_at = ?
        WHERE id = ?
        `
      )
      .run(jobId, now, jobId);
  }

  private get db() {
    if (!this.database) {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      this.database = new DatabaseSync(this.dbPath);
      this.database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS docx_jobs (
          id TEXT PRIMARY KEY,
          source_hash TEXT NOT NULL,
          original_file_name TEXT,
          output_file_name TEXT NOT NULL,
          type TEXT NOT NULL,
          voice TEXT,
          pitch INTEGER NOT NULL,
          speed INTEGER NOT NULL,
          volume INTEGER NOT NULL,
          max_chars_per_chunk INTEGER NOT NULL,
          total_chunks INTEGER NOT NULL,
          completed_chunks INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          content_type TEXT NOT NULL,
          job_dir TEXT NOT NULL,
          final_file_path TEXT NOT NULL,
          final_byte_length INTEGER,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS docx_chunks (
          job_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          text_hash TEXT NOT NULL,
          text_length INTEGER NOT NULL,
          status TEXT NOT NULL,
          audio_path TEXT NOT NULL,
          byte_length INTEGER,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (job_id, chunk_index),
          FOREIGN KEY (job_id) REFERENCES docx_jobs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_docx_chunks_status
          ON docx_chunks(job_id, status);

        CREATE INDEX IF NOT EXISTS idx_docx_jobs_status
          ON docx_jobs(status);
      `);
    }

    return this.database;
  }

  private transaction<T>(callback: () => T) {
    this.db.exec('BEGIN IMMEDIATE');

    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

export const docxJobStore = new DocxJobStore();
