import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  dedupeAggregatedWeatherAlerts,
  getWeatherAlertCoverageSnapshot,
  getWeatherAlertSnapshot,
  normalizeWeatherAlerts,
} from '../lib/alerts.js';
import { getJson } from '../lib/weather.js';
import { findAdministrativeAlertScope, getAdministrativeAlertDataStats } from '../lib/admin-divisions.js';
import { weatherWarningsView } from '../lib/view.js';

process.env.WEATHER_ADMIN_DIVISION_AUTO_UPDATE = '0';
process.env.WEATHER_ALERT_BACKGROUND_REFRESH = '0';
process.env.WEATHER_ALERT_REQUEST_INTERVAL_MS = '0';
const testAlertCacheFile = path.join(os.tmpdir(), `weather-plugin-alert-cache-tests-${process.pid}.json`);
process.env.WEATHER_ALERT_CACHE_FILE = testAlertCacheFile;
const testAggregateCacheFile = path.join(os.tmpdir(), `weather-plugin-alert-region-cache-tests-${process.pid}.json`);
process.env.WEATHER_ALERT_AGGREGATE_CACHE_FILE = testAggregateCacheFile;
const testActiveRegionsFile = path.join(os.tmpdir(), `weather-plugin-alert-active-regions-tests-${process.pid}.json`);
process.env.WEATHER_ALERT_ACTIVE_REGIONS_FILE = testActiveRegionsFile;
const testPlaceCacheFile = path.join(os.tmpdir(), `weather-plugin-alert-place-cache-tests-${process.pid}.json`);
process.env.WEATHER_ALERT_PLACE_CACHE_FILE = testPlaceCacheFile;
after(async () => {
  await fs.rm(testAlertCacheFile, { force: true });
  await fs.rm(testAggregateCacheFile, { force: true });
  await fs.rm(testActiveRegionsFile, { force: true });
  await fs.rm(`${testAlertCacheFile}.${process.pid}`, { force: true });
  await fs.rm(testPlaceCacheFile, { force: true });
});

const liaoning = { name: '辽宁省', countryCode: 'CN', timezone: 'Asia/Shanghai' };
const huludao = { name: '辽宁省葫芦岛市', countryCode: 'CN', timezone: 'Asia/Shanghai' };
const xingcheng = {
  name: '辽宁省葫芦岛市兴城市', countryCode: 'CN', timezone: 'Asia/Shanghai',
  administrativeArea: { countryCode: 'CN', region: '辽宁省', subregion: '葫芦岛市' },
};
const chongqing = { name: '重庆市', countryCode: 'CN', timezone: 'Asia/Shanghai' };
const tongliang = {
  name: '重庆市铜梁区', countryCode: 'CN', timezone: 'Asia/Shanghai',
  administrativeArea: { countryCode: 'CN', region: '重庆市' },
};

function warning(overrides = {}) {
  return {
    key: 'same-source-alert', id: 'CMA_12_O', source: 'msn', sourceAgency: '兴城市气象台',
    event: '大雾', headline: '大雾橙色预警', severity: '橙色', level: '橙色',
    publishedAt: '2026-10-10T01:00:00+08:00', description: '受大雾影响，能见度较低。',
    sourceLabel: 'MSN 天气页面', areas: null, ...overrides,
  };
}

function mockDependencies({ failCountyCode = '', waitMs = 0 } = {}) {
  let active = 0;
  let maxActive = 0;
  const resolveLocation = async query => ({
    name: query,
    latitude: 40,
    longitude: 120,
    timezone: 'Asia/Shanghai',
    countryCode: 'CN',
    administrativeArea: { countryCode: 'CN' },
  });
  const fetchSnapshot = async location => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      if (location.administrativeArea.code === failCountyCode) throw new Error('mock network failure');
      return {
        status: 'ok',
        source: 'msn',
        sourceLabel: 'MSN 天气页面',
        alerts: location.administrativeArea.code === '211481' ? [warning()] : [],
        fetchedAt: new Date().toISOString(),
      };
    } finally { active--; }
  };
  return { resolveLocation, fetchSnapshot, getMaxActive: () => maxActive };
}

test('administrative tree covers mainland provinces, prefectures and county-level divisions', async () => {
  const stats = await getAdministrativeAlertDataStats();
  assert.equal(stats.provinces, 31);
  assert.ok(stats.prefectures > 300);
  assert.ok(stats.counties > 2_700);

  const provinceScope = await findAdministrativeAlertScope('辽宁省', liaoning);
  const cityScope = await findAdministrativeAlertScope('辽宁省葫芦岛市', huludao);
  const countyScope = await findAdministrativeAlertScope('兴城市', xingcheng);
  const municipalityScope = await findAdministrativeAlertScope('重庆市', chongqing);
  const districtScope = await findAdministrativeAlertScope('重庆市铜梁区', tongliang);

  assert.equal(provinceScope.kind, 'province');
  assert.ok(provinceScope.counties.some(item => item.code === '211481' && item.name === '兴城市'));
  assert.equal(cityScope.kind, 'city');
  assert.ok(cityScope.counties.some(item => item.code === '211481'));
  assert.equal(countyScope.kind, 'county');
  assert.deepEqual(countyScope.counties.map(item => item.name), ['兴城市']);
  assert.equal(municipalityScope.kind, 'province');
  assert.ok(municipalityScope.counties.some(item => item.name === '铜梁区'));
  assert.ok(municipalityScope.counties.some(item => item.name === '两江新区' && item.code === '500157'));
  assert.ok(!municipalityScope.counties.some(item => ['江北区', '渝北区'].includes(item.name)));
  assert.equal(districtScope.kind, 'county');
});

test('province and prefecture aggregates include county alerts and stay within the concurrency limit', async () => {
  const provinceDeps = mockDependencies();
  const provinceResult = await getWeatherAlertCoverageSnapshot('辽宁省', liaoning, fetch, { source: 'bing' }, {
    ...provinceDeps, concurrency: 50,
  });
  const cityDeps = mockDependencies();
  const cityResult = await getWeatherAlertCoverageSnapshot('辽宁省葫芦岛市', huludao, fetch, { source: 'bing' }, {
    ...cityDeps, concurrency: 2,
  });

  assert.equal(provinceResult.status, 'ok');
  assert.equal(provinceResult.coverage.successful, 100);
  assert.equal(provinceResult.alerts.length, 1);
  assert.ok(provinceResult.alerts[0].matchedAdministrativeCodes.includes('211481'));
  assert.ok(provinceDeps.getMaxActive() <= 5);
  assert.equal(cityResult.coverage.successful, 6);
  assert.equal(cityResult.alerts.length, 1);
  assert.ok(cityResult.alerts[0].matchedLocations.includes('兴城市'));
  assert.equal(cityResult.scopeNote, '已查询 6/6 个地区');
});

test('county and district queries remain exact-place queries', async () => {
  const deps = mockDependencies();
  let calls = 0;
  const fetchSnapshot = async location => {
    calls++;
    return deps.fetchSnapshot(location);
  };
  const result = await getWeatherAlertCoverageSnapshot('辽宁省葫芦岛市兴城市', xingcheng, fetch, { source: 'bing' }, {
    resolveLocation: deps.resolveLocation, fetchSnapshot,
  });
  const districtResult = await getWeatherAlertCoverageSnapshot('重庆市铜梁区', tongliang, fetch, { source: 'bing' }, {
    resolveLocation: deps.resolveLocation, fetchSnapshot,
  });

  assert.equal(calls, 2);
  assert.equal(result.coverage.kind, 'county');
  assert.equal(districtResult.coverage.kind, 'county');
  assert.match(result.scopeNote, /不向上扩展/);
});

test('deduplication keeps publisher identity and merges a same warning found in multiple counties', () => {
  const same = warning();
  const otherPublisher = warning({ sourceAgency: '葫芦岛市气象台' });
  const alerts = dedupeAggregatedWeatherAlerts([
    { alert: same, county: { code: '211481', name: '兴城市' } },
    { alert: { ...same, key: 'different-coordinate-key' }, county: { code: '211421', name: '绥中县' } },
    { alert: otherPublisher, county: { code: '211422', name: '建昌县' } },
  ]);
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.find(item => item.sourceAgency === '兴城市气象台').matchedLocations, ['兴城市', '绥中县']);
});

test('failed child requests produce a partial result instead of a complete no-alert claim', async () => {
  const deps = mockDependencies({ failCountyCode: '211481' });
  const result = await getWeatherAlertCoverageSnapshot('辽宁省葫芦岛市', huludao, fetch, { source: 'failure-test' }, {
    ...deps, concurrency: 2,
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.failed, 1);
  assert.match(result.scopeNote, /已查询 5\/6 个地区 · 1 个地区查询失败/);
});

test('aggregation time limit reports in-flight and unqueried locations', async () => {
  const deps = mockDependencies({ waitMs: 60 });
  const result = await getWeatherAlertCoverageSnapshot('辽宁省葫芦岛市', huludao, fetch, { source: 'timeout-test' }, {
    ...deps, concurrency: 1, timeoutMs: 15,
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.coverage.failed, 1);
  assert.ok(result.coverage.unqueried > 0);
  await new Promise(resolve => setTimeout(resolve, 70));
});

test('expired and cancelled alerts are removed before display', () => {
  const now = Date.parse('2026-10-10T00:00:00Z');
  const normalized = normalizeWeatherAlerts([
    { event: '大雾', id: 'expired', expires: '2026-10-09T23:00:00Z' },
    { event: '大雾', id: 'cancelled', status: '解除' },
    { event: '暴雨', id: 'upcoming', effective: '2026-10-10T01:00:00Z' },
  ], { source: 'msn', location: { latitude: 39, longitude: 116 } }, now);
  assert.deepEqual(normalized, []);
});

test('warning image labels partial no-alert results and caps long lists with a remainder count', () => {
  const partial = weatherWarningsView(liaoning, {
    status: 'partial', alerts: [], fetchedAt: new Date().toISOString(),
    coverage: { kind: 'province', total: 100, successful: 89, failed: 11, unqueried: 0, complete: false },
  }, '成功查询 89/100 个县级地区。');
  assert.match(partial.warningCardsHtml, /区域预警查询未完成/);
  assert.match(partial.warningCardsHtml, /不能据此确认整个区域无预警/);
  assert.equal(partial.alertCount, '0');

  const alerts = Array.from({ length: 10 }, (_, index) => warning({
    id: `alert-${index}`, headline: `大雾预警${index}`, sourceAgency: `气象台${index}`,
  }));
  const limited = weatherWarningsView(liaoning, {
    status: 'ok', alerts, fetchedAt: new Date().toISOString(),
    coverage: { kind: 'province', total: 100, successful: 100, failed: 0, unqueried: 0, complete: true },
  }, '已查询全部 100 个县级地区。');
  assert.equal((limited.warningCardsHtml.match(/class="warning-card alert-/g) || []).length, 8);
  assert.match(limited.warningCardsHtml, /另有 2 条预警未在本张图片展示/);
});

test('historical warning snapshots are labeled as history and never shown as current', () => {
  const historical = weatherWarningsView(liaoning, {
    status: 'ok', historical: true, alerts: [warning()], fetchedAt: '2026-10-10T01:00:00+08:00',
    scopeNote: '历史快照，正在更新。',
    coverage: { kind: 'province', total: 100, successful: 100, failed: 0, unqueried: 0, complete: true },
  });
  assert.equal(historical.alertCountLabel, '历史快照：1 条');
  assert.match(historical.warningCardsHtml, /历史预警 1/);
  assert.doesNotMatch(historical.warningCardsHtml, /当前暂无生效气象预警/);
  assert.match(historical.scopeNote, /正在更新/);
});

test('point snapshot cache expiry fetches again and no-longer-active alerts disappear', async () => {
  const originalNow = Date.now;
  let now = Date.parse('2026-10-10T00:00:00Z');
  let fetchCount = 0;
  Date.now = () => now;
  const location = { name: '缓存回归测试', latitude: 13.12345, longitude: 17.54321, timezone: 'Asia/Shanghai' };
  const makeResponse = active => {
    fetchCount++;
    const alertRows = active ? [{ event: '大雾', headline: '大雾预警', id: 'cache-alert', expires: '2026-10-10T01:00:00Z' }] : [];
    const state = { alertsInfoList: alertRows };
    const html = `<script id="redux-data" type="application/json">${JSON.stringify({ WeatherData: { '_@STATE@_': state } })}</script>`;
    return { ok: true, text: async () => html };
  };
  const fetcher = async () => makeResponse(fetchCount === 0);
  try {
    const first = await getWeatherAlertSnapshot(location, fetcher, { source: 'bing' });
    const cached = await getWeatherAlertSnapshot(location, fetcher, { source: 'bing' });
    assert.equal(fetchCount, 1);
    assert.equal(first.alerts.length, 1);
    assert.equal(cached.alerts.length, 1);

    now += 5 * 60 * 1000 + 1;
    const refreshed = await getWeatherAlertSnapshot(location, fetcher, { source: 'bing' });
    assert.equal(fetchCount, 2);
    assert.equal(refreshed.alerts.length, 0);
  } finally {
    Date.now = originalNow;
  }
});

test('same regional query shares in-flight work and caches completed aggregate results', async () => {
  const deps = mockDependencies({ waitMs: 20 });
  let calls = 0;
  const fetchSnapshot = async location => {
    calls++;
    return deps.fetchSnapshot(location);
  };
  const settings = { source: 'aggregate-cache-test' };
  const [first, simultaneous] = await Promise.all([
    getWeatherAlertCoverageSnapshot('辽宁省葫芦岛市', huludao, fetch, settings, {
      ...deps, fetchSnapshot,
    }),
    getWeatherAlertCoverageSnapshot('辽宁省葫芦岛市', huludao, fetch, settings, {
      ...deps, fetchSnapshot,
    }),
  ]);
  assert.equal(calls, 6);
  assert.ok(first.coalesced || simultaneous.coalesced);
  assert.equal(first.coverage.successful, 6);
  assert.equal(first.timings.totalMs >= 0, true);
  assert.equal(typeof first.timings.dedupeMs, 'number');
  assert.equal(typeof first.timings.locationResolveMs, 'number');

  const repeated = await getWeatherAlertCoverageSnapshot('辽宁省葫芦岛市', huludao, fetch, settings, {
    ...deps, fetchSnapshot,
  });
  assert.equal(calls, 6);
  assert.equal(repeated.cacheHit, true);
  assert.ok(repeated.cacheAgeMs >= 0);
  assert.equal(repeated.coverage.successful, 6);
});

test('province scans feed county alert cache for later city and county queries', async () => {
  const settings = { source: 'overlapping-area-cache-test' };
  const state = { alertsInfoList: [] };
  const html = `<script id="redux-data" type="application/json">${JSON.stringify({ WeatherData: { '_@STATE@_': state } })}</script>`;
  let networkCalls = 0;
  const fetcher = async () => {
    networkCalls++;
    return { ok: true, text: async () => html };
  };
  const resolveLocation = async query => ({
    name: query, latitude: 40, longitude: 120, timezone: 'Asia/Shanghai', countryCode: 'CN',
    administrativeArea: { countryCode: 'CN' },
  });

  const province = await getWeatherAlertCoverageSnapshot('辽宁省', liaoning, fetcher, settings, { resolveLocation });
  const requestsAfterProvince = networkCalls;
  const city = await getWeatherAlertCoverageSnapshot('辽宁省葫芦岛市', huludao, fetcher, settings, { resolveLocation });
  assert.equal(province.coverage.successful, 100);
  assert.equal(city.coverage.successful, 6);
  assert.equal(networkCalls, requestsAfterProvince);
  assert.equal(city.timings.alertCacheHits, 6);
  assert.deepEqual(city.coverage.requests, { msnPlaceSearch: 0, msnWeatherPage: 0, weatherApi: 0, other: 0 });
});

test('warning image names only the actual provider sources', () => {
  const msn = weatherWarningsView(huludao, {
    source: 'msn', sourceLabel: 'MSN 天气页面', alerts: [],
  });
  assert.equal(msn.sourceNote, '数据来源：MSN 天气 · 气象预警请以官方发布为准。');

  const mixed = weatherWarningsView(huludao, {
    source: 'mixed', sources: ['MSN 天气', 'WeatherAPI.com'], alerts: [],
  });
  assert.equal(mixed.sourceNote, '数据来源：MSN 天气、WeatherAPI · 气象预警请以官方发布为准。');

  const unavailable = weatherWarningsView(huludao, { alerts: [] });
  assert.equal(unavailable.sourceNote, '数据来源：未获取到 · 气象预警请以官方发布为准。');
});

test('MSN and WeatherAPI selections keep the real provider label', async () => {
  const location = {
    name: '数据源切换回归点', latitude: 41.123456, longitude: 121.654321,
    timezone: 'Asia/Shanghai', countryCode: 'CN',
  };
  const msnFetcher = async () => {
    const state = { alertsInfoList: [{ event: '大雾', headline: '大雾橙色预警', id: 'msn-source-test' }] };
    const html = `<script id="redux-data" type="application/json">${JSON.stringify({ WeatherData: { '_@STATE@_': state } })}</script>`;
    return { ok: true, text: async () => html };
  };
  const msn = await getWeatherAlertSnapshot(location, msnFetcher, { source: 'bing' });
  assert.equal(msn.source, 'msn');
  assert.equal(msn.sourceLabel, 'MSN 天气页面');

  const weatherApiFetcher = async () => ({
    ok: true,
    json: async () => ({ alerts: { alert: [{ event: 'Fog', headline: 'WeatherAPI alert', id: 'weatherapi-source-test' }] } }),
  });
  const weatherApi = await getWeatherAlertSnapshot(location, weatherApiFetcher, {
    source: 'weatherapi', weatherApiKey: 'test-key-for-source-label',
  });
  assert.equal(weatherApi.source, 'weatherapi');
  assert.equal(weatherApi.sourceLabel, 'WeatherAPI.com');
});

test('geocoding JSON requests preserve aggregate cancellation signals', async () => {
  const controller = new AbortController();
  let observedSignal;
  const fetcher = async (_url, options) => {
    observedSignal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener(
      'abort', () => reject(options.signal.reason || new Error('aborted')), { once: true },
    ));
  };
  const pending = getJson('https://example.invalid/geocoder', fetcher, { signal: controller.signal });
  controller.abort(new Error('aggregate cancelled'));
  await assert.rejects(pending);
  assert.ok(observedSignal);
  assert.notEqual(observedSignal, controller.signal);
});

test('MSN place parsing keeps a city ending in 州市 intact and matches its province', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'weather-place-cache-'));
  const previousFile = process.env.WEATHER_GEOCODING_CACHE_FILE;
  process.env.WEATHER_GEOCODING_CACHE_FILE = path.join(directory, 'places.json');
  try {
    const { resolveCity } = await import(`../lib/weather.js?place-parse-${Date.now()}`);
    let requestedQuery = '';
    const result = await resolveCity('海南省儋州市', async url => {
      requestedQuery = new URL(url).searchParams.get('q');
      return {
        ok: true, status: 200,
        json: async () => ({ value: [{
          _type: 'Place', id: 'msn-danzhou-test', name: '儋州市',
          geo: { latitude: 19.5212499, longitude: 109.5805831 },
          address: { addressRegion: '海南省', countryIso: 'cn' },
        }] }),
      };
    }, { scope: 'domestic' });
    assert.equal(requestedQuery, '海南省儋州市');
    assert.equal(result.name, '海南省儋州市');
    assert.equal(result.latitude, 19.5212499);
    assert.equal(result.administrativeArea.region, '海南省');

    const district = await resolveCity('海南省海口市秀英区', async () => ({
      ok: true, status: 200,
      json: async () => ({ value: [{
        _type: 'Place', name: '秀英区', geo: { latitude: 20.001, longitude: 110.201 },
        address: { addressRegion: '海南省', addressSubregion: '海口市', countryIso: 'cn' },
      }] }),
    }), { scope: 'domestic' });
    assert.equal(district.name, '海南省海口市秀英区');
    assert.equal(district.administrativeArea.subregion, '海口市');

    const sameStemCounty = await resolveCity('辽宁省抚顺市抚顺县', async () => ({
      ok: true, status: 200,
      json: async () => ({ value: [{
        _type: 'Place', name: '抚顺县', geo: { latitude: 41.78616, longitude: 124.19596 },
        address: { addressRegion: '辽宁省', addressSubregion: '抚顺市', countryIso: 'cn' },
      }] }),
    }), { scope: 'domestic' });
    assert.equal(sameStemCounty.name, '辽宁省抚顺市抚顺县');

    const parentless = await resolveCity('海南省五指山市', async () => ({
      ok: true, status: 200,
      json: async () => ({ value: [{
        _type: 'Place', id: '', name: '五指山市',
        geo: { latitude: 18.77515, longitude: 109.51696 },
        address: { addressCountry: '中华人民共和国', countryIso: 'cn' },
      }] }),
    }), { scope: 'domestic' });
    assert.equal(parentless.name, '海南省五指山市');
    assert.equal(parentless.locationMatchMethod, 'admin-verified-qualified-query-single-exact-candidate');
    assert.equal(parentless.administrativeArea.region, '海南省');

    const queryHistory = [];
    const resolvedAfterBareFallback = await resolveCity('海南省万宁市', async url => {
      const query = new URL(url).searchParams.get('q');
      queryHistory.push(query);
      const value = query === '万宁市' ? [{
        _type: 'Place', name: '万宁市', geo: { latitude: 18.795, longitude: 110.3912902 },
        address: { countryIso: 'cn' },
      }] : [];
      return { ok: true, status: 200, json: async () => ({ value }) };
    }, { scope: 'domestic' });
    assert.deepEqual(queryHistory, ['海南省万宁市', '万宁市']);
    assert.equal(resolvedAfterBareFallback.name, '海南省万宁市');
    assert.equal(resolvedAfterBareFallback.locationMatchMethod,
      'admin-verified-qualified-query-single-exact-candidate');

    await assert.rejects(resolveCity('海南省同名市', async () => ({
      ok: true, status: 200,
      json: async () => ({ value: [
        { _type: 'Place', name: '同名市', geo: { latitude: 18.1, longitude: 109.1 }, address: { countryIso: 'cn' } },
        { _type: 'Place', name: '同名市', geo: { latitude: 29.1, longitude: 110.1 }, address: { countryIso: 'cn' } },
      ] }),
    }), { scope: 'domestic' }), error => error.code === 'location-ambiguous');
  } finally {
    if (previousFile == null) delete process.env.WEATHER_GEOCODING_CACHE_FILE;
    else process.env.WEATHER_GEOCODING_CACHE_FILE = previousFile;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('concurrency limits 1, 2, 3 and 5 cap active region lookups', async () => {
  for (const limit of [1, 2, 3, 5]) {
    const deps = mockDependencies({ waitMs: 2 });
    const result = await getWeatherAlertCoverageSnapshot('辽宁省葫芦岛市', huludao, fetch,
      { source: `concurrency-${limit}` }, { ...deps, concurrency: limit });
    assert.equal(result.coverage.successful, 6);
    assert.ok(deps.getMaxActive() <= limit, `active requests exceeded configured limit ${limit}`);
  }
});

test('global request gate caps simultaneous MSN page requests across separate regions', async () => {
  const previousInterval = process.env.WEATHER_ALERT_REQUEST_INTERVAL_MS;
  process.env.WEATHER_ALERT_REQUEST_INTERVAL_MS = '0';
  let active = 0;
  let maximum = 0;
  let requests = 0;
  const pageFetcher = async () => {
    active++;
    requests++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 35));
      return msnEmptyResponse();
    } finally { active--; }
  };
  try {
    const jobs = Array.from({ length: 8 }, (_, index) => {
      const code = `global-gate-${index}`;
      const deps = oneCountyRegion(code);
      const input = `测试省${index}市`;
      return getWeatherAlertCoverageSnapshot(input, { name: input, countryCode: 'CN' }, pageFetcher,
        { source: `global-request-gate-${index}` }, deps);
    });
    const snapshots = await Promise.all(jobs);
    assert.ok(snapshots.every(snapshot => snapshot.coverage.complete));
    assert.equal(requests, 8);
    assert.ok(maximum <= 3, `simultaneous page requests exceeded global cap: ${maximum}`);
    assert.ok(maximum > 1, 'the test should exercise concurrent requests');
  } finally {
    if (previousInterval == null) delete process.env.WEATHER_ALERT_REQUEST_INTERVAL_MS;
    else process.env.WEATHER_ALERT_REQUEST_INTERVAL_MS = previousInterval;
  }
});

test('region diagnostics distinguish successful empty results from failed queries', async () => {
  const diagnostics = [];
  const deps = mockDependencies();
  const result = await getWeatherAlertCoverageSnapshot('辽宁省葫芦岛市', huludao, fetch,
    { source: 'diagnostic-empty' }, { ...deps, onCountyDiagnostic: item => diagnostics.push(item) });
  assert.equal(result.coverage.resultCounts['success-no-alerts'], 5);
  assert.equal(result.coverage.resultCounts['success-with-alerts'], 1);
  assert.equal(result.coverage.resultCounts['not-queried'], 0);
  assert.equal(diagnostics.length, 6);
  assert.ok(diagnostics.every(item => item.name && item.code && item.categoryLabel));
  assert.ok(diagnostics.some(item => item.category === 'success-no-alerts'));
  assert.ok(diagnostics.some(item => item.category === 'success-with-alerts'));
  assert.ok(diagnostics.every(item => item.queryState === 'finished'));
});

function oneCountyRegion(code) {
  return {
    findScope: async () => ({
      kind: 'city', division: { code: `test-${code}` }, province: { name: '测试省' },
      city: { name: '测试市' }, counties: [{ code, name: '测试县' }],
    }),
    resolveLocation: async query => ({
      name: query, latitude: 39.9, longitude: 116.4, timezone: 'Asia/Shanghai', countryCode: 'CN',
      administrativeArea: { countryCode: 'CN' },
    }),
  };
}

function msnEmptyResponse() {
  const state = { alertsInfoList: [] };
  const html = `<script id="redux-data" type="application/json">${JSON.stringify({ WeatherData: { '_@STATE@_': state } })}</script>`;
  return { ok: true, status: 200, text: async () => html };
}

test('HTTP 429 honors retry flow and records both attempts; successful empty list stays successful', async () => {
  const callbacks = [];
  const deps = oneCountyRegion('42901');
  let calls = 0;
  const fetcher = async () => {
    calls++;
    if (calls === 1) return {
      ok: false, status: 429, headers: { get: name => name === 'retry-after' ? '0' : null },
      text: async () => '',
    };
    return msnEmptyResponse();
  };
  const result = await getWeatherAlertCoverageSnapshot('测试省测试市', { name: '测试省测试市', countryCode: 'CN' },
    fetcher, { source: '429-retry-test' }, { ...deps, concurrency: 1, onCountyDiagnostic: item => callbacks.push(item) });
  assert.equal(calls, 2);
  assert.equal(result.coverage.successful, 1);
  assert.equal(result.coverage.resultCounts['success-no-alerts'], 1);
  assert.equal(result.coverage.realRequests, 2);
  assert.deepEqual(callbacks[0].requests.map(request => request.httpStatus), [429, 200]);
  assert.equal(callbacks[0].retries, 1);
  assert.equal(callbacks[0].pageFetched, true);
  assert.equal(callbacks[0].alertCount, 0);
});

test('HTTP 403 is not retried and a malformed page is classified as a parse failure', async () => {
  const deps403 = oneCountyRegion('40301');
  let forbiddenCalls = 0;
  let forbiddenDiagnostic;
  const forbidden = await getWeatherAlertCoverageSnapshot('测试省测试市', { name: '403测试点', countryCode: 'CN' },
    async () => {
      forbiddenCalls++;
      return { ok: false, status: 403, headers: { get: () => null }, text: async () => '' };
    }, { source: '403-no-retry-test' }, {
      ...deps403, concurrency: 1, onCountyDiagnostic: item => { forbiddenDiagnostic = item; },
    });
  assert.equal(forbiddenCalls, 1);
  assert.equal(forbidden.coverage.failureCounts['network-request-failed'], 1);
  assert.equal(forbiddenDiagnostic.error?.httpStatus, 403, JSON.stringify(forbiddenDiagnostic));
  assert.equal(forbiddenDiagnostic.retries, 0);

  const depsParse = oneCountyRegion('parse01');
  let parseDiagnostic;
  const malformed = await getWeatherAlertCoverageSnapshot('测试省测试市', { name: '解析测试点', countryCode: 'CN' },
    async () => ({ ok: true, status: 200, text: async () => '<html>missing provider state</html>' }),
    { source: 'parse-failure-test' }, {
      ...depsParse, concurrency: 1, onCountyDiagnostic: item => { parseDiagnostic = item; },
    });
  assert.equal(malformed.coverage.failureCounts['page-parse-failed'], 1);
  assert.equal(parseDiagnostic.pageFetched, true);
  assert.equal(parseDiagnostic.error.httpStatus, 200);

  const depsUnsupported = oneCountyRegion('unsupported01');
  let unsupportedDiagnostic;
  const unsupported = await getWeatherAlertCoverageSnapshot('测试省测试市', { name: '不支持测试点', countryCode: 'CN' },
    async () => ({ ok: true, status: 200, text: async () => '<script id="redux-data" type="application/json">{"WeatherData":{"_@STATE@_":{}}}</script>' }),
    { source: 'unsupported-source-test' }, {
      ...depsUnsupported, concurrency: 1, onCountyDiagnostic: item => { unsupportedDiagnostic = item; },
    });
  assert.equal(unsupported.coverage.failureCounts['source-unsupported'], 1);
  assert.equal(unsupportedDiagnostic.pageFetched, true);
  assert.equal(unsupportedDiagnostic.alertDataExtracted, false);
});

test('timeouts are retried finitely and recorded separately from empty results', async () => {
  const deps = oneCountyRegion('timeout01');
  let diagnostic;
  const result = await getWeatherAlertCoverageSnapshot('测试省测试市', { name: '超时测试点', countryCode: 'CN' },
    async () => { throw Object.assign(new Error('mock request timeout'), { name: 'TimeoutError' }); },
    { source: 'timeout-retry-test' }, {
      ...deps, concurrency: 1, onCountyDiagnostic: item => { diagnostic = item; },
    });
  assert.equal(result.coverage.failureCounts['request-timeout'], 1);
  assert.equal(diagnostic.retries, 2);
  assert.equal(diagnostic.requests.length, 3);
  assert.ok(diagnostic.requests.every(item => item.timedOut));
});

test('successful county cache survives a partial failure and only the failed county is fetched again', async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const scope = {
    findScope: async () => ({
      kind: 'city', division: { code: 'test-cache-recovery-city' }, province: { name: '测试省' }, city: { name: '测试市' },
      counties: [{ code: 'test-cache-ok', name: '成功县' }, { code: 'test-cache-fail', name: '失败县' }],
    }),
    resolveLocation: async query => ({
      name: query, latitude: query.includes('失败县') ? 32 : 31, longitude: 118, timezone: 'Asia/Shanghai', countryCode: 'CN',
      administrativeArea: { countryCode: 'CN' },
    }),
  };
  let allowRecovery = false;
  let networkCalls = 0;
  const html = `<script id="redux-data" type="application/json">${JSON.stringify({ WeatherData: { '_@STATE@_': { alertsInfoList: [] } } })}</script>`;
  const fetcher = async url => {
    networkCalls++;
    if (!allowRecovery && String(url).includes('in-32,118')) {
      return { ok: false, status: 403, headers: { get: () => null }, text: async () => '' };
    }
    return { ok: true, status: 200, text: async () => html };
  };
  try {
    const settings = { source: 'county-cache-recovery-test' };
    const first = await getWeatherAlertCoverageSnapshot('测试省测试市', { name: '测试省测试市', countryCode: 'CN' }, fetcher,
      settings, { ...scope, concurrency: 2 });
    assert.equal(first.coverage.successful, 1);
    assert.equal(first.coverage.failed, 1);
    assert.equal(networkCalls, 2);

    allowRecovery = true;
    now += 31_000;
    const recovered = await getWeatherAlertCoverageSnapshot('测试省测试市', { name: '测试省测试市', countryCode: 'CN' }, fetcher,
      settings, { ...scope, concurrency: 2, forceRefresh: true });
    assert.equal(recovered.coverage.successful, 2);
    assert.equal(recovered.coverage.failed, 0);
    assert.equal(networkCalls, 3);
    assert.equal(recovered.timings.alertCacheHits, 1);
  } finally {
    Date.now = originalNow;
  }
});

test('verified county mappings are reused across different regional alert cache keys', async () => {
  const scopeDependencies = oneCountyRegion('310101');
  let resolutions = 0;
  let warningQueries = 0;
  scopeDependencies.resolveLocation = async query => {
    resolutions++;
    return {
      name: query, latitude: 31.2, longitude: 121.5, timezone: 'Asia/Shanghai', countryCode: 'CN', geocoder: 'msn',
      providerIds: { placeId: 'MSN_TEST_310101' },
      administrativeArea: { countryCode: 'CN', region: '测试省', subregion: '测试市', locality: '测试县' },
    };
  };
  const fetchSnapshot = async () => {
    warningQueries++;
    return { status: 'ok', source: 'msn', alerts: [], fetchedAt: new Date().toISOString() };
  };
  const location = { name: '测试省测试市测试县', countryCode: 'CN' };
  const first = await getWeatherAlertCoverageSnapshot('测试省测试市', location, async () => {
    throw new Error('place cache test should not use direct fetch');
  }, { source: 'place-cache-first' }, { ...scopeDependencies, fetchSnapshot, backgroundRefresh: false });
  const second = await getWeatherAlertCoverageSnapshot('测试省测试市', location, async () => {
    throw new Error('place cache test should not use direct fetch');
  }, { source: 'place-cache-second' }, { ...scopeDependencies, fetchSnapshot, backgroundRefresh: false });

  assert.equal(first.coverage.successful, 1);
  assert.equal(second.coverage.successful, 1);
  assert.equal(resolutions, 1);
  assert.equal(warningQueries, 2);
  assert.equal(second.timings.placeMappingCacheHits, 1);
  const saved = JSON.parse(await fs.readFile(testPlaceCacheFile, 'utf8'));
  assert.equal(saved.positive.some(([code]) => code === '310101'), true);
});

test('negative place cache avoids repeated location searches and remains a coverage failure', async () => {
  const deps = oneCountyRegion('460302');
  let resolutions = 0;
  deps.resolveLocation = async () => {
    resolutions++;
    const error = new Error('MSN location not found');
    error.code = 'location-not-found';
    error.stage = 'location';
    throw error;
  };
  let secondDiagnostic;
  const fetcher = async () => { throw new Error('unresolved place must not make weather requests'); };
  const location = { name: '海南省测试市', countryCode: 'CN' };
  const first = await getWeatherAlertCoverageSnapshot('海南省测试市', location, fetcher,
    { source: 'place-negative-first' }, { ...deps, backgroundRefresh: false });
  const second = await getWeatherAlertCoverageSnapshot('海南省测试市', location, fetcher,
    { source: 'place-negative-second' }, {
      ...deps, backgroundRefresh: false, onCountyDiagnostic: diagnostic => { secondDiagnostic = diagnostic; },
    });

  assert.equal(first.coverage.failureCounts['location-resolution-failed'], 1);
  assert.equal(second.coverage.failureCounts['location-resolution-failed'], 1);
  assert.equal(second.coverage.successful, 0);
  assert.equal(resolutions, 1);
  assert.equal(second.coverage.realRequests, 0);
  assert.equal(second.timings.negativePlaceCacheHits, 1);
  assert.equal(secondDiagnostic.cache.negativeLocation, true);
});

test('background retry refreshes a transient county failure without re-fetching successful data', async () => {
  const originalNow = Date.now;
  const originalRetries = process.env.WEATHER_ALERT_REQUEST_RETRIES;
  const originalBackgroundRefresh = process.env.WEATHER_ALERT_BACKGROUND_REFRESH;
  let now = originalNow();
  Date.now = () => now;
  process.env.WEATHER_ALERT_REQUEST_RETRIES = '0';
  process.env.WEATHER_ALERT_BACKGROUND_REFRESH = '1';

  const deps = oneCountyRegion('background-retry-01');
  const diagnostics = [];
  let calls = 0;
  const fetchSnapshot = async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('mock HTTP 503'), { code: 'http-503', httpStatus: 503 });
    return { status: 'ok', source: 'msn', alerts: [], fetchedAt: new Date().toISOString() };
  };
  const settings = { source: 'background-retry-test' };
  try {
    const first = await getWeatherAlertCoverageSnapshot('测试省测试市', { name: '测试省测试市', countryCode: 'CN' },
      async () => { throw new Error('the injected snapshot fetcher should be used'); }, settings, {
        ...deps, fetchSnapshot, concurrency: 1, backgroundRetryDelayMs: 0,
        onCountyDiagnostic: item => diagnostics.push(item),
      });
    assert.equal(first.coverage.failureCounts['network-request-failed'], 1);
    assert.equal(calls, 1);

    now += 31_000;
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(calls, 2);
    assert.equal(diagnostics.length, 2);
    assert.equal(diagnostics[1].category, 'success-no-alerts');
    assert.equal(diagnostics[1].cache.alerts, false);
  } finally {
    Date.now = originalNow;
    if (originalRetries == null) delete process.env.WEATHER_ALERT_REQUEST_RETRIES;
    else process.env.WEATHER_ALERT_REQUEST_RETRIES = originalRetries;
    if (originalBackgroundRefresh == null) delete process.env.WEATHER_ALERT_BACKGROUND_REFRESH;
    else process.env.WEATHER_ALERT_BACKGROUND_REFRESH = originalBackgroundRefresh;
  }
});

test('all failed region queries display data retrieval failure rather than no alerts', () => {
  const image = weatherWarningsView(liaoning, {
    status: 'partial', alerts: [],
    coverage: { kind: 'province', total: 26, successful: 0, failed: 26, unqueried: 0, complete: false },
  });
  assert.match(image.warningCardsHtml, /预警数据获取失败/);
  assert.doesNotMatch(image.warningCardsHtml, /当前暂无生效气象预警/);
});

test('successful alert snapshots survive a fresh module instance and restore from disk cache', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'weather-alert-cache-'));
  const cacheFile = path.join(directory, 'alerts.json');
  const previousFile = process.env.WEATHER_ALERT_CACHE_FILE;
  process.env.WEATHER_ALERT_CACHE_FILE = cacheFile;
  try {
    const firstModule = await import(`../lib/alerts.js?cache-write-${Date.now()}`);
    const location = {
      name: '持久化预警缓存测试点', latitude: 9.123456, longitude: 18.654321,
      timezone: 'Asia/Shanghai', countryCode: 'CN',
    };
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return msnEmptyResponse();
    };
    await firstModule.getWeatherAlertSnapshot(location, fetcher, { source: 'bing' });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok((await fs.stat(cacheFile)).size > 0);
    const saved = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    assert.equal(saved.entries.length, 1);

    const restoredModule = await import(`../lib/alerts.js?cache-read-${Date.now()}`);
    const restored = await restoredModule.getWeatherAlertSnapshot(location, async () => {
      throw new Error('persistent cache should avoid network access');
    }, { source: 'bing' });
    assert.equal(calls, 1);
    assert.equal(restored.cacheHit, true);
    assert.equal(restored.alerts.length, 0);
  } finally {
    if (previousFile == null) delete process.env.WEATHER_ALERT_CACHE_FILE;
    else process.env.WEATHER_ALERT_CACHE_FILE = previousFile;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('regional aggregate cache survives a fresh module instance and skips county requests', async () => {
  const deps = oneCountyRegion('persisted-aggregate-01');
  const settings = { source: 'persisted-aggregate-test' };
  const previousBackgroundRefresh = process.env.WEATHER_ALERT_BACKGROUND_REFRESH;
  let calls = 0;
  const fetchSnapshot = async () => {
    calls++;
    return { status: 'ok', source: 'msn', alerts: [], fetchedAt: new Date().toISOString() };
  };
  const input = '测试省测试市持久化汇总';
  const location = { name: input, countryCode: 'CN', timezone: 'Asia/Shanghai' };
  await getWeatherAlertCoverageSnapshot(input, location, fetch, settings, {
    ...deps, fetchSnapshot, backgroundRefresh: false,
  });
  assert.equal(calls, 1);
  await new Promise(resolve => setTimeout(resolve, 150));

  const freshModule = await import(`../lib/alerts.js?aggregate-persist-${Date.now()}`);
  const restored = await freshModule.getWeatherAlertCoverageSnapshot(input, location, fetch, settings, {
    ...deps, fetchSnapshot: async () => { throw new Error('disk aggregate cache should skip this request'); },
    backgroundRefresh: false,
  });
  assert.equal(restored.cacheHit, true);
  assert.equal(restored.coverage.successful, 1);
  assert.equal(calls, 1);
  try {
    process.env.WEATHER_ALERT_BACKGROUND_REFRESH = '1';
    const activeCount = await freshModule.initializeWeatherAlertBackgroundRefresh(fetch, async () => settings);
    assert.equal(activeCount, 1);
  } finally {
    freshModule.stopWeatherAlertBackgroundRefresh();
    if (previousBackgroundRefresh == null) delete process.env.WEATHER_ALERT_BACKGROUND_REFRESH;
    else process.env.WEATHER_ALERT_BACKGROUND_REFRESH = previousBackgroundRefresh;
  }
});

test('expired aggregate returns a historical snapshot while a background refresh runs', async () => {
  const originalNow = Date.now;
  const originalBackgroundRefresh = process.env.WEATHER_ALERT_BACKGROUND_REFRESH;
  let now = originalNow();
  Date.now = () => now;
  process.env.WEATHER_ALERT_BACKGROUND_REFRESH = '1';
  const deps = oneCountyRegion('historical-refresh-01');
  const input = '测试省测试市历史刷新';
  const location = { name: input, countryCode: 'CN', timezone: 'Asia/Shanghai' };
  let fetchCount = 0;
  let backgroundDone;
  const backgroundComplete = new Promise(resolve => { backgroundDone = resolve; });
  const fetchSnapshot = async () => {
    fetchCount++;
    return { status: 'ok', source: 'msn', alerts: [], fetchedAt: new Date(now).toISOString() };
  };
  try {
    const first = await getWeatherAlertCoverageSnapshot(input, location, fetch, { source: 'historical-refresh-test' }, {
      ...deps, fetchSnapshot, backgroundRefresh: false,
    });
    assert.equal(first.status, 'ok');
    assert.equal(fetchCount, 1);

    now += 5 * 60 * 1000 + 1000;
    const historical = await getWeatherAlertCoverageSnapshot(input, location, fetch, { source: 'historical-refresh-test' }, {
      ...deps, fetchSnapshot, backgroundRefresh: true,
      onBackgroundRefreshResult: result => backgroundDone(result),
    });
    assert.equal(historical.historical, true);
    assert.match(historical.scopeNote, /历史快照/);
    const result = await Promise.race([
      backgroundComplete,
      new Promise((_, reject) => setTimeout(() => reject(new Error('background refresh timed out')), 1000)),
    ]);
    assert.equal(result.complete, true);
    assert.equal(fetchCount, 2);

    const refreshed = await getWeatherAlertCoverageSnapshot(input, location, fetch, { source: 'historical-refresh-test' }, {
      ...deps, fetchSnapshot, backgroundRefresh: true,
    });
    assert.equal(refreshed.historical, false);
    assert.equal(refreshed.cacheHit, true);
  } finally {
    Date.now = originalNow;
    if (originalBackgroundRefresh == null) delete process.env.WEATHER_ALERT_BACKGROUND_REFRESH;
    else process.env.WEATHER_ALERT_BACKGROUND_REFRESH = originalBackgroundRefresh;
  }
});

test('a damaged point alert cache is ignored and rebuilt from a successful provider response', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'weather-alert-cache-corrupt-'));
  const cacheFile = path.join(directory, 'alerts.json');
  const previousFile = process.env.WEATHER_ALERT_CACHE_FILE;
  process.env.WEATHER_ALERT_CACHE_FILE = cacheFile;
  t.after(async () => {
    if (previousFile == null) delete process.env.WEATHER_ALERT_CACHE_FILE;
    else process.env.WEATHER_ALERT_CACHE_FILE = previousFile;
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.writeFile(cacheFile, '{broken', 'utf8');
  const module = await import(`../lib/alerts.js?corrupt-point-cache-${Date.now()}`);
  let requests = 0;
  const location = { name: '损坏缓存恢复测试点', latitude: 15.123, longitude: 108.456, timezone: 'Asia/Shanghai', countryCode: 'CN' };
  const snapshot = await module.getWeatherAlertSnapshot(location, async () => {
    requests++;
    return msnEmptyResponse();
  }, { source: 'bing' });
  assert.equal(requests, 1);
  assert.equal(snapshot.status, 'ok');
  assert.deepEqual(snapshot.alerts, []);
  await new Promise(resolve => setTimeout(resolve, 150));
  const repaired = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  assert.equal(repaired.version, 1);
  assert.equal(repaired.entries.length, 1);
});
