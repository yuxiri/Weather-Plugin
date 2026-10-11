import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function validLocation(code = '310101', name = '测试省测试市测试县') {
  return {
    name,
    countryCode: 'CN',
    latitude: 31.2,
    longitude: 121.5,
    geocoder: 'msn',
    providerIds: { placeId: 'MSN_TEST_PLACE' },
    administrativeArea: { countryCode: 'CN', region: '测试省', subregion: '测试市', locality: '测试县', code },
  };
}

test('verified place mappings persist with their MSN identity and load in a fresh module', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'weather-alert-place-cache-'));
  const file = path.join(directory, 'places.json');
  const oldFile = process.env.WEATHER_ALERT_PLACE_CACHE_FILE;
  process.env.WEATHER_ALERT_PLACE_CACHE_FILE = file;
  t.after(async () => {
    if (oldFile == null) delete process.env.WEATHER_ALERT_PLACE_CACHE_FILE;
    else process.env.WEATHER_ALERT_PLACE_CACHE_FILE = oldFile;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const firstModule = await import(`../lib/alert-place-cache.js?place-write-${Date.now()}`);
  assert.equal(await firstModule.setAlertPlaceMapping({
    adminCode: '310101', provinceCode: '310000', cityCode: '310100',
    provinceName: '测试省', cityName: '测试市', countyName: '测试县', location: validLocation(),
  }), true);
  assert.equal(await firstModule.setAlertPlaceMapping({
    adminCode: '4604', provinceCode: '460000', cityCode: '',
    provinceName: '海南省', cityName: '', countyName: '儋州市',
    location: validLocation('4604', '海南省儋州市'),
  }), true);
  await firstModule.flushAlertPlaceCache();

  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.positive[0][1].location.providerIds.placeId, 'MSN_TEST_PLACE');
  assert.equal(saved.positive[0][1].location.longitude, 121.5);

  const nextModule = await import(`../lib/alert-place-cache.js?place-read-${Date.now()}`);
  const restored = await nextModule.getAlertPlaceMapping('310101');
  assert.equal(restored.cacheSource, 'disk');
  assert.equal(restored.location.name, '测试省测试市测试县');
  assert.equal((await nextModule.getAlertPlaceMapping('4604')).location.name, '海南省儋州市');
});

test('negative place cache expires and can be retried after its configured TTL', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'weather-alert-place-negative-'));
  const oldFile = process.env.WEATHER_ALERT_PLACE_CACHE_FILE;
  const oldTtl = process.env.WEATHER_ALERT_PLACE_NEGATIVE_TTL_HOURS;
  const originalNow = Date.now;
  let now = originalNow();
  process.env.WEATHER_ALERT_PLACE_CACHE_FILE = path.join(directory, 'places.json');
  process.env.WEATHER_ALERT_PLACE_NEGATIVE_TTL_HOURS = '1';
  Date.now = () => now;
  t.after(async () => {
    Date.now = originalNow;
    if (oldFile == null) delete process.env.WEATHER_ALERT_PLACE_CACHE_FILE;
    else process.env.WEATHER_ALERT_PLACE_CACHE_FILE = oldFile;
    if (oldTtl == null) delete process.env.WEATHER_ALERT_PLACE_NEGATIVE_TTL_HOURS;
    else process.env.WEATHER_ALERT_PLACE_NEGATIVE_TTL_HOURS = oldTtl;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const cache = await import(`../lib/alert-place-cache.js?negative-${Date.now()}`);
  await cache.setAlertPlaceNegative({
    adminCode: '460302', provinceCode: '460000', cityCode: '460300',
    provinceName: '海南省', cityName: '三沙市', countyName: '西沙区', errorCode: 'location-not-found',
  });
  await cache.flushAlertPlaceCache();
  assert.equal((await cache.getAlertPlaceNegative('460302')).errorCode, 'location-not-found');

  now += 60 * 60 * 1000 + 1;
  assert.equal(await cache.getAlertPlaceNegative('460302'), null);
  await cache.flushAlertPlaceCache();
});

test('corrupt place cache is safely rebuilt as an empty versioned cache', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'weather-alert-place-corrupt-'));
  const file = path.join(directory, 'places.json');
  const oldFile = process.env.WEATHER_ALERT_PLACE_CACHE_FILE;
  process.env.WEATHER_ALERT_PLACE_CACHE_FILE = file;
  t.after(async () => {
    if (oldFile == null) delete process.env.WEATHER_ALERT_PLACE_CACHE_FILE;
    else process.env.WEATHER_ALERT_PLACE_CACHE_FILE = oldFile;
    await fs.rm(directory, { recursive: true, force: true });
  });

  await fs.writeFile(file, '{not-json', 'utf8');
  const cache = await import(`../lib/alert-place-cache.js?corrupt-${Date.now()}`);
  const stats = await cache.getAlertPlaceCacheStats();
  assert.equal(stats.positive, 0);
  assert.equal(stats.negative, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 1, positive: [], negative: [] });
});
