# Web Backend Integration Guide

Tai lieu nay danh cho backend cua web khi goi sang API TTS dang chay tren
server tai port `8089`.

## Base URL

Neu web backend va API TTS cung chay tren mot Ubuntu host:

```text
http://127.0.0.1:8089
```

Neu web backend nam trong Docker container khac, khong dung `127.0.0.1`.
Hay dat 2 container vao cung Docker network va goi theo service/container name:

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

## Luong Chinh Cho DOCX Dai

Khong nen de web cho mot request HTTP den khi sach xong, vi sach dai co the
mat 30 phut den nhieu gio. Backend web nen dung async job flow:

1. Web upload file DOCX sang API TTS.
2. API TTS tra ngay `jobId`.
3. Web luu `jobId` vao database cua web.
4. Web poll `GET /v1/synthesize/docx/jobs/:jobId`.
5. Khi `downloadReady=true`, web tai MP3 qua endpoint download.

API TTS tu checkpoint tung chunk xuong disk va SQLite. Neu loi giua chung, co
the resume job ma khong can chay lai tu dau.

## Tao DOCX Job

```http
POST /v1/synthesize/docx/jobs
Content-Type: multipart/form-data
```

Form fields:

```text
file      required, .docx file
voice     optional, recommended: nguon nho ngot ngao
filename  optional, output name, co the co hoac khong co .mp3
type      optional, default 0
pitch     optional, default 10
speed     optional, default 10
volume    optional, default 10
```

Curl example:

```bash
curl -sS -X POST "http://127.0.0.1:8089/v1/synthesize/docx/jobs" \
  -F "file=@./book.docx" \
  -F "voice=nguon nho ngot ngao" \
  -F "filename=book-output"
```

Response example:

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

## Lay Trang Thai Job

```http
GET /v1/synthesize/docx/jobs/:jobId
```

Example:

```bash
curl "http://127.0.0.1:8089/v1/synthesize/docx/jobs/aba39c2cf931bdd77d9df37e4d8a975b"
```

Statuses:

```text
pending    job da duoc tao, chua chay chunk dau tien
running    dang tao audio chunk
completed  MP3 da san sang
failed     job loi, co the resume neu file input con trong data
```

Khuyen nghi poll moi `5-10 giay`. Khong nen poll lien tuc moi vai tram ms.

## Tai MP3

Chi goi endpoint nay khi `downloadReady=true`.

```http
GET /v1/synthesize/docx/jobs/:jobId/download
```

Example:

```bash
curl -o output.mp3 \
  "http://127.0.0.1:8089/v1/synthesize/docx/jobs/aba39c2cf931bdd77d9df37e4d8a975b/download"
```

Response:

```text
Content-Type: audio/mpeg
Content-Disposition: attachment; filename="book-output.mp3"
```

## Resume Job Loi

Neu job `failed`, web co the hien nut "Thu lai" va goi:

```http
POST /v1/synthesize/docx/jobs/:jobId/resume
```

Example:

```bash
curl -X POST \
  "http://127.0.0.1:8089/v1/synthesize/docx/jobs/aba39c2cf931bdd77d9df37e4d8a975b/resume"
```

API TTS da luu file DOCX goc trong job folder, nen resume thuong khong can
upload lai file.

## Danh Sach Giong Viet Nam

Backend web nen gui gia tri cot `voice` bang alias ASCII de tranh loi encoding
khi submit multipart/form-data. UI co the hien label dep hon, nhung payload nen
dung alias trong cot `voice`.

Recommended default:

```text
nguon nho ngot ngao
```

| UI label | voice gui sang API | CapCut voice id |
| --- | --- | --- |
| Nguon nho ngot ngao | `nguon nho ngot ngao` | `7252594014782755330` |
| Chi Mai | `chi mai` | `7483736254694035984` |
| Giong nu pho thong | `giong nu pho thong` | `7264854897953083905` |
| Tin | `tin` | `7102355803792740865` |
| Ngon | `ngon` | `7102355709945188865` |

Aliases ho tro:

```json
[
  {
    "label": "Nguon nho ngot ngao",
    "voice": "nguon nho ngot ngao",
    "aliases": ["nguon-nho-ngot-ngao", "nguon_nho_ngot_ngao"],
    "id": "7252594014782755330"
  },
  {
    "label": "Chi Mai",
    "voice": "chi mai",
    "aliases": ["chi-mai", "chi_mai"],
    "id": "7483736254694035984"
  },
  {
    "label": "Giong nu pho thong",
    "voice": "giong nu pho thong",
    "aliases": ["giong-nu-pho-thong", "giong_nu_pho_thong"],
    "id": "7264854897953083905"
  },
  {
    "label": "Tin",
    "voice": "tin",
    "aliases": [],
    "id": "7102355803792740865"
  },
  {
    "label": "Ngon",
    "voice": "ngon",
    "aliases": [],
    "id": "7102355709945188865"
  }
]
```

Co the gui truc tiep `voice id` neu muon, nhung khuyen nghi dung alias ASCII de
code web de doc hon.

## Node.js Backend Example

```js
import fs from 'node:fs';

const API_BASE = 'http://127.0.0.1:8089';

export async function createTtsJob(docxPath) {
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

export async function getTtsJob(jobId) {
  const response = await fetch(`${API_BASE}/v1/synthesize/docx/jobs/${jobId}`);

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

export async function downloadTtsMp3(jobId, outputPath) {
  const response = await fetch(
    `${API_BASE}/v1/synthesize/docx/jobs/${jobId}/download`
  );

  if (!response.ok) {
    throw new Error(await response.text());
  }

  fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
}
```

## PHP/Laravel Backend Example

Create job:

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

Poll:

```php
$job = Http::get(
    "http://127.0.0.1:8089/v1/synthesize/docx/jobs/$jobId"
)->json();
```

Download:

```php
$mp3 = Http::get(
    "http://127.0.0.1:8089/v1/synthesize/docx/jobs/$jobId/download"
)->body();

file_put_contents($outputPath, $mp3);
```

## Optional: Text To Speech Ngan

Endpoint nay phu hop voi text ngan, khong phu hop sach dai:

```http
GET /v1/synthesize?text=...&voice=nguon%20nho%20ngot%20ngao&method=buffer
```

Example:

```bash
curl -G "http://127.0.0.1:8089/v1/synthesize" \
  --data-urlencode "text=Xin chao, day la cau test." \
  --data-urlencode "voice=nguon nho ngot ngao" \
  --data-urlencode "method=buffer" \
  -o sample.mp3
```

## Error Handling

Common HTTP responses:

```text
400 invalid body, invalid file, invalid job id
404 job not found
409 job chua san sang de download, hoac khong resume duoc
502 loi tu CapCut/API TTS
```

Neu download gap `409`, tiep tuc poll status.

Neu status la `failed`, hien `errorMessage` cho admin/user va cho phep goi
endpoint resume.

## Notes Cho Web Backend

- Max DOCX upload hien tai: `100MB`.
- API TTS dang expose tren host: `127.0.0.1:8089`.
- API TTS tu lo CapCut session. Khi session het han, bot Telegram se gui QR.
- Web backend khong can xu ly CapCut login.
- Web backend nen luu `jobId`, `fileName`, `status`, `progressPercent` va
  `downloadUrl` de UI hien tien do.
- Khong nen goi sync DOCX endpoint cho sach dai. Hay dung async job endpoint.
