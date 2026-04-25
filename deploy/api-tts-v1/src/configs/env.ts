import 'dotenv/config';
import { z } from 'zod';

const defaultUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const booleanFlag = z.preprocess(
  (value) => {
    if (value === undefined) {
      return 'true';
    }

    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }

    return String(value).toLowerCase();
  },
  z.enum(['true', 'false']).transform((value) => value === 'true')
);

const logLevelSchema = z
  .enum(['silly', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'])
  .default('info');

const optionalText = (schema: z.ZodString) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    schema.optional()
  );

const optionalBooleanFlag = (defaultValue: boolean) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === '') {
        return defaultValue ? 'true' : 'false';
      }

      if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
      }

      return String(value).toLowerCase();
    },
    z.enum(['true', 'false']).transform((value) => value === 'true')
  );

const envSchema = z
  .object({
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(8080),
    CORS_POLICY_ORIGIN: z.string().optional(),
    ORIGIN: z.string().optional(),
    CAPCUT_WEB_URL: z.string().url().default('https://www.capcut.com'),
    CAPCUT_EDIT_API_URL: z
      .string()
      .url()
      .default('https://edit-api-sg.capcut.com'),
    CAPCUT_LOGIN_HOST: z
      .string()
      .url()
      .default('https://login-row.www.capcut.com'),
    CAPCUT_FALLBACK_LOGIN_HOST: z
      .string()
      .url()
      .default('https://login.us.capcut.com'),
    CAPCUT_EMAIL: optionalText(
      z.string().email('CAPCUT_EMAIL must be a valid email')
    ),
    CAPCUT_PASSWORD: optionalText(
      z.string().min(1, 'CAPCUT_PASSWORD is required')
    ),
    CAPCUT_LOCALE: z.string().min(1).default('ja-JP'),
    CAPCUT_PAGE_LOCALE: z.string().min(1).default('ja-jp'),
    CAPCUT_REGION: z.string().min(1).default('JP'),
    CAPCUT_STORE_COUNTRY_CODE: z.string().min(1).default('jp'),
    CAPCUT_REGION_FALLBACK_ENABLED: optionalBooleanFlag(true),
    CAPCUT_FALLBACK_LOCALE: z.string().min(1).default('nl-NL'),
    CAPCUT_FALLBACK_PAGE_LOCALE: z.string().min(1).default('nl-nl'),
    CAPCUT_FALLBACK_REGION: z.string().min(1).default('NL'),
    CAPCUT_FALLBACK_STORE_COUNTRY_CODE: z.string().min(1).default('nl'),
    CAPCUT_DEVICE_ID: z.string().min(1).optional(),
    CAPCUT_TDID: z.string().min(1).optional(),
    CAPCUT_VERIFY_FP: z.string().min(1).optional(),
    CAPCUT_BUNDLE_CONFIG_PATH: z
      .string()
      .min(1)
      .default('data/capcut-bundle-config.json'),
    CAPCUT_VOICE_CATEGORY_ID: z.coerce.number().int().positive().default(21699),
    CAPCUT_SESSION_STORE_PATH: z
      .string()
      .min(1)
      .default('data/capcut-session.json'),
    LEGACY_CAPCUT_API_URL: z
      .string()
      .url()
      .default('https://edit-api-sg.capcut.com/lv/v1'),
    LEGACY_BYTEINTL_API_URL: z
      .string()
      .url()
      .default('wss://sami-sg1.byteintlapi.com/internal/api/v1'),
    LEGACY_DEVICE_TIME: z.string().min(1).optional(),
    LEGACY_SIGN: z.string().min(1).optional(),
    LEGACY_TOKEN_INTERVAL: z.coerce.number().positive().default(6),
    USER_AGENT: z.string().min(1).default(defaultUserAgent),
    LOG_LEVEL: logLevelSchema,
    ERROR_HANDLE: booleanFlag,
    SESSION_REFRESH_INTERVAL_MINUTES: z.coerce.number().positive().default(10),
    DOCX_MAX_FILE_MB: z.coerce.number().positive().default(100),
    TTS_MAX_CHARS_PER_CHUNK: z.coerce.number().int().positive().default(320),
    DOCX_JOB_DB_PATH: z.string().min(1).default('data/docx-jobs.sqlite'),
    DOCX_JOB_WORKDIR: z.string().min(1).default('data/docx-jobs'),
    TELEGRAM_BOT_TOKEN: optionalText(z.string().min(1)),
    TELEGRAM_CHAT_ID: optionalText(z.string().min(1)),
    TELEGRAM_QR_LOGIN_ENABLED: optionalBooleanFlag(true),
    TELEGRAM_DOCX_NOTIFICATIONS: optionalBooleanFlag(true),
    TELEGRAM_QR_LOGIN_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(300),
    TELEGRAM_QR_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(2500),
    TELEGRAM_DOCX_UPLOADS_ENABLED: optionalBooleanFlag(true),
    TELEGRAM_DOCX_DEFAULT_TYPE: z
      .union([z.coerce.number().int(), z.string().trim().min(1)])
      .default(0),
    TELEGRAM_DOCX_DEFAULT_VOICE: optionalText(z.string().trim().min(1)).default(
      'nguon nho ngot ngao'
    ),
    TELEGRAM_DOCX_POLL_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(25),
    TELEGRAM_DOCX_STATUS_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60),
  })
  .superRefine((value, ctx) => {
    const hasLegacyDeviceTime = Boolean(value.LEGACY_DEVICE_TIME);
    const hasLegacySign = Boolean(value.LEGACY_SIGN);

    if (hasLegacyDeviceTime !== hasLegacySign) {
      if (!hasLegacyDeviceTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['LEGACY_DEVICE_TIME'],
          message:
            'LEGACY_DEVICE_TIME is required when LEGACY_SIGN is provided',
        });
      }

      if (!hasLegacySign) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['LEGACY_SIGN'],
          message:
            'LEGACY_SIGN is required when LEGACY_DEVICE_TIME is provided',
        });
      }
    }
  });

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const errorMessages = parsedEnv.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join(', ');

  throw new Error(`Invalid environment variables: ${errorMessages}`);
}

const env = {
  ...parsedEnv.data,
  CORS_POLICY_ORIGIN:
    parsedEnv.data.CORS_POLICY_ORIGIN ?? parsedEnv.data.ORIGIN ?? '*',
};

export default env;
