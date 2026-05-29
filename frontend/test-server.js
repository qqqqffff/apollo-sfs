/**
 * Sidecar HTTP server that runs the test suites on demand.
 *
 * Listens on PORT (default 9229) and handles:
 *   POST /run-tests  — runs Jest (unit tests) and returns JSON results
 *   POST /run-e2e    — runs Playwright (E2E tests) and returns JSON results
 *   GET  /health     — liveness probe
 *
 * Only one test run executes at a time across both endpoints; concurrent
 * requests receive 503.
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

function runSuite(res, command, args, env = {}) {
  if (running) {
    json(res, 503, { error: 'a test run is already in progress' });
    return;
  }

  running = true;
  const start = Date.now();
  const chunks = [];

  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, CI: 'true', FORCE_COLOR: '0', ...env },
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
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { status: 'ok', running });
    return;
  }

  if (req.method === 'POST' && req.url === '/run-tests') {
    // CI=true disables interactive watch mode in Jest.
    runSuite(res, 'npm', ['test']);
    return;
  }

  if (req.method === 'POST' && req.url === '/run-e2e') {
    // PLAYWRIGHT_BASE_URL points at the frontend nginx container on the Docker
    // bridge so Playwright doesn't try to spin up a Vite dev server.
    runSuite(res, 'npm', ['run', 'test:e2e'], {
      PLAYWRIGHT_BASE_URL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://frontend:80',
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Test runner listening on :${PORT}`);
});
