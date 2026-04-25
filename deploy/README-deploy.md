# api-tts-v1 deploy

Upload these files to the Ubuntu server:

- `api-tts-v1.tar`
- `deploy-up.sh`

Then run:

```bash
chmod +x deploy-up.sh
./deploy-up.sh
```

The service is exposed on the host as:

```text
http://127.0.0.1:8089
```

Useful checks:

```bash
curl http://127.0.0.1:8089/health
docker compose -f api-tts-v1/docker-compose.yml logs -f
```

The container uses `restart: always`, so it will start again after Docker/server restarts.

Persistent data lives in:

```text
api-tts-v1/data
```

That folder contains the CapCut session cache and DOCX checkpoint files.

Telegram DOCX upload is enabled when `.env` contains:

```text
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TELEGRAM_DOCX_UPLOADS_ENABLED=true
```

Send a `.docx` file directly to the bot. The backend will create a DOCX job,
checkpoint chunks as usual, and send the MP3 file back to Telegram when done.

Optional Telegram caption fields:

```text
voice=nguon nho ngot ngao
speed=10
volume=10
filename=my-book.mp3
```
