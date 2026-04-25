import { Router } from 'express';
import multer from 'multer';
import env from '@/configs/env';
import {
  createSynthesizeDocxJob,
  downloadSynthesizeDocxJob,
  getSynthesizeDocxJob,
  resumeSynthesizeDocxJob,
  synthesize,
  synthesizeDocx,
} from '@/routes/v1/synthesize/synthesize.controller';

const synthesizeRouter = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.DOCX_MAX_FILE_MB * 1024 * 1024,
  },
});

synthesizeRouter.get('/', synthesize);
synthesizeRouter.post('/docx', upload.single('file'), synthesizeDocx);
synthesizeRouter.post('/docx/jobs', upload.single('file'), createSynthesizeDocxJob);
synthesizeRouter.get('/docx/jobs/:jobId', getSynthesizeDocxJob);
synthesizeRouter.post('/docx/jobs/:jobId/resume', resumeSynthesizeDocxJob);
synthesizeRouter.get('/docx/jobs/:jobId/download', downloadSynthesizeDocxJob);

export default synthesizeRouter;
