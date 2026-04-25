import cors from 'cors';
import express from 'express';
import env from '@/configs/env';
import { loggerMiddleware } from '@/middleware/logger';
import router from '@/routes';

const app = express();

app.use(cors({ origin: env.CORS_POLICY_ORIGIN }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(loggerMiddleware);
app.use('/', router);

export default app;
