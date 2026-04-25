# CapCut TTS Wrapper API

[README](./README.md)

A backend-only CapCut TTS wrapper for self-hosted use.

This version is focused on:

- logging in to CapCut Web with QR and keeping the cookie session
- sending CapCut QR login and DOCX job results through Telegram
- keeping the session alive with local cache files
- synthesizing plain text through `GET /v1/synthesize`
- synthesizing `.docx` files directly to MP3 through `POST /v1/synthesize/docx`
- checkpointing DOCX chunks to SQLite and disk so long books can resume
- running cleanly on Linux with Docker

There is no built-in web UI in this version. The only database file is a small
local SQLite checkpoint store for long DOCX synthesis jobs.

## Notes

- This is not an official CapCut SDK or official API wrapper.
- CapCut may change its internal APIs at any time.
- Session bootstrap or workspace lookup may fail temporarily depending on CapCut risk checks.

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Create `.env`

```bash
cp .env.example .env
```

### 3. Create a CapCut QR session

On Windows, run:

```bash
npm run capcut:qr-login
```

Or run the packaged executable:

```bat
dist\capcut-qr-login.exe
```

Scan the QR code with CapCut Mobile and approve the login. The session is saved to `CAPCUT_SESSION_STORE_PATH`, which defaults to `data/capcut-session.json`.

`CAPCUT_EMAIL` and `CAPCUT_PASSWORD` are now optional fallback credentials only.

### Telegram notifications

Create a bot with BotFather, send `/start` to that bot, then run:

```bash
npm run telegram:chat-id
```

Put the bot token and selected chat id into `.env`:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

When configured, the backend sends CapCut QR codes to Telegram when it needs a
fresh login, and sends DOCX job summaries after completion or failure.

Telegram DOCX upload is also supported. Send a `.docx` file to the configured
bot and the backend will enqueue the same checkpointed DOCX job, then send the
MP3 file back to Telegram when it is done. The default voice is controlled by
`TELEGRAM_DOCX_DEFAULT_VOICE`.

Optional Telegram caption fields:

```text
voice=nguon nho ngot ngao
speed=10
volume=10
filename=my-book.mp3
```

### 4. Start in development

```bash
npm run dev
```

### 5. Synthesize plain text

```bash
curl "http://localhost:8080/v1/synthesize?text=Hello&type=0&method=buffer" --output voice.mp3
```

### 6. Synthesize a DOCX file

```bash
curl -X POST "http://localhost:8080/v1/synthesize/docx" \
  -F "file=@./input.docx" \
  -F "voice=7264854897953083905" \
  --output output.mp3
```

You can also pass `type`, `pitch`, `speed`, `volume`, and `filename` in the same multipart request.

## Docker

Build and run with Docker Compose:

```bash
docker compose up --build -d
```

The compose file mounts `./data` into the container so these cache files survive restarts:

- `data/capcut-session.json`
- `data/capcut-bundle-config.json`
- `data/docx-jobs.sqlite`
- `data/docx-jobs/`

## API

### Health Check

```http
GET /health
```

### Text to MP3

```http
GET /v1/synthesize
```

Query parameters:

- `text` required
- `type` optional, default `0`
- `voice` optional, overrides `type`
- `pitch` optional, default `10`
- `speed` optional, default `10`
- `volume` optional, default `10`
- `method` optional, `buffer` or `stream`

### DOCX to MP3

```http
POST /v1/synthesize/docx
```

Multipart form fields:

- `file` required, `.docx`
- `type` optional, default `0`
- `voice` optional, overrides `type`
- `pitch` optional, default `10`
- `speed` optional, default `10`
- `volume` optional, default `10`
- `filename` optional output file name without needing to rename locally

Successful responses return `audio/mpeg`.

Long DOCX jobs are checkpointed automatically:

- each completed chunk is saved under `DOCX_JOB_WORKDIR` as `.mp3.tmp`
- chunk/job progress is stored in `DOCX_JOB_DB_PATH`
- if the same file and voice/settings are submitted again, completed chunks are reused
- the final MP3 is streamed from disk instead of being held in memory

For long books, prefer the async job flow:

```http
POST /v1/synthesize/docx/jobs
GET /v1/synthesize/docx/jobs/:jobId
GET /v1/synthesize/docx/jobs/:jobId/download
POST /v1/synthesize/docx/jobs/:jobId/resume
```

The create endpoint returns `jobId`, `statusUrl`, and `downloadUrl` immediately
with HTTP `202`. Poll the status URL until `downloadReady` is `true`, then
download the MP3 from the download URL.

### Voice Models

```http
GET /v1/models
```

### Legacy Flow

```http
GET /legacy/synthesize
```

This endpoint still uses the old token + websocket flow and returns WAV.

## Environment Variables

Important variables:

- `CAPCUT_EMAIL`
- `CAPCUT_PASSWORD`
- `CAPCUT_LOCALE`
- `CAPCUT_PAGE_LOCALE`
- `CAPCUT_REGION`
- `CAPCUT_STORE_COUNTRY_CODE`
- `CAPCUT_BUNDLE_CONFIG_PATH`
- `CAPCUT_SESSION_STORE_PATH`
- `DOCX_MAX_FILE_MB`
- `TTS_MAX_CHARS_PER_CHUNK`
- `DOCX_JOB_DB_PATH`
- `DOCX_JOB_WORKDIR`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_QR_LOGIN_ENABLED`
- `TELEGRAM_DOCX_NOTIFICATIONS`
- `HOST`
- `PORT`

Legacy-only variables:

- `LEGACY_DEVICE_TIME`
- `LEGACY_SIGN`

## Scripts

- `npm run dev`
- `npm run build`
- `npm run start`
- `npm run typecheck`
- `npm run lint`
- `npm run capcut:extract`
- `npm run capcut:qr-login`
- `npm run capcut:qr-exe`
- `npm run telegram:chat-id`
