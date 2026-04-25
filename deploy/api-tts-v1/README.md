# CapCut TTS Wrapper API

[English README](./README.en.md)

Phiên bản này là backend-only:

- không còn web UI
- chỉ còn SQLite cục bộ để checkpoint DOCX dài, không còn platform database layer
- nhận text hoặc `.docx` và trả về MP3
- ưu tiên đăng nhập CapCut bằng QR để giữ cookie session ổn định hơn
- có thể gửi QR đăng nhập và kết quả DOCX qua Telegram bot
- phù hợp hơn để chạy trên Linux bằng Docker

## Đăng nhập QR

Trên Windows, chạy tool QR:

```bash
npm run capcut:qr-login
```

Hoặc chạy file đã đóng gói:

```bash
dist\capcut-qr-login.exe
```

Tool sẽ mở một trang local có mã QR. Quét bằng CapCut Mobile và bấm xác nhận. Khi thành công, session được lưu vào `CAPCUT_SESSION_STORE_PATH`, mặc định là `data/capcut-session.json`.

## Chạy nhanh

```bash
npm install
cp .env.example .env
npm run capcut:qr-login
npm run dev
```

`CAPCUT_EMAIL` và `CAPCUT_PASSWORD` hiện chỉ là fallback tùy chọn. Nếu không cấu hình password login, backend sẽ yêu cầu bạn tạo session bằng QR trước.

## Telegram bot

Tạo bot bằng BotFather, nhắn `/start` cho bot đó, rồi chạy:

```bash
npm run telegram:chat-id
```

Điền `TELEGRAM_BOT_TOKEN` và `TELEGRAM_CHAT_ID` vào `.env`. Khi session CapCut hết hạn, backend sẽ gửi QR qua Telegram để bạn quét. Khi DOCX chạy xong hoặc lỗi, bot cũng gửi tóm tắt số từ/ký tự/chunk/dung lượng/trạng thái checkpoint.

## API chính

Text -> MP3:

```bash
curl "http://localhost:8080/v1/synthesize?text=Hello&type=0&method=buffer" --output voice.mp3
```

DOCX -> MP3:

```bash
curl -X POST "http://localhost:8080/v1/synthesize/docx" \
  -F "file=@./input.docx" \
  -F "voice=7264854897953083905" \
  --output output.mp3
```

Với DOCX dài, backend tự checkpoint: mỗi chunk audio được lưu ngay xuống `DOCX_JOB_WORKDIR` dưới dạng `.mp3.tmp`, tiến độ được ghi vào `DOCX_JOB_DB_PATH`, và nếu chạy lại cùng file/voice/settings thì các chunk đã xong sẽ được dùng lại.

DOCX job chạy nền, phù hợp cho sách dài:

```bash
curl -X POST "http://localhost:8080/v1/synthesize/docx/jobs" \
  -F "file=@./input.docx" \
  -F "voice=nguon nho ngot ngao"
```

API sẽ trả `jobId`, `statusUrl` và `downloadUrl`. Web có thể poll `GET /v1/synthesize/docx/jobs/:jobId`, khi `downloadReady=true` thì tải MP3 qua `GET /v1/synthesize/docx/jobs/:jobId/download`. Nếu job fail mà file input còn trong `data/docx-jobs`, có thể gọi `POST /v1/synthesize/docx/jobs/:jobId/resume`.

Health check:

```bash
curl "http://localhost:8080/health"
```

## Docker

```bash
docker compose up --build -d
```

Cache session, bundle, SQLite checkpoint và chunk tạm sẽ được giữ trong thư mục `data/`. Trước khi đưa lên Linux/Docker, hãy tạo `data/capcut-session.json` bằng tool QR rồi mount/copy thư mục `data` sang môi trường chạy.
