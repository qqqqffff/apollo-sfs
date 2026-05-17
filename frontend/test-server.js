/**
 * Sidecar HTTP server that runs the Jest test suite on demand.
 *
 * Listens on PORT (default 9229) and handles:
 *   POST /run-tests  — runs `npm test` and returns JSON results
 *   GET  /health     — liveness probe
 *
 * Only one test run executes at a time; concurrent requests receive 503.
 * Never exposed outside the Docker bridge network.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.TEST_SERVER_PORT ?? 9229);
let running = false;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { status: 'ok', running });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/run-tests') {
    json(res, 404, { error: 'not found' });
    return;
  }

  if (running) {
    json(res, 503, { error: 'a test run is already in progress' });
    return;
  }

  running = true;
  const start = Date.now();
  const chunks = [];

  // CI=true disables interactive watch mode in Jest.
  // FORCE_COLOR=0 strips ANSI codes so the output is plain text.
  const child = spawn('npm', ['test'], {
    cwd: process.cwd(),
    env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
  });

  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => chunks.push(chunk));

  child.on('close', (code) => {
    running = false;
    json(res, 200, {
      passed: code === 0,
      exit_code: code ?? -1,
      output: Buffer.concat(chunks).toString(),
      duration_ms: Date.now() - start,
    });
  });

  child.on('error', (err) => {
    running = false;
    json(res, 500, { error: err.message });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Test runner listening on :${PORT}`);
});
