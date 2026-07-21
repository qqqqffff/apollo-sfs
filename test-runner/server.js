/**
 * Unified test-runner sidecar: runs every service's test suite from one
 * container and returns one combined report, instead of fanning out to a
 * separate sidecar per service.
 *
 * Listens on PORT (default 9228) and handles:
 *   POST /run-tests — runs backend/frontend/frontend_e2e/mobile/recognition
 *                     suites in turn and returns a combined JSON report
 *   GET  /progress  — live status of the in-flight run (or the last one), so
 *                     a caller polling during the (multi-minute) POST above
 *                     can show which suite is currently running and the
 *                     results of whichever suites have already finished
 *   GET  /health    — liveness probe
 *
 * Only one run executes at a time; concurrent requests receive 503.
 * Never exposed outside the Docker bridge network — the Go API is the only
 * caller (see api/routes/admin/tests.go), which computes the aggregate
 * pass/fail HTTP status from this report rather than this server doing it.
 *
 * Each suite is run through its toolchain's structured/JSON reporter so the
 * report carries a per-test breakdown (name/passed/duration, failure message
 * for failing tests) and line/branch coverage, not just an aggregate
 * pass/fail — see the individual parse*() functions below, one per toolchain.
 * A suite whose structured output can't be parsed (crashed before producing
 * one, unexpected format) still reports passed/exit_code/output/duration_ms —
 * it just omits `tests`/`coverage` rather than failing the whole run.
 *
 * Every suite process is killed if it runs past SUITE_TIMEOUT_MS (5 minutes)
 * so one hung suite (e.g. Playwright waiting on a dead server) can't block
 * the rest of the run forever — the killed suite is reported as a failure
 * with a note in its output, and the run continues to the next suite.
 */

const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');

const PORT = Number(process.env.TEST_SERVER_PORT ?? 9228);
const ROOT = __dirname;
const RECOGNITION_PYTHON = process.env.RECOGNITION_PYTHON ?? '/opt/recognition-venv/bin/python';
const SUITE_TIMEOUT_MS = 5 * 60 * 1000;

// Execution order the suites always run in — also what GET /progress reports
// as `order`, so a caller can render "pending" placeholders for suites that
// haven't started yet.
const SUITE_ORDER = ['backend', 'frontend', 'frontend_e2e', 'mobile', 'recognition'];

// Tracks the in-flight (or most recently finished) run for GET /progress.
// Reset at the start of every POST /run-tests; `completed[key]` is filled in
// as each suite finishes, in the same { enabled, result } shape as the final
// report, so a caller can render a finished suite identically whether it
// came from here or from the final POST response.
let currentRun = { running: false, currentSuite: null, completed: {} };

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// Reads and JSON-parses a file, returning null instead of throwing if it's
// missing or malformed (the toolchain crashed before writing/finishing it).
async function readJSONIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Toolchain-specific parsing ───────────────────────────────────────────────
// Each parse* function takes whatever raw material its toolchain produced and
// returns { tests, coverage } (either may be null/omitted if unavailable).
// `tests` is a flat list of { name, passed, duration_ms, message? }.

// Go's `-json` flag streams one JSON event per line (test2json). Events with
// a `Test` field are per-test (Action: run/output/pass/fail/skip/cont/pause);
// events without one are package-level (includes the `coverage: NN.N% of
// statements` line when run with `-cover`). Concatenating every event's
// `Output` in order reconstructs the exact text `go test` would have printed
// without -json, so that also becomes the human-readable `output` string.
function parseGoJSON(stdout) {
  const tests = new Map();
  const outputChunks = [];
  const coverageSamples = [];

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue; // a stray non-JSON line (shouldn't happen with -json, but don't crash the parse over it)
    }

    if (typeof evt.Output === 'string') {
      outputChunks.push(evt.Output);
      const covMatch = evt.Output.match(/coverage:\s*([\d.]+)%\s*of statements/);
      if (covMatch) coverageSamples.push(parseFloat(covMatch[1]));
    }

    if (!evt.Test) continue; // package-level event
    const key = `${evt.Package}::${evt.Test}`;
    if (!tests.has(key)) {
      tests.set(key, { name: evt.Test, passed: false, durationMs: 0, seen: false, skip: false, lines: [] });
    }
    const t = tests.get(key);
    if (typeof evt.Output === 'string') t.lines.push(evt.Output);

    if (evt.Action === 'pass') {
      t.passed = true; t.seen = true; t.durationMs = Math.round((evt.Elapsed ?? 0) * 1000);
    } else if (evt.Action === 'fail') {
      t.passed = false; t.seen = true; t.durationMs = Math.round((evt.Elapsed ?? 0) * 1000);
    } else if (evt.Action === 'skip') {
      t.seen = true; t.skip = true;
    }
  }

  const testList = [...tests.values()]
    .filter((t) => t.seen && !t.skip)
    .map((t) => ({
      name: t.name,
      passed: t.passed,
      duration_ms: t.durationMs,
      ...(t.passed ? {} : { message: t.lines.join('').trim() }),
    }));

  const linesPct = coverageSamples.length
    ? coverageSamples.reduce((a, b) => a + b, 0) / coverageSamples.length
    : null;

  return {
    tests: testList,
    output: outputChunks.join(''),
    // Go has no built-in branch coverage instrumentation.
    coverage: linesPct != null ? { lines_pct: linesPct, branches_pct: null } : null,
  };
}

// Jest's --json/--outputFile result: top-level testResults[], each with
// assertionResults[] ({ fullName, status, duration, failureMessages }).
function parseJestResult(result) {
  if (!result || !Array.isArray(result.testResults)) return { tests: null, coverage: null };
  const tests = [];
  for (const fileResult of result.testResults) {
    for (const a of fileResult.assertionResults ?? []) {
      if (a.status === 'pending' || a.status === 'todo') continue; // skipped, not run
      const passed = a.status === 'passed';
      tests.push({
        name: a.fullName || a.title,
        passed,
        duration_ms: a.duration ?? 0,
        ...(passed ? {} : { message: (a.failureMessages ?? []).join('\n\n') }),
      });
    }
  }
  return { tests };
}

// Jest coverage-summary.json (--coverageReporters=json-summary): { total: { lines: { pct }, branches: { pct } }, ... }
function parseJestCoverageSummary(summary) {
  const total = summary?.total;
  if (!total) return null;
  return {
    lines_pct: typeof total.lines?.pct === 'number' ? total.lines.pct : null,
    branches_pct: typeof total.branches?.pct === 'number' ? total.branches.pct : null,
  };
}

// Playwright's --reporter=json result: suites[] nest recursively (per file,
// then per describe block); each leaf suite has specs[], each spec has
// tests[] (one per project/browser), each test has results[] (one per retry
// — the last one is what counts).
function parsePlaywrightResult(result) {
  if (!result || !Array.isArray(result.suites)) return { tests: null };
  const tests = [];

  function walkSuite(suite, titlePrefix) {
    for (const spec of suite.specs ?? []) {
      const specTitle = titlePrefix ? `${titlePrefix} > ${spec.title}` : spec.title;
      for (const t of spec.tests ?? []) {
        const results = t.results ?? [];
        const last = results[results.length - 1];
        if (!last) continue;
        const passed = last.status === 'passed';
        const durationMs = results.reduce((sum, r) => sum + (r.duration ?? 0), 0);
        tests.push({
          name: specTitle,
          passed,
          duration_ms: durationMs,
          ...(passed ? {} : { message: (last.error?.message ?? last.errors?.map((e) => e.message).join('\n\n')) || '' }),
        });
      }
    }
    for (const child of suite.suites ?? []) {
      walkSuite(child, titlePrefix ? `${titlePrefix} > ${suite.title}` : suite.title);
    }
  }

  for (const suite of result.suites) walkSuite(suite, '');
  // Playwright E2E has no meaningful coverage concept — omitted entirely.
  return { tests };
}

// pytest-json-report's report file: { tests: [{ nodeid, outcome, call/setup/teardown: { duration }, longrepr }] }
function parsePytestReport(report) {
  if (!report || !Array.isArray(report.tests)) return { tests: null };
  const tests = [];
  for (const t of report.tests) {
    if (t.outcome === 'skipped') continue;
    const passed = t.outcome === 'passed';
    const durationMs = Math.round(
      1000 * (['setup', 'call', 'teardown'].reduce((sum, phase) => sum + (t[phase]?.duration ?? 0), 0)),
    );
    tests.push({
      name: t.nodeid,
      passed,
      duration_ms: durationMs,
      ...(passed ? {} : { message: String(t.call?.longrepr ?? t.longrepr ?? '') }),
    });
  }
  return { tests };
}

// pytest-cov's `--cov-report=json` file: { totals: { percent_covered, num_branches, covered_branches } }
function parsePytestCoverage(covReport) {
  const totals = covReport?.totals;
  if (!totals) return null;
  const branchesPct = totals.num_branches > 0
    ? (totals.covered_branches / totals.num_branches) * 100
    : null;
  return {
    lines_pct: typeof totals.percent_covered === 'number' ? totals.percent_covered : null,
    branches_pct: branchesPct,
  };
}

// ── Suite execution ──────────────────────────────────────────────────────────

// Spawns command, capturing stdout/stderr separately (some parsers only trust
// stdout — e.g. Go's -json stream, which stderr build-error text would corrupt
// if merged in). Never rejects, so one suite's crash can't take down the rest
// of the run.
//
// Killed (SIGTERM, escalating to SIGKILL after a 5s grace period) if it runs
// past timeoutMs — reported as a failed, timed-out result rather than left to
// hang, so one stuck suite can't block the rest of the run indefinitely.
function exec(command, args, cwd, env = {}, timeoutMs = SUITE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const start = Date.now();
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let timedOut = false;

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, CI: 'true', FORCE_COLOR: '0', ...env },
      });
    } catch (err) {
      resolve({ exitCode: -1, stdout: '', stderr: err.message, durationMs: Date.now() - start, timedOut: false });
      return;
    }

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }, 5000);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    function finish(exitCode, extraErr) {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      let stderr = Buffer.concat(stderrChunks).toString();
      if (extraErr) stderr += extraErr;
      if (timedOut) stderr += `\n[test-runner] suite killed after exceeding its ${Math.round(timeoutMs / 1000)}s timeout\n`;
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr,
        durationMs: Date.now() - start,
        timedOut,
      });
    }

    child.on('close', (code) => finish(timedOut ? -1 : (code ?? -1)));
    child.on('error', (err) => finish(-1, err.message));
  });
}

function summarize(tests) {
  const numTests = tests.length;
  const numPassed = tests.filter((t) => t.passed).length;
  return { num_tests: numTests, num_passed: numPassed, num_failed: numTests - numPassed };
}

// Runs the Go backend suite via `go test -json -cover`.
async function runBackendSuite() {
  const cwd = path.join(ROOT, 'api');
  const r = await exec('go', ['test', './tests/...', '-json', '-cover', '-count=1'], cwd);
  const parsed = parseGoJSON(r.stdout);
  const output = parsed.output + r.stderr;
  const result = {
    passed: r.exitCode === 0,
    exit_code: r.exitCode,
    output,
    duration_ms: r.durationMs,
    ...summarize(parsed.tests),
  };
  if (parsed.tests.length) result.tests = parsed.tests;
  if (parsed.coverage) result.coverage = parsed.coverage;
  return result;
}

// Runs a Jest suite (frontend unit or mobile) via --json/--coverage, reading
// both result files back rather than parsing stdout (Jest's --json mode
// writes ONLY the JSON blob to --outputFile, but stray haste-map/watchman
// warnings on stderr are still possible and shouldn't break the parse).
async function runJestSuite(cwd) {
  const resultFile = path.join(cwd, '.test-runner-jest-result.json');
  const coverageDir = path.join(cwd, '.test-runner-coverage');
  const r = await exec('npx', [
    'jest', '--ci', '--json', `--outputFile=${resultFile}`,
    '--coverage', `--coverageDirectory=${coverageDir}`, '--coverageReporters=json-summary',
  ], cwd);

  const resultJSON = await readJSONIfExists(resultFile);
  const coverageJSON = await readJSONIfExists(path.join(coverageDir, 'coverage-summary.json'));
  const parsed = parseJestResult(resultJSON);
  const coverage = parseJestCoverageSummary(coverageJSON);

  const passed = resultJSON ? !!resultJSON.success : r.exitCode === 0;
  const tests = parsed.tests ?? [];
  const result = {
    passed,
    exit_code: r.exitCode,
    output: r.stdout + r.stderr,
    duration_ms: r.durationMs,
    ...summarize(tests),
  };
  if (tests.length) result.tests = tests;
  if (coverage) result.coverage = coverage;
  return result;
}

// Runs the Playwright E2E suite via --reporter=json, written to a file via
// PLAYWRIGHT_JSON_OUTPUT_NAME (Playwright's json reporter honors this env var
// instead of printing to stdout, so the default 'list' reporter output stays
// intact for the raw output block).
async function runPlaywrightSuite() {
  const cwd = path.join(ROOT, 'frontend');
  const resultFile = path.join(cwd, '.test-runner-playwright-result.json');
  const r = await exec('npx', ['playwright', 'test', '--reporter=json,list'], cwd, {
    PLAYWRIGHT_BASE_URL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://frontend:80',
    PLAYWRIGHT_JSON_OUTPUT_NAME: resultFile,
  });

  const resultJSON = await readJSONIfExists(resultFile);
  const parsed = parsePlaywrightResult(resultJSON);
  const tests = parsed.tests ?? [];
  const result = {
    passed: r.exitCode === 0,
    exit_code: r.exitCode,
    output: r.stdout + r.stderr,
    duration_ms: r.durationMs,
    ...summarize(tests),
  };
  if (tests.length) result.tests = tests;
  // No coverage entry — Playwright E2E has no meaningful line/branch coverage.
  return result;
}

// Runs the recognition pytest suite via pytest-json-report + pytest-cov.
async function runRecognitionSuite() {
  const cwd = path.join(ROOT, 'recognition');
  const reportFile = path.join(cwd, '.test-runner-pytest-report.json');
  const coverageFile = path.join(cwd, '.test-runner-coverage.json');
  const r = await exec(RECOGNITION_PYTHON, [
    '-m', 'pytest', 'tests/', '-v',
    `--json-report`, `--json-report-file=${reportFile}`,
    '--cov=.', '--cov-branch', `--cov-report=json:${coverageFile}`,
  ], cwd);

  const reportJSON = await readJSONIfExists(reportFile);
  const coverageJSON = await readJSONIfExists(coverageFile);
  const parsed = parsePytestReport(reportJSON);
  const coverage = parsePytestCoverage(coverageJSON);

  const tests = parsed.tests ?? [];
  const result = {
    passed: r.exitCode === 0,
    exit_code: r.exitCode,
    output: r.stdout + r.stderr,
    duration_ms: r.durationMs,
    ...summarize(tests),
  };
  if (tests.length) result.tests = tests;
  if (coverage) result.coverage = coverage;
  return result;
}

// Runs every suite in sequence (not in parallel — this container has limited
// CPU/RAM and go test/npm test/Playwright/pytest would otherwise contend for
// the same cores) and assembles the combined report. Updates currentRun
// before/after each suite so a concurrent GET /progress reflects live status —
// which suite is running now, and the { enabled, result } of every suite
// that's already finished, in the same shape the final report uses.
async function runAllSuites() {
  currentRun = { running: true, currentSuite: null, completed: {} };

  const runners = {
    backend: runBackendSuite,
    frontend: () => runJestSuite(path.join(ROOT, 'frontend')),
    frontend_e2e: runPlaywrightSuite,
    mobile: () => runJestSuite(path.join(ROOT, 'mobile')),
    recognition: runRecognitionSuite,
  };

  const report = {};
  for (const key of SUITE_ORDER) {
    currentRun.currentSuite = key;
    const result = await runners[key]();
    const entry = { enabled: true, result };
    report[key] = entry;
    currentRun.completed[key] = entry;
  }

  currentRun.currentSuite = null;
  currentRun.running = false;
  return report;
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { status: 'ok', running: currentRun.running });
    return;
  }

  if (req.method === 'GET' && req.url === '/progress') {
    json(res, 200, {
      running: currentRun.running,
      current_suite: currentRun.currentSuite,
      order: SUITE_ORDER,
      completed: currentRun.completed,
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/run-tests') {
    if (currentRun.running) {
      json(res, 503, { error: 'a test run is already in progress' });
      return;
    }
    runAllSuites()
      .then((report) => { json(res, 200, report); })
      .catch((err) => { currentRun.running = false; json(res, 500, { error: err.message }); });
    return;
  }

  json(res, 404, { error: 'not found' });
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Unified test runner listening on :${PORT}`);
  });
}

// Exported for unit testing (test-runner/server.test.js) — not used by anyone
// else, this sidecar has no other consumers.
module.exports = {
  parseGoJSON,
  parseJestResult,
  parseJestCoverageSummary,
  parsePlaywrightResult,
  parsePytestReport,
  parsePytestCoverage,
  summarize,
  exec,
};
