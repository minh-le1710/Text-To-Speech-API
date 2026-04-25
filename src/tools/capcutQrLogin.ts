import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import capCutQrLoginService, {
  type CapCutQrLoginTicket,
} from '@/services/CapCutQrLoginService';
import telegramService, {
  notifyTelegramSafely,
} from '@/services/TelegramService';

interface ToolState {
  phase: 'starting' | 'qr' | 'pending' | 'success' | 'expired' | 'error';
  message: string;
  qr?: {
    image: string;
    expiresAt?: number;
    indexUrl?: string;
  };
  session?: {
    userId: string;
    screenName: string;
    workspaceId: string;
  };
  warning?: string;
  updatedAt: number;
}

const args = parseArgs(process.argv.slice(2));
let state: ToolState = {
  phase: 'starting',
  message: 'Starting CapCut QR login...',
  updatedAt: Date.now(),
};
let ticket: CapCutQrLoginTicket | null = null;
let final = false;

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (url.pathname === '/state') {
    sendJson(response, state);
    return;
  }

  if (url.pathname === '/') {
    sendHtml(response, renderHtml());
    return;
  }

  response.writeHead(404);
  response.end('Not found');
});

server.listen(args.port, args.host, () => {
  const address = server.address() as AddressInfo;
  const localUrl = `http://${address.address}:${address.port}/`;

  console.log(`CapCut QR login UI: ${localUrl}`);

  if (!args.noBrowser) {
    openBrowser(localUrl);
  }

  void runLoginLoop();
});

async function runLoginLoop() {
  const startedAt = Date.now();

  while (!final) {
    if (Date.now() - startedAt > args.timeoutMs) {
      setState({
        phase: 'error',
        message: 'Timed out waiting for QR confirmation. Please run again.',
      });
      final = true;
      scheduleShutdown();
      return;
    }

    try {
      if (!ticket || isTicketExpired(ticket)) {
        await refreshTicket();
      }

      if (!ticket) {
        await wait(2500);
        continue;
      }

      const result = await capCutQrLoginService.poll(ticket);

      if (result.authenticated) {
        setState({
          phase: 'success',
          message: result.session
            ? 'QR login succeeded. Session and workspace were saved.'
            : 'QR login succeeded. Cookies were saved.',
          session: result.session
            ? {
                userId: result.session.userId,
                screenName: result.session.screenName,
                workspaceId: result.session.workspaceId,
              }
            : undefined,
          warning: result.warning,
        });
        await notifyTelegramSafely(
          () => telegramService.sendCapCutLoginSuccess(result.session?.workspaceId),
          'CapCut QR login tool success'
        );
        final = true;
        scheduleShutdown();
        return;
      }

      if (result.status === 'expired') {
        setState({
          phase: 'expired',
          message: 'QR code expired. Generating a new one...',
        });
        ticket = null;
        await wait(800);
        continue;
      }

      setState({
        phase: 'pending',
        message:
          result.rawStatus === 'scanned'
            ? 'QR scanned. Please confirm login on your phone.'
            : 'Waiting for scan and confirmation...',
      });
      await wait(result.retryAfterMs ?? 2500);
    } catch (error) {
      setState({
        phase: 'error',
        message: `QR login check failed: ${formatError(error)}. Retrying...`,
      });
      await wait(5000);
    }
  }
}

async function refreshTicket() {
  setState({
    phase: 'starting',
    message: 'Generating a fresh CapCut QR code...',
    qr: undefined,
    warning: undefined,
  });

  ticket = await capCutQrLoginService.createTicket(args.next);

  setState({
    phase: 'qr',
    message: 'Scan this QR code with CapCut Mobile, then approve login.',
    qr: {
      image: ticket.qrcodeBase64,
      expiresAt: ticket.expireTime ? ticket.expireTime * 1000 : undefined,
      indexUrl: ticket.qrcodeIndexUrl,
    },
  });

  await notifyTelegramSafely(
    () =>
      telegramService.sendCapCutQr(
        ticket?.qrcodeBase64 ?? '',
        ticket?.expireTime ? ticket.expireTime * 1000 : undefined
      ),
    'CapCut QR login tool QR'
  );
}

function setState(next: Partial<ToolState>) {
  state = {
    ...state,
    ...next,
    updatedAt: Date.now(),
  };
}

function renderHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CapCut QR Login</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4efe7;
      --ink: #17211d;
      --muted: #68736e;
      --card: #fffaf0;
      --line: #dccfbd;
      --accent: #0c6b58;
      --danger: #a33b2f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top left, rgba(12, 107, 88, .18), transparent 34rem),
        linear-gradient(135deg, #f8f0df, var(--bg));
      color: var(--ink);
      font-family: Georgia, "Times New Roman", serif;
    }
    main {
      width: min(92vw, 720px);
      padding: 34px;
      border: 1px solid var(--line);
      border-radius: 28px;
      background: rgba(255, 250, 240, .92);
      box-shadow: 0 24px 70px rgba(59, 45, 22, .18);
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(34px, 6vw, 58px);
      letter-spacing: -0.05em;
      line-height: .92;
    }
    .lede {
      margin: 0 0 28px;
      color: var(--muted);
      font: 17px/1.5 "Segoe UI", sans-serif;
    }
    .panel {
      display: grid;
      gap: 24px;
      grid-template-columns: minmax(220px, 320px) 1fr;
      align-items: center;
    }
    .qr {
      width: 100%;
      aspect-ratio: 1;
      display: grid;
      place-items: center;
      padding: 16px;
      border-radius: 24px;
      background: white;
      border: 1px solid var(--line);
    }
    .qr img { width: 100%; height: 100%; object-fit: contain; }
    .status {
      min-height: 180px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 14px;
      font-family: "Segoe UI", sans-serif;
    }
    .badge {
      width: max-content;
      padding: 7px 12px;
      border-radius: 999px;
      background: rgba(12, 107, 88, .12);
      color: var(--accent);
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .08em;
      font-size: 12px;
    }
    .badge.error { background: rgba(163, 59, 47, .12); color: var(--danger); }
    .msg { margin: 0; font-size: 19px; line-height: 1.45; }
    .meta { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.55; }
    .warning {
      margin: 12px 0 0;
      padding: 12px 14px;
      border-left: 4px solid var(--danger);
      background: rgba(163, 59, 47, .08);
      color: var(--danger);
      font: 14px/1.5 "Segoe UI", sans-serif;
    }
    @media (max-width: 680px) {
      main { padding: 24px; }
      .panel { grid-template-columns: 1fr; }
      .qr { max-width: 320px; margin: 0 auto; }
    }
  </style>
</head>
<body>
  <main>
    <h1>CapCut QR Login</h1>
    <p class="lede">Open CapCut on your phone, scan the code, and approve the login request.</p>
    <section class="panel">
      <div class="qr" id="qr">Preparing QR...</div>
      <div class="status">
        <div class="badge" id="phase">Starting</div>
        <p class="msg" id="message">Starting CapCut QR login...</p>
        <p class="meta" id="meta"></p>
        <div class="warning" id="warning" hidden></div>
      </div>
    </section>
  </main>
  <script>
    async function update() {
      const res = await fetch('/state', { cache: 'no-store' });
      const state = await res.json();
      const qr = document.getElementById('qr');
      const phase = document.getElementById('phase');
      const message = document.getElementById('message');
      const meta = document.getElementById('meta');
      const warning = document.getElementById('warning');
      phase.textContent = state.phase;
      phase.className = 'badge' + (state.phase === 'error' ? ' error' : '');
      message.textContent = state.message;
      if (state.qr && state.qr.image) {
        qr.innerHTML = '<img alt="CapCut QR code" src="data:image/png;base64,' + state.qr.image + '">';
      } else {
        qr.textContent = 'Preparing QR...';
      }
      if (state.session) {
        meta.textContent = 'Workspace: ' + state.session.workspaceId + (state.session.screenName ? ' | User: ' + state.session.screenName : '');
      } else if (state.qr && state.qr.expiresAt) {
        meta.textContent = 'Expires at ' + new Date(state.qr.expiresAt).toLocaleTimeString();
      } else {
        meta.textContent = '';
      }
      if (state.warning) {
        warning.hidden = false;
        warning.textContent = state.warning;
      } else {
        warning.hidden = true;
      }
    }
    update();
    setInterval(update, 1200);
  </script>
</body>
</html>`;
}

function sendHtml(response: http.ServerResponse, html: string) {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(html);
}

function sendJson(response: http.ServerResponse, payload: unknown) {
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function openBrowser(url: string) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }

  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(command, [url], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

function scheduleShutdown() {
  setTimeout(() => {
    server.close();
  }, 30000).unref();
}

function isTicketExpired(current: CapCutQrLoginTicket) {
  return Boolean(current.expireTime && Date.now() >= current.expireTime * 1000);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseArgs(argv: string[]) {
  const parsed = {
    host: '127.0.0.1',
    port: 0,
    timeoutMs: 5 * 60 * 1000,
    noBrowser: false,
    next: 'https://www.capcut.com/my-edit',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--host' && next) {
      parsed.host = next;
      index += 1;
    } else if (arg === '--port' && next) {
      parsed.port = Number(next);
      index += 1;
    } else if (arg === '--timeout-seconds' && next) {
      parsed.timeoutMs = Number(next) * 1000;
      index += 1;
    } else if (arg === '--next' && next) {
      parsed.next = next;
      index += 1;
    } else if (arg === '--no-browser') {
      parsed.noBrowser = true;
    }
  }

  return parsed;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
