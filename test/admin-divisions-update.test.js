import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_DIVISION_RETRY_INTERVAL_MS,
  ADMIN_DIVISION_UPDATE_INTERVAL_MS,
  refreshAdministrativeDivisionData,
} from '../lib/admin-divisions.js';

const bundledPath = fileURLToPath(new URL('../resources/admin-divisions.json', import.meta.url));
const fixture = JSON.parse(await fs.readFile(bundledPath, 'utf8'));

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'weather-admin-divisions-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('downloads, validates and atomically stores an updated administrative division dataset', async t => {
  const directory = await temporaryDirectory(t);
  const dataFile = path.join(directory, 'admin-divisions.json');
  const metaFile = path.join(directory, 'admin-divisions-meta.json');
  const source = { id: 'test', dataUrl: 'https://test.invalid/data.json', readmeUrl: 'https://test.invalid/README.md' };
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    if (url === source.dataUrl) {
      return new Response(JSON.stringify(fixture), { status: 200, headers: { etag: '"dataset-v2"' } });
    }
    return new Response('数据截止日期为2026年10月1日。', { status: 200 });
  };

  const now = Date.parse('2026-10-10T00:00:00Z');
  const result = await refreshAdministrativeDivisionData({ dataFile, metaFile, sources: [source], fetcher, now });

  assert.equal(result.updated, true);
  assert.equal(result.dataDate, '2026-10-01');
  assert.deepEqual(calls, [source.dataUrl, source.readmeUrl]);
  assert.deepEqual(JSON.parse(await fs.readFile(dataFile, 'utf8')), fixture);
  const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
  assert.equal(meta.etag, '"dataset-v2"');
  assert.equal(Date.parse(meta.nextAttemptAt), now + ADMIN_DIVISION_UPDATE_INTERVAL_MS);
});

test('does not download again before the saved next-check time', async t => {
  const directory = await temporaryDirectory(t);
  const dataFile = path.join(directory, 'admin-divisions.json');
  const metaFile = path.join(directory, 'admin-divisions-meta.json');
  const now = Date.parse('2026-10-10T00:00:00Z');
  await fs.writeFile(dataFile, JSON.stringify(fixture));
  await fs.writeFile(metaFile, JSON.stringify({ dataDate: '2025-12-31', nextAttemptAt: new Date(now + 10_000).toISOString() }));
  let calls = 0;

  const result = await refreshAdministrativeDivisionData({
    dataFile,
    metaFile,
    sources: [{ id: 'test', dataUrl: 'https://test.invalid/data', readmeUrl: 'https://test.invalid/readme' }],
    fetcher: async () => { calls++; throw new Error('should not be called'); },
    now,
  });

  assert.equal(result.skipped, true);
  assert.equal(calls, 0);
});

test('extends an older saved schedule to the 180-day interval', async t => {
  const directory = await temporaryDirectory(t);
  const dataFile = path.join(directory, 'admin-divisions.json');
  const metaFile = path.join(directory, 'admin-divisions-meta.json');
  const now = Date.parse('2026-10-10T00:00:00Z');
  const lastSuccessAt = now - 20 * 24 * 60 * 60 * 1000;
  await fs.writeFile(dataFile, JSON.stringify(fixture));
  await fs.writeFile(metaFile, JSON.stringify({
    dataDate: '2025-12-31',
    lastSuccessAt: new Date(lastSuccessAt).toISOString(),
    lastAttemptAt: new Date(lastSuccessAt).toISOString(),
    nextAttemptAt: new Date(lastSuccessAt + 10 * 24 * 60 * 60 * 1000).toISOString(),
  }));
  let calls = 0;

  const result = await refreshAdministrativeDivisionData({
    dataFile,
    metaFile,
    sources: [{ id: 'test', dataUrl: 'https://test.invalid/data', readmeUrl: 'https://test.invalid/readme' }],
    fetcher: async () => { calls++; throw new Error('should not be called'); },
    now,
  });

  assert.equal(result.skipped, true);
  assert.equal(Date.parse(result.dataDate), Date.parse('2025-12-31'));
  assert.equal(calls, 0);
  assert.equal(ADMIN_DIVISION_UPDATE_INTERVAL_MS, 180 * 24 * 60 * 60 * 1000);
  const normalizedMeta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
  assert.equal(Date.parse(normalizedMeta.nextAttemptAt), lastSuccessAt + ADMIN_DIVISION_UPDATE_INTERVAL_MS);
});

test('rejects invalid data, keeps the previous dataset and waits before retrying', async t => {
  const directory = await temporaryDirectory(t);
  const dataFile = path.join(directory, 'admin-divisions.json');
  const metaFile = path.join(directory, 'admin-divisions-meta.json');
  await fs.writeFile(dataFile, JSON.stringify(fixture));
  const source = { id: 'test', dataUrl: 'https://test.invalid/data.json', readmeUrl: 'https://test.invalid/README.md' };
  let calls = 0;
  const now = Date.parse('2026-10-10T00:00:00Z');

  const result = await refreshAdministrativeDivisionData({
    dataFile,
    metaFile,
    sources: [source],
    fetcher: async () => { calls++; return new Response('[]', { status: 200 }); },
    now,
  });

  assert.equal(result.updated, false);
  assert.match(result.error, /省级节点数量异常/u);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(dataFile, 'utf8')), fixture);
  const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
  assert.equal(Date.parse(meta.nextAttemptAt), now + ADMIN_DIVISION_RETRY_INTERVAL_MS);
});
