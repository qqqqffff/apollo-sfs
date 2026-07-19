/**
 * Unified test-runner sidecar: runs every service's test suite from one
 * container and returns one combined report, instead of fanning out to a
 * separate sidecar per service.
 *
 * Listens on PORT (default 9228) and handles:
 *   POST /run-tests — runs backend/frontend/frontend_e2e/mobile/recognition
 *                     suites in turn and returns a combined JSON report
 *   GET  /health    — liveness probe
 *
 * Only one run executes at a time; concurrent requests receive 503.
 * Never exposed outside the Docker bridge network — the Go API is the only
 * caller (see api/routes/admin/tests.go), which computes the aggregate
 * pass/fail HTTP status from this report rather than this server doing it.
 */

const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = Number(process.env.TEST_SERVER_PORT ?? 9228);
const ROOT = __dirname;
const RECOGNITION_PYTHON = process.env.RECOGNITION_PYTHON ?? '/opt/recognition-venv/bin/python';

let running = false;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// Runs one suite's command and resolves to a suiteResult — never rejects, so
// one suite's crash can't take down the rest of the run.
function runSuite(command, args, cwd, env = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const chunks = [];

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, CI: 'true', FORCE_COLOR: '0', ...env },
      });
    } catch (err) {
      resolve({ passed: false, exit_code: -1, output: err.message, duration_ms: Date.now() - start });
      return;
    }

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));

    child.on('close', (code) => {
      resolve({
        passed: code === 0,
        exit_code: code ?? -1,
        output: Buffer.concat(chunks).toString(),
        duration_ms: Date.now() - start,
      });
    });

    child.on('error', (err) => {
      resolve({ passed: false, exit_code: -1, output: err.message, duration_ms: Date.now() - start });
    });
  });
}

// Runs every suite in sequence (not in parallel — this container has limited
// CPU/RAM and go test/npm test/Playwright/pytest would otherwise contend for
// the same cores) and assembles the combined report.
async function runAllSuites() {
  const backend = await runSuite('go', ['test', './tests/...', '-count=1'], path.join(ROOT, 'api'));
  const frontend = await runSuite('npm', ['test'], path.join(ROOT, 'frontend'));
  const frontendE2E = await runSuite('npm', ['run', 'test:e2e'], path.join(ROOT, 'frontend'), {
    // Points at the already-running frontend nginx container on the Docker
    // bridge so Playwright doesn't try to spin up a Vite dev server.
    PLAYWRIGHT_BASE_URL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://frontend:80',
  });
  const mobile = await runSuite('npm', ['test'], path.join(ROOT, 'mobile'));
  const recognition = await runSuite(RECOGNITION_PYTHON, ['-m', 'pytest', 'tests/', '-v'], path.join(ROOT, 'recognition'));

  return {
    backend: { enabled: true, result: backend },
    frontend: { enabled: true, result: frontend },
    frontend_e2e: { enabled: true, result: frontendE2E },
    mobile: { enabled: true, result: mobile },
    recognition: { enabled: true, result: recognition },
  };
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { status: 'ok', running });
    return;
  }

  if (req.method === 'POST' && req.url === '/run-tests') {
    if (running) {
      json(res, 503, { error: 'a test run is already in progress' });
      return;
    }
    running = true;
    runAllSuites()
      .then((report) => { running = false; json(res, 200, report); })
      .catch((err) => { running = false; json(res, 500, { error: err.message }); });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Unified test runner listening on :${PORT}`);
});
