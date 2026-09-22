const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  MAX_RECORDS,
  fetchWithRetry,
  mergeRecentRecords,
  migrateDataPayload,
  selectMostRecentRecords,
  updateLongevityLog
} = require('../scripts/update-data');

function record(second) {
  return { timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(), voltage: second };
}

function response(body, status = 200, contentType = 'application/json') {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

function records(count, start = 0) {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 0, 1) + (start + index) * 1000).toISOString(),
    value: start + index
  }));
}

test('accepts a valid JSON response', async () => {
  const payload = await fetchWithRetry('https://hidden.invalid', {
    fetchImplementation: async () => response(JSON.stringify([record(1)])), retryBaseDelayMs: 0
  });
  assert.equal(payload.length, 1);
});

test('retries HTTP 500 before success', async () => {
  let calls = 0;
  const payload = await fetchWithRetry('https://hidden.invalid', {
    fetchImplementation: async () => (++calls === 1
      ? response('temporary', 500, 'text/plain')
      : response(JSON.stringify([record(2)]))),
    retryBaseDelayMs: 0
  });
  assert.equal(calls, 2);
  assert.equal(payload[0].voltage, 2);
});

test('retries malformed JSON before success', async () => {
  let calls = 0;
  const payload = await fetchWithRetry('https://hidden.invalid', {
    fetchImplementation: async () => (++calls === 1
      ? response('[{"timestamp":', 200)
      : response(JSON.stringify([record(2)]))),
    retryBaseDelayMs: 0
  });
  assert.equal(calls, 2);
  assert.equal(payload[0].voltage, 2);
});

test('retries a timeout before success', async () => {
  let calls = 0;
  const payload = await fetchWithRetry('https://hidden.invalid', {
    timeoutMs: 5,
    retryBaseDelayMs: 0,
    fetchImplementation: (_url, { signal }) => {
      calls += 1;
      if (calls > 1) return Promise.resolve(response(JSON.stringify([record(3)])));
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
  });
  assert.equal(calls, 2);
  assert.equal(payload[0].voltage, 3);
});

test('rejects an unexpected object and exhausts bounded retries', async () => {
  let calls = 0;
  await assert.rejects(fetchWithRetry('https://hidden.invalid', {
    maxRetries: 3,
    retryBaseDelayMs: 0,
    fetchImplementation: async () => { calls += 1; return response('{"error":"temporary"}'); }
  }), /expected an array/);
  assert.equal(calls, 3);
});

test('does not retry a permanent HTTP authorization error', async () => {
  let calls = 0;
  await assert.rejects(fetchWithRetry('https://hidden.invalid', {
    retryBaseDelayMs: 0,
    fetchImplementation: async () => { calls += 1; return response('denied', 403, 'text/plain'); }
  }), /HTTP 403/);
  assert.equal(calls, 1);
});

test('selects only the latest 5000 records', () => {
  const selected = selectMostRecentRecords(records(6000));
  assert.equal(selected.length, MAX_RECORDS);
  assert.equal(selected[0].value, 1000);
});

test('5000 existing plus 10 incremental records preserves a 5000-record window', () => {
  const merged = mergeRecentRecords(records(5000), records(10, 5000));
  assert.equal(merged.length, 5000);
  assert.equal(merged[0].value, 10);
  assert.equal(merged.at(-1).value, 5009);
});

test('5000 existing plus a full historical response keeps the newest 5000 records', () => {
  const merged = mergeRecentRecords(records(5000, 100000), records(100000));
  assert.equal(merged.length, 5000);
  assert.equal(merged[0].value, 100000);
  assert.equal(merged.at(-1).value, 104999);
});

test('5000 existing plus zero new records remains unchanged', () => {
  const existing = records(5000);
  assert.deepEqual(mergeRecentRecords(existing, []), existing);
});

test('4900 existing plus 100 new records produces 5000 records', () => {
  const merged = mergeRecentRecords(records(4900), records(100, 4900));
  assert.equal(merged.length, 5000);
  assert.equal(merged[0].value, 0);
  assert.equal(merged.at(-1).value, 4999);
});

test('overlapping incremental records are deduplicated by timestamp', () => {
  const existing = records(5000);
  const overlap = existing.slice(-25).map((entry) => ({ ...entry, replacement: true }));
  const merged = mergeRecentRecords(existing, overlap);
  assert.equal(merged.length, 5000);
  assert.equal(new Set(merged.map((entry) => entry.timestamp)).size, 5000);
  assert.equal(merged.at(-1).replacement, true);
});

test('full 100000-record response retains only its newest 5000 records', () => {
  const merged = mergeRecentRecords(records(5000), records(100000));
  assert.equal(merged.length, 5000);
  assert.equal(merged[0].value, 95000);
  assert.equal(merged.at(-1).value, 99999);
});

test('incremental 10-record response preserves the existing rolling history', () => {
  const existing = records(5000);
  const incremental = records(10, 5000);
  const fetchedRecords = selectMostRecentRecords(incremental);
  const merged = mergeRecentRecords(existing, fetchedRecords);
  assert.equal(merged.length, 5000);
  assert.deepEqual(merged.slice(0, 4990), existing.slice(10));
  assert.deepEqual(merged.slice(-10), incremental);
});

test('migration retains newest 5000 valid records and preserves metadata', () => {
  const metadata = {
    updatedAt: '2026-09-18T10:08:30.460Z',
    connected: true,
    hasNewData: true,
    disconnectedReason: null
  };
  const migrated = migrateDataPayload({ ...metadata, records: [...records(20000), { invalid: true }] });
  assert.deepEqual({
    updatedAt: migrated.updatedAt,
    connected: migrated.connected,
    hasNewData: migrated.hasNewData,
    disconnectedReason: migrated.disconnectedReason
  }, metadata);
  assert.equal(migrated.records.length, 5000);
  assert.equal(migrated.records[0].value, 15000);
  assert.equal(migrated.records.at(-1).value, 19999);
});

test('checked-in production data is a 5000-record chronological rolling dataset', async () => {
  const production = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'data.json'), 'utf8'));
  assert.equal(production.records.length, 5000);
  assert.deepEqual(production.records, selectMostRecentRecords(production.records));
});

test('rolling truncation preserves longevity birth and creates no duplicate birth', () => {
  const birth = '2025-01-01T00:00:00.000Z';
  const current = { entries: [{ id: 7, birth, death: null, status: 'alive', detectedAt: birth, timeline: [] }] };
  const recent = [record(1), record(2)];
  const once = updateLongevityLog(current, recent, true, '2026-01-01T00:01:00.000Z');
  const twice = updateLongevityLog(once, recent.slice(-1), true, '2026-01-01T00:02:00.000Z');
  assert.equal(twice.entries.length, 1);
  assert.equal(twice.entries[0].birth, birth);
  assert.equal(twice.entries[0].id, 7);
});

test('production updater fetches the configured WEB_APP_URL unchanged without limit or after', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruit-battery-'));
  const dataFile = path.join(directory, 'data.json');
  const longevityFile = path.join(directory, 'longevity.json');
  await fs.writeFile(dataFile, JSON.stringify({ records: [record(1)] }));
  await fs.writeFile(longevityFile, JSON.stringify({ entries: [] }));

  let requestedPath;
  const server = http.createServer((request, reply) => {
    requestedPath = request.url;
    reply.writeHead(200, { 'content-type': 'application/json' });
    reply.end(JSON.stringify([record(2)]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const configuredPath = '/secret?mode=read&token=private-value';

  const child = spawn(process.execPath, ['scripts/update-data.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      WEB_APP_URL: `http://127.0.0.1:${server.address().port}${configuredPath}`,
      DATA_FILE: dataFile,
      LONGEVITY_FILE: longevityFile
    },
    stdio: 'ignore'
  });
  const exitCode = await new Promise((resolve) => child.on('exit', resolve));

  assert.equal(exitCode, 0);
  assert.equal(requestedPath, configuredPath);
  const requestedUrl = new URL(requestedPath, 'http://localhost');
  assert.equal(requestedUrl.searchParams.has('limit'), false);
  assert.equal(requestedUrl.searchParams.has('after'), false);
});

test('HTTP 404 exits nonzero and leaves data.json and longevity.json byte-for-byte unchanged', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruit-battery-'));
  const dataFile = path.join(directory, 'data.json');
  const longevityFile = path.join(directory, 'longevity.json');
  const originalData = '{"sentinel":"data"}\n';
  const originalLongevity = '{"sentinel":"longevity"}\n';
  await fs.writeFile(dataFile, originalData);
  await fs.writeFile(longevityFile, originalLongevity);

  const server = http.createServer((_request, reply) => {
    reply.writeHead(404, { 'content-type': 'text/plain' });
    reply.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const child = spawn(process.execPath, ['scripts/update-data.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      WEB_APP_URL: `http://127.0.0.1:${server.address().port}/secret`,
      DATA_FILE: dataFile,
      LONGEVITY_FILE: longevityFile
    },
    stdio: 'ignore'
  });
  const exitCode = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(exitCode, 1);
  assert.equal(await fs.readFile(dataFile, 'utf8'), originalData);
  assert.equal(await fs.readFile(longevityFile, 'utf8'), originalLongevity);
});
