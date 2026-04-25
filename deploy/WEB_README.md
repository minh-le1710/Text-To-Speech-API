# Web Integration Guide: CapCut TTS API

This guide is for the web app that will call the Dockerized TTS backend.

## Base URL

If the web app runs directly on the same Ubuntu host:

```text
http://127.0.0.1:8089
```

If the web app runs in another Docker container, do not use `127.0.0.1`.
Put both containers on the same Docker network and call the API by service/container name instead.

Example:

```text
http://api-tts-v1:8080
```

## Health Check

```http
GET /health
```

Expected:

```json
{"ok":true}
```

## Recommended DOCX Flow

Use the async job flow for books or long DOCX files.

1. Web uploads DOCX to the TTS API.
2. TTS API returns `jobId` immediately.
3. Web polls job status.
4. When `downloadReady=true`, web downloads the MP3.

This avoids HTTP/browser/proxy timeout while the book is being synthesized.

## Create DOCX Job

```http
POST /v1/synthesize/docx/jobs
Content-Type: multipart/form-data
```

Form fields:

```text
file      required .docx file
voice     optional, recommended: nguon nho ngot ngao
filename  optional output name, without .mp3
type      optional, default 0
pitch     optional, default 10
speed     optional, default 10
volume    optional, default 10
```

## Vietnamese Voices

For Vietnamese DOCX/audio generation, the web app should pass one of these
values in the `voice` multipart field.

Recommended default:

```text
nguon nho ngot ngao
```

Supported Vietnamese aliases currently configured:

```text
nguon nho ngot ngao
nguon-nho-ngot-ngao
nguon_nho_ngot_ngao
nguồn nhỏ ngọt ngào

chi mai
chi-mai
chi_mai

giong nu pho thong
giong-nu-pho-thong
giong_nu_pho_thong
giọng nữ phổ thông

tin

ngon
ngôn
```

Direct CapCut voice ids also work:

```text
7252594014782755330  Nguon nho ngot ngao
7483736254694035984  Chi Mai
7264854897953083905  Giong nu pho thong
7102355803792740865  Tin
7102355709945188865  Ngon
```

Recommended web UI behavior:

```text
Show user-friendly labels in Vietnamese.
Send the ASCII alias to the API to avoid encoding mistakes.
```

Example mapping:

```json
[
  {
    "label": "Nguồn nhỏ ngọt ngào",
    "voice": "nguon nho ngot ngao"
  },
  {
    "label": "Chí Mai",
    "voice": "chi mai"
  },
  {
    "label": "Giọng nữ phổ thông",
    "voice": "giong nu pho thong"
  },
  {
    "label": "Tin",
    "voice": "tin"
  },
  {
    "label": "Ngôn",
    "voice": "ngon"
  }
]
```

Curl example:

```bash
curl -sS -X POST "http://127.0.0.1:8089/v1/synthesize/docx/jobs" \
  -F "file=@./book.docx" \
  -F "voice=nguon nho ngot ngao" \
  -F "filename=book-output"
```

Response: `202 Accepted`

```json
{
  "jobId": "aba39c2cf931bdd77d9df37e4d8a975b",
  "status": "pending",
  "fileName": "book-output.mp3",
  "totalChunks": 1492,
  "completedChunks": 0,
  "progress": 0,
  "progressPercent": 0,
  "active": true,
  "downloadReady": false,
  "statusUrl": "/v1/synthesize/docx/jobs/aba39c2cf931bdd77d9df37e4d8a975b",
  "downloadUrl": "/v1/synthesize/docx/jobs/aba39c2cf931bdd77d9df37e4d8a975b/download",
  "resumeUrl": "/v1/synthesize/docx/jobs/aba39c2cf931bdd77d9df37e4d8a975b/resume"
}
```

Store `jobId` in the web database if the web app has one.

## Poll Job Status

```http
GET /v1/synthesize/docx/jobs/:jobId
```

Example:

```bash
curl "http://127.0.0.1:8089/v1/synthesize/docx/jobs/aba39c2cf931bdd77d9df37e4d8a975b"
```

Statuses:

```text
pending    job accepted
running    chunks are being synthesized
completed  MP3 is ready
failed     job failed, can usually be resumed
```

Recommended polling interval:

```text
5-10 seconds
```

Do not poll every few hundred milliseconds.

## Download MP3

Only call this when `downloadReady=true`.

```http
GET /v1/synthesize/docx/jobs/:jobId/download
```

Example:

```bash
curl -o output.mp3 \
  "http://127.0.0.1:8089/v1/synthesize/docx/jobs/aba39c2cf931bdd77d9df37e4d8a975b/download"
```

The response content type is:

```text
audio/mpeg
```

## Resume Failed Job

If a job fails, the backend keeps completed chunks on disk.

```http
POST /v1/synthesize/docx/jobs/:jobId/resume
```

Example:

```bash
curl -X POST \
  "http://127.0.0.1:8089/v1/synthesize/docx/jobs/aba39c2cf931bdd77d9df37e4d8a975b/resume"
```

The backend stores the uploaded DOCX inside the job folder, so resume usually does not require re-upload.

## Error Handling

Common responses:

```text
400 invalid file/body/job id
404 job not found
409 job exists but is not ready for download, or cannot resume
502 CapCut/API synthesis failed
```

For `409` on download, keep polling status.

For `failed` status, show the error message and offer a "Resume" button.

## Node.js Example

```js
import fs from 'node:fs';

const API_BASE = 'http://127.0.0.1:8089';

async function createJob(docxPath) {
  const form = new FormData();
  form.set('file', new Blob([fs.readFileSync(docxPath)]), 'book.docx');
  form.set('voice', 'nguon nho ngot ngao');
  form.set('filename', 'book-output');

  const response = await fetch(`${API_BASE}/v1/synthesize/docx/jobs`, {
    method: 'POST',
    body: form,
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

async function waitUntilReady(jobId) {
  while (true) {
    const response = await fetch(`${API_BASE}/v1/synthesize/docx/jobs/${jobId}`);
    const job = await response.json();

    if (job.status === 'failed') {
      throw new Error(job.errorMessage || 'TTS job failed');
    }

    if (job.downloadReady) {
      return job;
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function download(jobId, outputPath) {
  const response = await fetch(
    `${API_BASE}/v1/synthesize/docx/jobs/${jobId}/download`
  );

  if (!response.ok) {
    throw new Error(await response.text());
  }

  fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
}
```

## PHP/Laravel Shape

Use multipart upload from the web backend to the TTS API.

Pseudo-code:

```php
$response = Http::attach(
    'file',
    file_get_contents($docxPath),
    'book.docx'
)->post('http://127.0.0.1:8089/v1/synthesize/docx/jobs', [
    'voice' => 'nguon nho ngot ngao',
    'filename' => 'book-output',
]);

$job = $response->json();
```

Then poll:

```php
$job = Http::get("http://127.0.0.1:8089/v1/synthesize/docx/jobs/$jobId")->json();
```

Download:

```php
$mp3 = Http::get("http://127.0.0.1:8089/v1/synthesize/docx/jobs/$jobId/download")->body();
file_put_contents($outputPath, $mp3);
```

## Notes

- Max DOCX upload size is currently `100MB`.
- The backend checkpoints every generated chunk to disk.
- Telegram notifications are enabled on the backend.
- If CapCut session expires, the backend sends a QR login request via Telegram.
- The web app does not need to handle CapCut login directly.
