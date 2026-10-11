import { clearGeocodingCache, getMsnWeatherAlertData, getWeatherApiAlertData, resolveCity } from './weather.js';
import { ADMIN_DIVISION_DATA_DATE, ADMIN_DIVISION_DATA_SOURCE, findAdministrativeAlertScope } from './admin-divisions.js';
import {
  clearAlertPlaceCache, deleteAlertPlaceEntry, flushAlertPlaceCache,
  getAlertPlaceCacheStats, getAlertPlaceMapping, getAlertPlaceNegative,
  setAlertPlaceMapping, setAlertPlaceNegative,
} from './alert-place-cache.js';

export { getAlertPlaceCacheStats };
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ALERT_CACHE_TTL = configuredInteger('WEATHER_ALERT_CACHE_TTL_MS', 5 * 60 * 1000, 30_000, 60 * 60 * 1000);
const AGGREGATE_CACHE_TTL = configuredInteger('WEATHER_ALERT_AGGREGATE_CACHE_TTL_MS', 5 * 60 * 1000, 30_000, 60 * 60 * 1000);
const FAILED_COUNTY_RETRY_TTL = 30 * 1000;
const COUNTY_LOCATION_CACHE_TTL = 90 * 24 * 60 * 60 * 1000;
const ACTIVE_REGION_TTL_MS = configuredInteger('WEATHER_ALERT_ACTIVE_REGION_TTL_MS', 45 * 60 * 1000, 60_000, 12 * 60 * 60 * 1000);
const REFRESH_LEAD_MS = configuredInteger('WEATHER_ALERT_REFRESH_LEAD_MS', 90 * 1000, 0, 4 * 60 * 1000);
const AGGREGATE_STALE_TTL_MS = configuredInteger('WEATHER_ALERT_AGGREGATE_STALE_TTL_MS', 24 * 60 * 60 * 1000, 5 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
const ACTIVE_REGION_LIMIT = configuredInteger('WEATHER_ALERT_ACTIVE_REGION_LIMIT', 10, 1, 100);
const ALERT_CACHE_LIMIT = 1000;
const COUNTY_REQUEST_TIMEOUT_MS = configuredInteger('WEATHER_ALERT_COUNTY_TIMEOUT_MS', 25_000, 1_000, 60_000);
const FAILURE_CACHE_LIMIT = 3_000;
const DEFAULT_AGGREGATE_CONCURRENCY = 3;
const MAX_AGGREGATE_CONCURRENCY = 5;
const MAX_AGGREGATE_DURATION_MS = 90_000;
const DEFAULT_REQUEST_INTERVAL_MS = 250;
const DEFAULT_REQUEST_RETRIES = 2;
const GLOBAL_REQUEST_CONCURRENCY = configuredInteger('WEATHER_ALERT_GLOBAL_CONCURRENCY', DEFAULT_AGGREGATE_CONCURRENCY, 1, MAX_AGGREGATE_CONCURRENCY);
const alertCacheFile = () => path.resolve(process.env.WEATHER_ALERT_CACHE_FILE || 'data/weather-panel/alert-cache.json');
const aggregateCacheFile = () => path.resolve(process.env.WEATHER_ALERT_AGGREGATE_CACHE_FILE || 'data/weather-panel/alert-region-cache.json');
const activeRegionsFile = () => path.resolve(process.env.WEATHER_ALERT_ACTIVE_REGIONS_FILE || 'data/weather-panel/alert-active-regions.json');
const alertCache = new Map();
const alertRequests = new Map();
const aggregateRequests = new Map();
const aggregateRequestBackground = new Set();
const aggregateCache = new Map();
const activeRegions = new Map();
const activeRegionContexts = new Map();
const countyLocationCache = new Map();
const countyLocationRequests = new Map();
const countyFailureCache = new Map();
const hostRequestStates = new Map();
const backgroundRetryStates = new Map();
const regionRefreshStates = new Map();
const globalRequestWaiters = [];
const backgroundControllers = new Set();
let alertCacheLoad;
let alertCacheWrite = Promise.resolve();
let alertCacheWriteTimer;
let aggregateCacheLoad;
let aggregateCacheWrite = Promise.resolve();
let aggregateCacheWriteTimer;
let activeRegionsLoad;
let activeRegionsWrite = Promise.resolve();
let activeRegionsWriteTimer;
let regionSchedulerTimer;
let globalRequestsActive = 0;
const MAX_AGGREGATE_COUNTIES = 3_000;

export class WeatherAlertError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'WeatherAlertError';
    this.code = code;
    const cause = options?.cause;
    this.stage = cause?.stage || 'provider';
    this.httpStatus = cause?.httpStatus || null;
    this.retryAfterMs = Number(cause?.retryAfterMs) || 0;
    this.url = cause?.url || null;
    this.pageFetched = Boolean(cause?.pageFetched);
    this.alertDataExtracted = Boolean(cause?.alertDataExtracted);
    this.timedOut = Boolean(cause?.timedOut || code === 'timeout');
  }
}

function valueText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join('、');
  if (typeof value === 'object') {
    return value.localized || value.english || value.name || value.value || '';
  }
  const text = String(value).trim();
  return /^(?:undefined|null|n\/a)$/i.test(text) ? '' : text;
}

function firstValue(...values) {
  for (const value of values) {
    const text = valueText(value);
    if (text) return value;
  }
  return null;
}

const cleanText = (...values) => valueText(firstValue(...values));

function weatherAlertKind(alert) {
  const text = [alert.event, alert.headline, alert.description].filter(Boolean).join(' ');
  if (/台风|热带风暴|热带气旋|typhoon|tropical cyclone|tropical storm|hurricane/i.test(text)) return '台风';
  if (/雷暴|雷雨|雷电|thunderstorm|lightning/i.test(text)) return '雷暴';
  if (/冰雹|hail/i.test(text)) return '冰雹';
  if (/沙尘暴|沙尘|扬沙|浮尘|dust storm|sandstorm|blowing dust/i.test(text)) return '沙尘暴';
  if (/道路结冰|道路冰冻|路面结冰|冰冻路面|ice on roads|icy roads/i.test(text)) return '道路结冰';
  if (/暴雨|强降雨|大雨|rainstorm|heavy rain|flood/i.test(text)) return '暴雨 / 洪水';
  if (/大雾|浓雾|雾|fog/i.test(text)) return '大雾';
  if (/大风|强风|阵风|windstorm|high wind|strong wind|gale/i.test(text)) return '大风';
  if (/暴雪|大雪|snowstorm|blizzard/i.test(text)) return '暴雪';
  if (/寒潮|寒冷|降温|cold wave|cold weather/i.test(text)) return '寒潮';
  if (/高温|热浪|heatwave|heat wave|extreme heat/i.test(text)) return '高温';
  return '气象灾害';
}

function alertColor(alert) {
  const raw = cleanText(alert.color, alert.colorName, alert.level, alert.severity, alert.alertLevel).toLowerCase();
  if (/红|red/.test(raw)) return 'red';
  if (/橙|orange/.test(raw)) return 'orange';
  if (/黄|yellow/.test(raw)) return 'yellow';
  if (/蓝|blue/.test(raw)) return 'blue';
  return 'neutral';
}

function stableAlertText(value) {
  return String(value || '')
    .toLocaleLowerCase()
    .replace(/(?:蓝色|黄色|橙色|红色|白色|black|red|orange|yellow|blue)/gi, '')
    .replace(/预警|warning/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function summaryKey(value) {
  return String(value || '')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '')
    .replace(/(?:蓝色|黄色|橙色|红色|白色|black|red|orange|yellow|blue)/gi, '')
    .replace(/预警|warning|alert/gi, '');
}

function isDuplicateSummary(summary, ...labels) {
  const key = summaryKey(summary);
  return !key || labels.some(label => key === summaryKey(label));
}

function locationKey(location) {
  return `${Number(location.latitude).toFixed(6)},${Number(location.longitude).toFixed(6)}`;
}

function cancelledStatus(value) {
  return /cancel|expire|expired|解除|取消|终止|失效|过期/i.test(valueText(value));
}

export function normalizeWeatherAlerts(data, context = {}, now = Date.now()) {
  const input = Array.isArray(data) ? data
    : data?.alerts?.alert ?? data?.alertsInfoList ?? data?.alertsInfo?.alert
    ?? data?.alertsInfo?.list ?? data?.alertsInfo ?? [];
  const sourceAlerts = Array.isArray(input) ? input : input ? [input] : [];
  const source = context.source || 'unknown';
  const location = context.location || {};
  const placeKey = locationKey(location);
  const normalized = sourceAlerts.map(raw => {
    if (!raw || typeof raw !== 'object') return null;
    const event = cleanText(raw.event, raw.alertTypeName, raw.warningTypeName, raw.warnTypeName,
      raw.typeName, raw.type, raw['预警类型'], raw.title, raw.headline) || '天气预警';
    const headline = cleanText(raw.headline, raw.alertTitle, raw.warningTitle, raw.warnTitle,
      raw.title, raw['预警标题'], event) || event;
    const areas = cleanText(raw.areas, raw.areaName, raw.regionName, raw.region,
      raw.area, raw.affectedArea, raw['预警区域']);
    const severity = cleanText(raw.severity, raw.severityName, raw.warnLevelName,
      raw.levelName, raw.level, raw['预警级别']);
    const level = cleanText(raw.level, raw.levelName, raw.warnLevelName, raw.severity);
    const publishedAt = cleanText(raw.publishedAt, raw.publishTime, raw.issuetime,
      raw.issueTime, raw.created, raw['发布时间']);
    const effective = cleanText(raw.effective, raw.start, raw.startTime,
      raw.effectiveTime, raw.onset, raw['生效时间']);
    const expires = cleanText(raw.expires, raw.end, raw.endTime, raw.expireTime,
      raw.validUntil, raw['结束时间']);
    const updatedAt = cleanText(raw.updatedAt, raw.updateTime, raw.updated, raw.modified);
    const description = cleanText(raw.description, raw.desc, raw.detail, raw.content,
      raw.body, raw.text, raw.note, raw['预警内容']);
    const defenseGuide = cleanText(raw.defenseGuide, raw.safetyGuide, raw['防御指南']);
    const sourceInstruction = cleanText(raw.instruction, raw.instructions,
      raw.sourceInstruction, raw['发布机构提示']);
    const status = cleanText(raw.status, raw.msgType, raw.latestStatus, raw.state);
    const sourceAgency = cleanText(raw.sourceAgency, raw.credit, raw.issuer,
      raw.issuerName, raw.senderName, raw.sender, raw['发布机构']);
    const providerId = cleanText(raw.alertId, raw.alertID, raw.alertInfoId, raw.warningId,
      raw.warningID, raw.alertCode, raw.warningCode, raw.identifier, raw.issueId,
      raw.serialNo, raw.id, raw['预警编号'], raw['编号']);
    const providerLocationId = cleanText(raw.detailIndex, raw.locationId, raw.stationId);
    const sourceUrl = cleanText(raw.url, raw.link, raw.uri, raw.alertUrl, context.sourceUrl);
    const summary = [raw.shortSummary, raw.shortCap, raw.summary, raw.alertSummary, raw.summaryText]
      .map(valueText).find(value => value && !isDuplicateSummary(value, event, headline, severity, level)) || null;
    const administrativeCode = cleanText(raw.administrativeCode, raw.adminCode,
      raw.adcode, raw.areaCode, raw.regionCode);
    const color = alertColor(raw);
    const areaKey = stableAlertText(areas || providerLocationId || location.name);
    const identityParts = [source, providerId, providerLocationId, sourceAgency,
      stableAlertText(event), effective, areaKey, placeKey];
    const contentKey = JSON.stringify([
      source, stableAlertText(event) || stableAlertText(headline), areaKey,
      String(effective || stableAlertText(headline)).trim(), placeKey,
    ]);
    const key = providerId
      ? `id:${JSON.stringify(identityParts)}`
      : `content:${contentKey}`;
    const legacyKey = JSON.stringify([event, headline, areas, effective, expires, severity]);
    const expiryTime = Date.parse(expires);
    const startTime = Date.parse(effective);
    if (cancelledStatus(status) || (Number.isFinite(expiryTime) && expiryTime <= now)
      || (Number.isFinite(startTime) && startTime > now)) return null;
    return {
      key, contentKey, legacyKey,
      id: providerId || null,
      storedLegacyKey: providerId ? `id:${providerId}` : null,
      providerLocationId: providerLocationId || null,
      event, kind: weatherAlertKind({ event, headline, description }), headline,
      severity, level, color,
      sourceAgency: sourceAgency || null,
      publishedAt: publishedAt || null, updatedAt: updatedAt || null,
      effective: effective || null, expires: expires || null, status: status || null,
      areas: areas || null,
      administrativeCode: administrativeCode || null,
      matchedAdministrativeCode: location.administrativeArea?.code || null,
      description: description || null,
      defenseGuide: defenseGuide || null,
      sourceInstruction: sourceInstruction || null,
      summary: summary || null,
      source, sourceLabel: context.sourceLabel || source,
      sourceUrl: sourceUrl || null,
      matchMethod: context.matchMethod || 'provider-location',
      matchedLocation: location.name || null,
      priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : null,
    };
  }).filter(Boolean);
  return [...new Map(normalized.map(alert => [alert.key, alert])).values()].sort(compareWeatherAlerts);
}

function severityPriority(alert) {
  if (alert.color !== 'neutral') return ({ red: 5, orange: 4, yellow: 3, blue: 2 })[alert.color];
  const value = `${alert.severity || ''} ${alert.level || ''}`.toLowerCase();
  if (/extreme|critical|最高|特别严重|重大/.test(value)) return 5;
  if (/severe|严重|很高/.test(value)) return 4;
  if (/moderate|较重|中等/.test(value)) return 3;
  if (/minor|一般|轻微/.test(value)) return 2;
  if (Number.isFinite(alert.priority)) return Math.max(0, 1000 - alert.priority);
  return 1;
}

export function compareWeatherAlerts(a, b) {
  const severityDifference = severityPriority(b) - severityPriority(a);
  if (severityDifference) return severityDifference;
  const publishedDifference = Date.parse(b.publishedAt || '') - Date.parse(a.publishedAt || '');
  return Number.isFinite(publishedDifference) ? publishedDifference : 0;
}

export function freshWeatherAlerts(alerts, knownKeys) {
  const known = knownKeys instanceof Set ? knownKeys : new Set(knownKeys || []);
  const stableKnown = new Set(known);
  for (const key of known) {
    try {
      const old = JSON.parse(key);
      if (!Array.isArray(old) || old.length < 6) continue;
      const [event, headline, areas, effective] = old;
      stableKnown.add(JSON.stringify([
        'unknown', stableAlertText(event) || stableAlertText(headline),
        stableAlertText(areas), String(effective || stableAlertText(headline)).trim(), '',
      ]));
    } catch {}
  }
  return alerts.filter(alert => !stableKnown.has(alert.key)
    && !stableKnown.has(alert.contentKey)
    && !(alert.storedLegacyKey && known.has(alert.storedLegacyKey))
    && !known.has(alert.legacyKey));
}

function snapshotCacheKey(location, settings) {
  const source = settings.source || 'bing';
  const apiKey = String(settings.weatherApiKey || '').trim();
  const keyState = apiKey ? createHash('sha256').update(apiKey).digest('hex').slice(0, 16) : 'weatherapi-unconfigured';
  const placeKey = location.administrativeArea?.code
    ? `admin:${location.administrativeArea.code}:${locationKey(location)}` : locationKey(location);
  return `${source}:${keyState}:${placeKey}`;
}

function makeSnapshot(source, sourceLabel, rawData, location) {
  const normalizationStarted = performance.now();
  const alerts = normalizeWeatherAlerts(rawData.alerts, {
    source, sourceLabel, sourceUrl: rawData.sourceUrl,
    location, matchMethod: source === 'msn' ? 'provider-coordinate' : 'provider-location',
  });
  return {
    status: 'ok', alerts, source, sourceLabel,
    fetchedAt: rawData.fetchedAt || new Date().toISOString(),
    requestUrl: rawData.requestUrl || rawData.sourceUrl || null,
    pageFetched: Boolean(rawData.pageFetched),
    alertDataExtracted: Boolean(rawData.alertDataExtracted ?? true),
    timings: {
      requestMs: Number(rawData.timings?.requestMs) || 0,
      providerParseMs: Number(rawData.timings?.providerParseMs) || 0,
      normalizeMs: performance.now() - normalizationStarted,
    },
  };
}

function cacheSnapshot(key, snapshot) {
  alertCache.delete(key);
  alertCache.set(key, { cachedAt: Date.now(), expiresAt: Date.now() + ALERT_CACHE_TTL, snapshot });
  for (const [cacheKey, entry] of alertCache) {
    if (entry.expiresAt <= Date.now()) alertCache.delete(cacheKey);
  }
  while (alertCache.size > ALERT_CACHE_LIMIT) alertCache.delete(alertCache.keys().next().value);
  scheduleAlertCacheWrite();
  return snapshot;
}

function scheduleAlertCacheWrite() {
  clearTimeout(alertCacheWriteTimer);
  const file = alertCacheFile();
  alertCacheWriteTimer = setTimeout(() => {
    alertCacheWriteTimer = null;
    const entries = [...alertCache.entries()]
      .filter(([, entry]) => entry.expiresAt > Date.now() && entry.snapshot?.status === 'ok')
      .slice(-ALERT_CACHE_LIMIT);
    const contents = JSON.stringify({ version: 1, entries });
    const job = alertCacheWrite.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, contents, 'utf8');
      await fs.rename(temp, file);
    });
    alertCacheWrite = job.catch(() => {});
  }, 100);
  alertCacheWriteTimer.unref?.();
}

async function loadAlertCache() {
  if (!alertCacheLoad) {
    alertCacheLoad = (async () => {
      try {
        const saved = JSON.parse(await fs.readFile(alertCacheFile(), 'utf8'));
        for (const [key, entry] of saved.entries || []) {
          if (entry?.expiresAt > Date.now() && entry.snapshot?.status === 'ok'
            && Array.isArray(entry.snapshot.alerts)) {
            alertCache.set(key, entry);
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) return;
      }
    })();
  }
  await alertCacheLoad;
}

function cacheFailure(key, error) {
  countyFailureCache.delete(key);
  countyFailureCache.set(key, {
    expiresAt: Date.now() + FAILED_COUNTY_RETRY_TTL,
    message: String(error?.message || error),
    code: error?.code || null,
    stage: error?.stage || null,
    category: classifyCountyFailure(error, error?.stage),
  });
  for (const [cacheKey, entry] of countyFailureCache) {
    if (entry.expiresAt <= Date.now()) countyFailureCache.delete(cacheKey);
  }
  while (countyFailureCache.size > FAILURE_CACHE_LIMIT) countyFailureCache.delete(countyFailureCache.keys().next().value);
}

function compactAdminName(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s,，、·._-]/g, '');
}

function adminNameStem(value) {
  return compactAdminName(value).replace(/(?:特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|自治盟|自治县|自治旗|地区|省|市|区|县|旗|盟|州)$/u, '');
}

function mappingScopeMatches(entry, county, scope) {
  return String(entry?.adminCode || '') === String(county.code)
    && String(entry?.provinceCode || '') === String(scope.province?.code || '')
    && String(entry?.cityCode || '') === String(scope.city?.code || '')
    && adminNameStem(entry?.provinceName) === adminNameStem(scope.province?.name)
    && adminNameStem(entry?.cityName) === adminNameStem(scope.city?.name || '')
    && adminNameStem(entry?.countyName) === adminNameStem(county.name);
}

function mappingLocationMatchesScope(location, county, scope) {
  if (!location || String(location.geocoder || '') !== 'msn'
    || String(location.countryCode || location.administrativeArea?.countryCode || '').toUpperCase() !== 'CN') return false;
  const latitude = Number(location.latitude), longitude = Number(location.longitude);
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90
    || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return false;
  const fullName = compactAdminName(location.name);
  const expectedParts = [scope.province?.name, scope.city?.name, county.name].filter(Boolean);
  if (!expectedParts.every(part => fullName.includes(adminNameStem(part)))) return false;
  const area = location.administrativeArea || {};
  if (area.region && adminNameStem(area.region) !== adminNameStem(scope.province?.name)) return false;
  if (scope.city?.name && area.subregion
    && adminNameStem(area.subregion) !== adminNameStem(scope.city.name)) return false;
  if (area.locality && !compactAdminName(area.locality).includes(adminNameStem(county.name))
    && !fullName.includes(adminNameStem(county.name))) return false;
  return true;
}

function cacheCountyLocation(county, scope, location, persist = true) {
  const code = String(county.code);
  const entry = {
    expiresAt: Date.now() + COUNTY_LOCATION_CACHE_TTL,
    adminCode: code,
    provinceCode: String(scope.province?.code || ''),
    cityCode: String(scope.city?.code || ''),
    provinceName: scope.province?.name || '',
    cityName: scope.city?.name || '',
    countyName: county.name,
    location,
  };
  countyLocationCache.delete(code);
  countyLocationCache.set(code, entry);
  if (persist && mappingLocationMatchesScope(location, county, scope)) {
    void setAlertPlaceMapping(entry);
  }
  while (countyLocationCache.size > ALERT_CACHE_LIMIT * 3) countyLocationCache.delete(countyLocationCache.keys().next().value);
}

function compactAggregateSnapshot(snapshot) {
  const coverage = snapshot?.coverage || {};
  return {
    ...snapshot,
    coverage: {
      kind: coverage.kind, total: coverage.total, successful: coverage.successful,
      failed: coverage.failed, unqueried: coverage.unqueried, complete: coverage.complete,
      resultCounts: coverage.resultCounts, failureCounts: coverage.failureCounts,
      requests: coverage.requests, realRequests: coverage.realRequests,
      dataDate: coverage.dataDate, dataSource: coverage.dataSource,
      elapsedMs: coverage.elapsedMs, oldestDataFetchedAt: coverage.oldestDataFetchedAt, timings: coverage.timings,
    },
  };
}

function scheduleAggregateCacheWrite() {
  clearTimeout(aggregateCacheWriteTimer);
  const file = aggregateCacheFile();
  aggregateCacheWriteTimer = setTimeout(() => {
    aggregateCacheWriteTimer = null;
    const entries = [...aggregateCache.entries()]
      .filter(([, entry]) => entry.staleUntil > Date.now())
      .slice(-200)
      .map(([key, entry]) => [key, { ...entry, snapshot: compactAggregateSnapshot(entry.snapshot) }]);
    const contents = JSON.stringify({ version: 1, entries });
    const job = aggregateCacheWrite.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, contents, 'utf8');
      await fs.rename(temp, file);
    });
    aggregateCacheWrite = job.catch(() => {});
  }, 100);
  aggregateCacheWriteTimer.unref?.();
}

async function loadAggregateCache() {
  if (!aggregateCacheLoad) {
    aggregateCacheLoad = (async () => {
      try {
        const saved = JSON.parse(await fs.readFile(aggregateCacheFile(), 'utf8'));
        for (const [key, entry] of saved.entries || []) {
          if (entry?.staleUntil > Date.now() && Array.isArray(entry.snapshot?.alerts)
            && entry.snapshot.coverage && Number.isFinite(Number(entry.snapshot.fetchedAt && Date.parse(entry.snapshot.fetchedAt)))) {
            aggregateCache.set(key, entry);
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) return;
      }
    })();
  }
  await aggregateCacheLoad;
}

function aggregateCacheResult(entry, { historical = false } = {}) {
  const snapshot = pruneExpiredSnapshot(entry.snapshot);
  const result = {
    ...snapshot,
    historical,
    cacheHit: true,
    cacheAgeMs: Math.max(0, Date.now() - entry.cachedAt),
    cacheExpiresAt: entry.expiresAt,
    timings: { ...(snapshot.timings || {}), aggregateCacheHit: true, totalMs: 0 },
  };
  if (historical) {
    const updatedAt = snapshot.fetchedAt ? new Date(snapshot.fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未知';
    const refreshState = entry.refreshFailedAt ? '上次刷新失败，等待重试' : '正在更新';
    result.refreshFailedAt = entry.refreshFailedAt || null;
    result.scopeNote = `${snapshot.scopeNote || ''}${snapshot.scopeNote ? ' · ' : ''}历史快照，数据最后成功获取于 ${updatedAt}；${refreshState}，不代表当前生效状态。`;
  }
  return result;
}

function readAggregateCache(key) {
  const entry = aggregateCache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  aggregateCache.delete(key);
  aggregateCache.set(key, entry);
  return aggregateCacheResult(entry);
}

function readStaleAggregateCache(key) {
  const entry = aggregateCache.get(key);
  if (!entry || entry.staleUntil <= Date.now()) {
    if (entry) aggregateCache.delete(key);
    return null;
  }
  return aggregateCacheResult(entry, { historical: true });
}

function cacheAggregateSnapshot(key, snapshot) {
  const now = Date.now();
  const dataFetchedAt = Date.parse(snapshot.fetchedAt || '');
  const remainingPointTtl = Number.isFinite(dataFetchedAt)
    ? Math.max(0, dataFetchedAt + ALERT_CACHE_TTL - now) : AGGREGATE_CACHE_TTL;
  const ttl = snapshot.coverage?.successful === 0
    ? FAILED_COUNTY_RETRY_TTL : Math.min(AGGREGATE_CACHE_TTL, remainingPointTtl);
  aggregateCache.delete(key);
  aggregateCache.set(key, {
    cachedAt: now, expiresAt: now + ttl, staleUntil: now + ttl + AGGREGATE_STALE_TTL_MS,
    snapshot: compactAggregateSnapshot(snapshot),
  });
  for (const [cacheKey, entry] of aggregateCache) {
    if (entry.staleUntil <= now) aggregateCache.delete(cacheKey);
  }
  while (aggregateCache.size > 200) aggregateCache.delete(aggregateCache.keys().next().value);
  scheduleAggregateCacheWrite();
  const active = activeRegions.get(key);
  if (active) {
    active.nextRefreshAt = Math.max(now, now + ttl - REFRESH_LEAD_MS);
    scheduleActiveRegionsWrite();
    scheduleNextActiveRefresh();
  }
  return snapshot;
}

function scheduleActiveRegionsWrite() {
  clearTimeout(activeRegionsWriteTimer);
  const file = activeRegionsFile();
  activeRegionsWriteTimer = setTimeout(() => {
    activeRegionsWriteTimer = null;
    const entries = [...activeRegions.entries()].slice(-100);
    const contents = JSON.stringify({ version: 1, entries });
    const job = activeRegionsWrite.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, contents, 'utf8');
      await fs.rename(temp, file);
    });
    activeRegionsWrite = job.catch(() => {});
  }, 100);
  activeRegionsWriteTimer.unref?.();
}

async function loadActiveRegions() {
  if (!activeRegionsLoad) {
    activeRegionsLoad = (async () => {
      try {
        const saved = JSON.parse(await fs.readFile(activeRegionsFile(), 'utf8'));
        for (const [key, record] of (saved.entries || []).slice(-ACTIVE_REGION_LIMIT)) {
          if (record?.expiresAt > Date.now() && record?.input && record?.location) activeRegions.set(key, record);
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) return;
      }
    })();
  }
  await activeRegionsLoad;
}

function scheduleNextActiveRefresh() {
  clearTimeout(regionSchedulerTimer);
  regionSchedulerTimer = null;
  const now = Date.now();
  for (const [key, record] of activeRegions) {
    if (record.expiresAt <= now) {
      activeRegions.delete(key);
      activeRegionContexts.delete(key);
      continue;
    }
  }
  const due = [...activeRegions.entries()]
    .filter(([key, record]) => activeRegionContexts.has(key) && !regionRefreshStates.get(key)?.running)
    .sort((a, b) => Number(a[1].priority || 0) - Number(b[1].priority || 0)
      || Number(a[1].nextRefreshAt || a[1].expiresAt) - Number(b[1].nextRefreshAt || b[1].expiresAt))[0];
  if (!due) return;
  const [key, record] = due;
  const delayMs = Math.max(0, Number(record.nextRefreshAt || record.expiresAt) - now);
  regionSchedulerTimer = setTimeout(() => { void runActiveRegionRefresh(key); }, delayMs);
  regionSchedulerTimer.unref?.();
  scheduleActiveRegionsWrite();
}

async function runActiveRegionRefresh(key) {
  regionSchedulerTimer = null;
  const record = activeRegions.get(key);
  const context = activeRegionContexts.get(key);
  if (!record || !context || record.expiresAt <= Date.now()) {
    scheduleNextActiveRefresh();
    return;
  }
  if (regionRefreshStates.get(key)?.running || aggregateRequests.has(key)) {
    record.nextRefreshAt = Date.now() + 5000;
    scheduleNextActiveRefresh();
    return;
  }
  const state = regionRefreshStates.get(key) || { failures: 0 };
  state.running = true;
  regionRefreshStates.set(key, state);
  record.priority = 1;
  try {
    const settings = context.dependencies.settingsProvider
      ? await context.dependencies.settingsProvider() : context.settings;
    const scope = await (context.dependencies.findScope || findAdministrativeAlertScope)(record.input, record.location);
    if (!scope || scope.kind === 'county' || aggregateRequestKey(scope, settings) !== key) {
      record.nextRefreshAt = Math.min(record.expiresAt, Date.now() + 60_000);
      return;
    }
    const snapshot = await getWeatherAlertCoverageSnapshot(record.input, record.location, context.fetcher, settings, {
      ...context.dependencies, proactiveBackground: true, forceRefresh: true,
    });
    if (snapshot.status === 'partial') {
      state.failures++;
      record.lastRefreshFailedAt = Date.now();
      record.nextRefreshAt = Math.min(record.expiresAt, Date.now() + Math.min(5 * 60_000,
        Math.max(FAILED_COUNTY_RETRY_TTL, AGGREGATE_CACHE_TTL - REFRESH_LEAD_MS) * (2 ** Math.min(state.failures - 1, 4))));
      context.dependencies.onBackgroundRefreshResult?.({ key, complete: false, coverage: snapshot.coverage });
    } else {
      state.failures = 0;
      record.lastRefreshFailedAt = null;
      record.nextRefreshAt = Date.now() + Math.max(0, AGGREGATE_CACHE_TTL - REFRESH_LEAD_MS);
      context.dependencies.onBackgroundRefreshResult?.({ key, complete: true, coverage: snapshot.coverage });
    }
  } catch (error) {
    state.failures++;
    record.lastRefreshFailedAt = Date.now();
    record.nextRefreshAt = Math.min(record.expiresAt, Date.now() + Math.min(5 * 60_000,
      Math.max(FAILED_COUNTY_RETRY_TTL, AGGREGATE_CACHE_TTL - REFRESH_LEAD_MS) * (2 ** Math.min(state.failures - 1, 4))));
    try { context.dependencies.onBackgroundRetryError?.(error, state.failures); } catch {}
  } finally {
    state.running = false;
    scheduleActiveRegionsWrite();
    scheduleNextActiveRefresh();
  }
}

async function registerActiveRegion(key, input, location, fetcher, settings, dependencies) {
  await loadActiveRegions();
  const now = Date.now();
  const previous = activeRegions.get(key);
  const cached = aggregateCache.get(key);
  const record = {
    key, input: String(input), location: JSON.parse(JSON.stringify(location)),
    lastAccessedAt: now, expiresAt: now + ACTIVE_REGION_TTL_MS,
    nextRefreshAt: previous?.nextRefreshAt || (cached
      ? Math.max(now, cached.expiresAt - REFRESH_LEAD_MS)
      : now + Math.max(FAILED_COUNTY_RETRY_TTL, AGGREGATE_CACHE_TTL - REFRESH_LEAD_MS)),
    priority: dependencies.backgroundRefresh !== false && process.env.WEATHER_ALERT_BACKGROUND_REFRESH !== '0' ? 0 : 1,
    source: settings.source || 'bing',
  };
  activeRegions.delete(key);
  activeRegions.set(key, record);
  const previousContext = activeRegionContexts.get(key);
  activeRegionContexts.set(key, {
    input: String(input), location, fetcher, settings,
    dependencies: { ...(previousContext?.dependencies || {}), ...dependencies },
  });
  const keyPrefix = `${key.split(':').slice(0, 2).join(':')}:`;
  for (const [savedKey, saved] of activeRegions) {
    if (savedKey === key || !savedKey.startsWith(keyPrefix)) continue;
    const savedContext = activeRegionContexts.get(savedKey);
    activeRegionContexts.set(savedKey, {
      input: saved.input, location: saved.location, fetcher, settings,
      dependencies: { ...(savedContext?.dependencies || {}), ...dependencies },
    });
  }
  while (activeRegions.size > ACTIVE_REGION_LIMIT) {
    const oldest = activeRegions.keys().next().value;
    activeRegions.delete(oldest);
    activeRegionContexts.delete(oldest);
  }
  scheduleActiveRegionsWrite();
  if (dependencies.backgroundRefresh !== false && process.env.WEATHER_ALERT_BACKGROUND_REFRESH !== '0') {
    scheduleNextActiveRefresh();
  }
}

export async function initializeWeatherAlertBackgroundRefresh(fetcher = fetch, settingsProvider = null, dependencies = {}) {
  if (dependencies.backgroundRefresh === false || process.env.WEATHER_ALERT_BACKGROUND_REFRESH === '0') return 0;
  await Promise.all([loadAggregateCache(), loadActiveRegions()]);
  const settings = settingsProvider ? await settingsProvider() : { source: 'bing' };
  const apiKey = String(settings.weatherApiKey || '').trim();
  const keyState = apiKey ? createHash('sha256').update(apiKey).digest('hex').slice(0, 16) : 'weatherapi-unconfigured';
  const prefix = `${settings.source || 'bing'}:${keyState}:`;
  let restored = 0;
  const now = Date.now();
  for (const [key, record] of activeRegions) {
    if (!key.startsWith(prefix) || record.expiresAt <= now) continue;
    activeRegionContexts.set(key, {
      input: record.input, location: record.location, fetcher, settings,
      dependencies: { ...dependencies, settingsProvider },
    });
    restored++;
  }
  scheduleNextActiveRefresh();
  return restored;
}

export function stopWeatherAlertBackgroundRefresh() {
  clearTimeout(regionSchedulerTimer);
  regionSchedulerTimer = null;
  for (const state of regionRefreshStates.values()) state.controller?.abort(new Error('天气预警后台刷新已停止'));
  for (const controller of backgroundControllers) controller.abort(new Error('天气预警后台刷新已停止'));
  backgroundControllers.clear();
  for (const state of backgroundRetryStates.values()) clearTimeout(state.timer);
  backgroundRetryStates.clear();
}

process.once('exit', stopWeatherAlertBackgroundRefresh);

function canonicalAlertSource(source, label) {
  const value = `${source || ''} ${label || ''}`.toLocaleLowerCase();
  if (/weatherapi/.test(value)) return 'WeatherAPI';
  if (/msn|bing/.test(value)) return 'MSN 天气';
  return valueText(label) || null;
}

function pruneExpiredSnapshot(snapshot, now = Date.now()) {
  if (!Array.isArray(snapshot?.alerts)) return snapshot;
  const alerts = snapshot.alerts.filter(alert => {
    const expires = Date.parse(alert.expires || '');
    const effective = Date.parse(alert.effective || '');
    return !(Number.isFinite(expires) && expires <= now)
      && !(Number.isFinite(effective) && effective > now)
      && !cancelledStatus(alert.status);
  });
  return alerts.length === snapshot.alerts.length ? snapshot : { ...snapshot, alerts };
}

export async function getWeatherAlertSnapshot(location, fetcher = fetch, settings = {}) {
  const apiKey = String(settings.weatherApiKey || '').trim();
  const selectedSource = settings.source || 'bing';
  const cacheKey = snapshotCacheKey(location, settings);
  await loadAlertCache();
  const cached = alertCache.get(cacheKey);
  if (cached?.expiresAt > Date.now() && !settings.forceAlertRefresh) {
    const snapshot = pruneExpiredSnapshot(cached.snapshot);
    if (snapshot !== cached.snapshot) cached.snapshot = snapshot;
    return {
      ...snapshot,
      cacheHit: true,
      cacheAgeMs: Math.max(0, Date.now() - cached.cachedAt),
      timings: { ...(snapshot.timings || {}), cacheHit: true },
    };
  }
  if (cached) alertCache.delete(cacheKey);
  if (alertRequests.has(cacheKey)) return alertRequests.get(cacheKey).then(snapshot => ({ ...snapshot, coalesced: true }));

  const job = (async () => {
    if (selectedSource === 'weatherapi') {
      if (!apiKey) throw new WeatherAlertError('unavailable', 'WeatherAPI 预警查询需要配置 API Key');
      try {
        const data = await getWeatherApiAlertData(location, fetcher, apiKey);
        return cacheSnapshot(cacheKey, makeSnapshot('weatherapi', 'WeatherAPI.com', data, location));
      } catch (error) {
        throw new WeatherAlertError(error.code || 'unavailable', `WeatherAPI 预警查询失败：${error.message}`, { cause: error });
      }
    }

    let msnData = null;
    let msnError = null;
    let msnElapsedMs = 0;
    const msnStarted = performance.now();
    try { msnData = await getMsnWeatherAlertData(location, fetcher); }
    catch (error) { msnError = error; }
    finally { msnElapsedMs = performance.now() - msnStarted; }
    const msnSnapshot = msnData ? makeSnapshot('msn', 'MSN 天气页面', msnData, location) : null;
    if (msnSnapshot?.alerts.length) return cacheSnapshot(cacheKey, msnSnapshot);

    if (apiKey) {
      const weatherApiStarted = performance.now();
      let weatherApiElapsedMs = 0;
      try {
        const data = await getWeatherApiAlertData(location, fetcher, apiKey);
        const backup = makeSnapshot('weatherapi', 'WeatherAPI.com（备用）', data, location);
        weatherApiElapsedMs = performance.now() - weatherApiStarted;
        backup.timings.requestMs += msnData?.timings?.requestMs || msnElapsedMs;
        backup.timings.providerParseMs += Number(msnData?.timings?.providerParseMs) || 0;
        backup.timings.normalizeMs += Number(msnSnapshot?.timings?.normalizeMs) || 0;
        if (backup.alerts.length || !msnSnapshot) return cacheSnapshot(cacheKey, backup);
      } catch (error) {
        weatherApiElapsedMs = performance.now() - weatherApiStarted;
        if (!msnSnapshot) throw new WeatherAlertError(error.code || 'unavailable', `预警查询失败：${error.message}`, { cause: error });
      }
      if (msnSnapshot) {
        msnSnapshot.timings.requestMs += weatherApiElapsedMs;
      }
    }

    if (msnSnapshot) return cacheSnapshot(cacheKey, msnSnapshot);
    if (msnError?.code === 'source-unsupported') {
      throw new WeatherAlertError('source-unsupported', `MSN 天气页面未提供该地区的预警数据：${msnError.message}`, { cause: msnError });
    }
    const code = msnError?.code || 'network-request-failed';
    throw new WeatherAlertError(code, `无法读取 MSN 天气预警数据：${msnError?.message || '未知错误'}`, { cause: msnError });
  })();
  alertRequests.set(cacheKey, job);
  try { return await job; }
  finally { alertRequests.delete(cacheKey); }
}

function aggregateRequestKey(scope, settings) {
  const apiKey = String(settings.weatherApiKey || '').trim();
  const keyState = apiKey ? createHash('sha256').update(apiKey).digest('hex').slice(0, 16) : 'weatherapi-unconfigured';
  return `${settings.source || 'bing'}:${keyState}:${scope.division.code}`;
}

function clearBackgroundRetry(key) {
  const active = backgroundRetryStates.get(key);
  if (active?.timer) clearTimeout(active.timer);
  backgroundRetryStates.delete(key);
}

function scheduleBackgroundRetry(key, input, location, fetcher, settings, dependencies, coverage) {
  if (dependencies.backgroundRefresh === false || process.env.WEATHER_ALERT_BACKGROUND_REFRESH === '0') return;
  const retryable = (coverage.diagnostics || []).some(diagnostic => {
    if (!['request-timeout', 'network-request-failed'].includes(diagnostic.category)) return false;
    const status = Number(diagnostic.error?.httpStatus || diagnostic.httpStatus);
    return !status || status === 408 || status === 425 || status === 429 || status >= 500;
  });
  if (!retryable) return;
  const previous = backgroundRetryStates.get(key);
  if (previous?.timer) return;
  const attempt = (previous?.attempt || 0) + 1;
  if (attempt > 3) {
    clearBackgroundRetry(key);
    return;
  }
  const configuredDelay = Number(dependencies.backgroundRetryDelayMs);
  const delayMs = Number.isFinite(configuredDelay) && configuredDelay >= 0
    ? Math.min(5 * 60_000, configuredDelay)
    : Math.min(5 * 60_000, (FAILED_COUNTY_RETRY_TTL + 1_000) * (2 ** (attempt - 1)));
  const state = { attempt, timer: null };
  state.timer = setTimeout(async () => {
    const current = backgroundRetryStates.get(key);
    if (current !== state) return;
    state.timer = null;
    try {
      await getWeatherAlertCoverageSnapshot(input, location, fetcher, settings, {
        ...dependencies, backgroundRefresh: true, proactiveBackground: true, forceRefresh: true,
        backgroundAttempt: attempt,
      });
    } catch (error) {
      try { dependencies.onBackgroundRetryError?.(error, attempt); } catch {}
    }
  }, delayMs);
  state.timer.unref?.();
  backgroundRetryStates.set(key, state);
}

function sourceAlertIdentity(alert, areaCode) {
  const source = alert.source || 'unknown';
  const agency = stableAlertText(alert.sourceAgency);
  const issued = String(alert.publishedAt || alert.effective || '').trim();
  const event = stableAlertText(alert.event || alert.headline);
  const detail = stableAlertText(alert.description || alert.summary || alert.headline);
  const severity = stableAlertText(alert.severity || alert.level);
  if (alert.id && agency) {
    return `id:${JSON.stringify([source, agency, alert.id, event, issued])}`;
  }
  // Without an upstream ID, only merge records with enough source identity to
  // avoid merging same-looking warnings from different publishers.
  if (agency && issued && event && detail) {
    return `content:${JSON.stringify([source, agency, event, severity, issued, detail])}`;
  }
  return `unverified:${source}:${areaCode}:${alert.key}`;
}

export function dedupeAggregatedWeatherAlerts(records) {
  const merged = new Map();
  for (const { alert, county } of records) {
    const key = sourceAlertIdentity(alert, county.code);
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, {
        ...alert,
        matchedLocations: [county.name],
        matchedAdministrativeCodes: [county.code],
      });
      continue;
    }
    previous.matchedLocations = [...new Set([...previous.matchedLocations, county.name])];
    previous.matchedAdministrativeCodes = [...new Set([...previous.matchedAdministrativeCodes, county.code])];
    const sourceAreas = [...new Set([previous.areas, alert.areas].filter(Boolean))];
    if (sourceAreas.length) previous.areas = sourceAreas.join('；');
    if (!previous.sourceUrl && alert.sourceUrl) previous.sourceUrl = alert.sourceUrl;
    if (!previous.defenseGuide && alert.defenseGuide) previous.defenseGuide = alert.defenseGuide;
  }
  return [...merged.values()].sort(compareWeatherAlerts);
}

function regionScopeLabel(scope) {
  return scope.kind === 'province'
    ? scope.province.name
    : `${scope.province.name}${scope.city?.name || ''}`;
}

function pointScopeNote(input, location, regionalIntent = false, reason = '') {
  const name = location.name || input;
  if (regionalIntent) {
    return `范围：只查询数据源定位到的“${name}”单点天气预警；${reason || '未能取得可验证的下属区县列表，因此没有执行区域汇总。'}`;
  }
  return `范围：仅查询“${name}”这一地点实际适用的预警，不汇总上级行政区域。`;
}

function regionalQueryIntent(input, location) {
  if (String(location?.countryCode || location?.administrativeArea?.countryCode || '').toUpperCase() !== 'CN') return false;
  return /(?:省|自治区|特别行政区|市|自治州|自治盟|地区|盟|州)$/u.test(String(input || '').trim())
    || Boolean(location?.administrativeArea?.region && !location?.administrativeArea?.subregion);
}

function boundedFetcher(fetcher, controller, onRequest = null) {
  return async (url, options = {}) => {
    if (controller.signal.aborted) throw new Error('区域预警查询已达到总时限');
    const signals = [controller.signal, options.signal].filter(Boolean);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const started = performance.now();
    try { return await fetcher(url, { ...options, signal }); }
    finally { onRequest?.(url, performance.now() - started); }
  };
}

function configuredInteger(name, fallback, minimum, maximum) {
  const number = Number(process.env[name]);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.floor(number))) : fallback;
}

function configuredIntervalMs() {
  const number = Number(process.env.WEATHER_ALERT_REQUEST_INTERVAL_MS);
  return Number.isFinite(number) ? Math.max(0, Math.min(5000, Math.floor(number))) : DEFAULT_REQUEST_INTERVAL_MS;
}

function mergeSignals(signals) {
  const usable = signals.filter(Boolean);
  if (!usable.length) return undefined;
  return usable.length === 1 ? usable[0] : AbortSignal.any(usable);
}

function delayWithSignal(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('请求已取消'));
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const aborted = () => { cleanup(); reject(signal.reason || new Error('请求已取消')); };
    const timer = setTimeout(done, ms);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
    };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function requestHostState(host) {
  if (!hostRequestStates.has(host)) {
    hostRequestStates.set(host, { queue: Promise.resolve(), nextRequestAt: 0, pausedUntil: 0 });
  }
  return hostRequestStates.get(host);
}

async function acquireRequestSlot(host, signal) {
  const state = requestHostState(host);
  const turn = state.queue.catch(() => {}).then(async () => {
    const waitUntil = Math.max(state.nextRequestAt, state.pausedUntil);
    await delayWithSignal(waitUntil - Date.now(), signal);
    state.nextRequestAt = Date.now() + configuredIntervalMs();
  });
  state.queue = turn.catch(() => {});
  await turn;
}

function pumpGlobalRequestQueue() {
  while (globalRequestsActive < GLOBAL_REQUEST_CONCURRENCY && globalRequestWaiters.length) {
    const waiter = globalRequestWaiters.shift();
    if (waiter.signal?.aborted) {
      waiter.cleanup();
      waiter.reject(waiter.signal.reason || new Error('请求已取消'));
      continue;
    }
    globalRequestsActive++;
    waiter.cleanup();
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      globalRequestsActive = Math.max(0, globalRequestsActive - 1);
      pumpGlobalRequestQueue();
    });
  }
}

function acquireGlobalRequestSlot(signal, background = false) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('请求已取消'));
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, priority: background ? 1 : 0, cleanup: () => {} };
    const aborted = () => {
      const index = globalRequestWaiters.indexOf(waiter);
      if (index >= 0) globalRequestWaiters.splice(index, 1);
      waiter.cleanup();
      reject(signal.reason || new Error('请求已取消'));
      pumpGlobalRequestQueue();
    };
    waiter.cleanup = () => signal?.removeEventListener('abort', aborted);
    signal?.addEventListener('abort', aborted, { once: true });
    let index = globalRequestWaiters.length;
    while (index > 0 && globalRequestWaiters[index - 1].priority > waiter.priority) index--;
    globalRequestWaiters.splice(index, 0, waiter);
    pumpGlobalRequestQueue();
  });
}

function safeRequestUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    for (const key of ['key', 'api_key', 'apikey', 'token']) {
      if (url.searchParams.has(key)) url.searchParams.set(key, '[redacted]');
    }
    return url.toString();
  } catch { return String(rawUrl); }
}

function retryAfterMs(response) {
  const value = response?.headers?.get?.('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function recordRequest(diagnostic, details) {
  if (details.attempt > 1 && diagnostic) diagnostic.retries = (diagnostic.retries || 0) + 1;
  if (diagnostic) {
    diagnostic.requestUrl = safeRequestUrl(details.url);
    diagnostic.httpStatus = details.httpStatus ?? null;
  }
  diagnostic?.requests.push({
    url: safeRequestUrl(details.url),
    httpStatus: details.httpStatus ?? null,
    elapsedMs: Math.round(details.elapsedMs),
    timedOut: Boolean(details.timedOut),
    attempt: details.attempt,
    retry: details.attempt > 1,
    errorType: details.errorType || null,
    retryAfterMs: details.retryAfterMs || 0,
  });
}

async function rateLimitedFetch(fetcher, url, options, parentSignals, diagnostic) {
  const parentSignal = mergeSignals(parentSignals);
  const host = new URL(String(url)).host.toLocaleLowerCase();
  const state = requestHostState(host);
  const maxRetries = configuredInteger('WEATHER_ALERT_REQUEST_RETRIES', DEFAULT_REQUEST_RETRIES, 0, 3);
  let resetRequestSignal = false;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await acquireRequestSlot(host, parentSignal);
    const attemptTimeout = resetRequestSignal ? AbortSignal.timeout(12_000) : null;
    const signal = mergeSignals([
      ...parentSignals,
      resetRequestSignal ? attemptTimeout : options.signal,
    ]);
    const started = performance.now();
    let response;
    const releaseGlobal = await acquireGlobalRequestSlot(signal, diagnostic?.backgroundRefresh);
    try {
      response = await fetcher(url, { ...options, signal });
    } catch (error) {
      const elapsedMs = performance.now() - started;
      const parentCancelled = parentSignals.some(item => item?.aborted);
      const timedOut = error?.name === 'TimeoutError'
        || signal?.reason?.name === 'TimeoutError'
        || /超时|timeout/i.test(String(error?.message || ''));
      recordRequest(diagnostic, {
        url, httpStatus: null, elapsedMs, timedOut, attempt: attempt + 1,
        errorType: timedOut ? 'timeout' : 'network-request-failed',
      });
      if (parentCancelled || attempt >= maxRetries) {
        if (error && typeof error === 'object') {
          error.timedOut = timedOut;
          error.stage ||= 'network';
          error.code ||= timedOut ? 'timeout' : 'network-request-failed';
          error.url ||= String(url);
        }
        throw error;
      }
      releaseGlobal();
      resetRequestSignal = true;
      await delayWithSignal(Math.min(5000, 250 * (2 ** attempt)), parentSignal);
      continue;
    } finally {
      releaseGlobal();
    }

    const status = Number(response?.status) || 0;
    const elapsedMs = performance.now() - started;
    const retryAfter = status === 429 ? retryAfterMs(response) : 0;
    recordRequest(diagnostic, {
      url, httpStatus: status, elapsedMs, attempt: attempt + 1,
      errorType: status >= 400 ? `http-${status}` : null,
      retryAfterMs: retryAfter,
    });
    if (status === 429) {
      const pause = retryAfter || Math.min(30_000, 1000 * (2 ** attempt));
      state.pausedUntil = Math.max(state.pausedUntil, Date.now() + pause);
    }
    const recoverable = status === 408 || status === 425 || status === 429 || status >= 500;
    if (!recoverable || attempt >= maxRetries) return response;
    resetRequestSignal = true;
    const backoff = status === 429
      ? retryAfter || Math.min(30_000, 1000 * (2 ** attempt))
      : Math.min(5000, 250 * (2 ** attempt));
    await delayWithSignal(backoff, parentSignal);
  }
  throw new Error('请求重试次数已用尽');
}

function classifyCountyFailure(error, stage = '') {
  const code = String(error?.code || '');
  if (code === 'location-not-found' || code === 'location-ambiguous' || /地点解析结果与行政区/.test(String(error?.message || ''))) return 'location-resolution-failed';
  if (code === 'timeout' || error?.timedOut) return 'request-timeout';
  if (code === 'page-parse-failed' || stage === 'parse') return 'page-parse-failed';
  if (code === 'source-unsupported' || code === 'unsupported') return 'source-unsupported';
  if (code === 'network-request-failed' || code === 'http-429' || /^http-\d+$/.test(code)) return 'network-request-failed';
  if (stage === 'location') return 'location-resolution-failed';
  return 'network-request-failed';
}

const COUNTY_RESULT_LABELS = {
  'success-with-alerts': '成功且有预警',
  'success-no-alerts': '成功但无预警',
  'location-resolution-failed': '地点解析失败',
  'network-request-failed': '网络请求失败',
  'request-timeout': '请求超时',
  'page-parse-failed': '网页解析失败',
  'source-unsupported': '数据源明确不支持',
  'not-queried': '尚未查询',
};

function createCountyDiagnostic(county, scope) {
  return {
    name: county.name,
    code: String(county.code),
    province: scope.province?.name || null,
    city: scope.city?.name || county.parentCity || null,
    queryState: 'not-queried',
    category: 'not-queried',
    categoryLabel: COUNTY_RESULT_LABELS['not-queried'],
    locationQuery: null,
    locationResolved: false,
    locationMatchMethod: null,
    resolvedLocation: null,
    locationIdentifier: null,
    requestUrl: null,
    httpStatus: null,
    pageFetched: false,
    alertDataExtracted: false,
    alertCount: null,
    provider: null,
    cache: {
      location: false, locationSource: null, negativeLocation: false,
      geocoding: false, alerts: false, failureCooldown: false,
    },
    retries: 0,
    requests: [],
    error: null,
    timings: { locationResolveMs: 0, alertRequestMs: 0, totalMs: 0 },
  };
}

async function resolveCountyLocation(county, scope, fetcher, dependencies, { force = false } = {}) {
  const locationKey = String(county.code);
  const parentCity = scope.city?.name || county.parentCity || '';
  const query = `${scope.province.name}${parentCity}${county.name}`;
  if (force) {
    countyLocationCache.delete(locationKey);
    await deleteAlertPlaceEntry(locationKey);
  }
  const matchesScope = entry => mappingScopeMatches(entry, county, scope)
    && mappingLocationMatchesScope(entry.location, county, scope);

  if (!force) {
    const cached = countyLocationCache.get(locationKey);
    if (cached?.expiresAt > Date.now() && matchesScope(cached)) {
      countyLocationCache.delete(locationKey);
      countyLocationCache.set(locationKey, cached);
      return {
        location: cached.location, cacheHit: true, cacheSource: 'memory', geocodingCacheHit: false,
        coalesced: false, query,
      };
    }
    if (cached) countyLocationCache.delete(locationKey);

    const persisted = await getAlertPlaceMapping(locationKey);
    if (persisted && matchesScope(persisted)) {
      cacheCountyLocation(county, scope, persisted.location, false);
      return {
        location: persisted.location, cacheHit: true, cacheSource: persisted.cacheSource,
        geocodingCacheHit: false, coalesced: false, query,
      };
    }
    if (persisted) await deleteAlertPlaceEntry(locationKey);

    const negative = await getAlertPlaceNegative(locationKey);
    if (negative) {
      if (mappingScopeMatches(negative, county, scope)) {
        const error = new Error(`MSN 暂未收录“${query}”，地点搜索负缓存有效期内不重复请求。`);
        error.code = 'location-not-found';
        error.stage = 'location';
        error.locationQuery = query;
        error.negativePlaceCacheHit = true;
        throw error;
      }
      await deleteAlertPlaceEntry(locationKey);
    }
  }

  if (countyLocationRequests.has(locationKey)) {
    return {
      location: await countyLocationRequests.get(locationKey), cacheHit: true, cacheSource: 'in-flight',
      geocodingCacheHit: false, coalesced: true, query,
    };
  }

  const resolve = dependencies.resolveLocation || resolveCity;
  let geocodingCacheHit = false;
  const request = (async () => {
    try {
      const location = await resolve(query, fetcher, {
        force,
        onCacheHit: () => { geocodingCacheHit = true; },
      });
      const resolved = compactAdminName(location?.name);
      const expected = compactAdminName(query);
      if (!resolved.includes(adminNameStem(expected))
        || location?.geocoder === 'msn' && !mappingLocationMatchesScope(location, county, scope)) {
        const error = new Error(`地点解析结果与行政区“${query}”不一致`);
        error.code = 'location-resolution-failed';
        error.stage = 'location';
        error.locationQuery = query;
        error.candidateLocation = location;
        throw error;
      }
      const area = { ...(location.administrativeArea || {}), code: county.code };
      const preciseLocation = { ...location, administrativeArea: area };
      cacheCountyLocation(county, scope, preciseLocation);
      return preciseLocation;
    } catch (error) {
      if (error?.code === 'location-not-found') {
        await setAlertPlaceNegative({
          adminCode: locationKey,
          provinceCode: String(scope.province?.code || ''),
          cityCode: String(scope.city?.code || ''),
          provinceName: scope.province?.name || '',
          cityName: scope.city?.name || '',
          countyName: county.name,
          errorCode: 'location-not-found',
          lastTriedAt: Date.now(),
        });
      }
      throw error;
    }
  })();
  countyLocationRequests.set(locationKey, request);
  try {
    return {
      location: await request, cacheHit: false, cacheSource: 'network',
      geocodingCacheHit, coalesced: false, query,
    };
  }
  finally { countyLocationRequests.delete(locationKey); }
}

export async function clearWeatherAlertPlaceMappings() {
  const removed = await clearAlertPlaceCache();
  const geocodingEntries = await clearGeocodingCache();
  countyLocationCache.clear();
  for (const [key, value] of countyFailureCache) {
    if (value.stage === 'location') countyFailureCache.delete(key);
  }
  return removed + geocodingEntries;
}

export async function refreshWeatherAlertPlaceMapping(input, fetcher = fetch) {
  const scope = await findAdministrativeAlertScope(input, { countryCode: 'CN' });
  if (!scope || scope.kind !== 'county' || !scope.counties?.length) {
    throw new Error('请提供可唯一识别的区县全名，例如“辽宁省锦州市古塔区”。');
  }
  const county = scope.counties[0];
  const code = String(county.code);
  countyLocationCache.delete(code);
  await deleteAlertPlaceEntry(code);
  for (const key of countyFailureCache.keys()) {
    if (key.endsWith(`:${code}`)) countyFailureCache.delete(key);
  }

  const diagnostic = createCountyDiagnostic(county, scope);
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(new Error('地点强制解析超时')), COUNTY_REQUEST_TIMEOUT_MS);
  const countyFetcher = (url, options = {}) => rateLimitedFetch(
    fetcher, url, options, [timeoutController.signal], diagnostic,
  );
  try {
    const result = await resolveCountyLocation(county, scope, countyFetcher, { resolveLocation: resolveCity }, { force: true });
    await flushAlertPlaceCache();
    return {
      name: result.location.name,
      adminCode: code,
      placeId: result.location.providerIds?.placeId || null,
      latitude: result.location.latitude,
      longitude: result.location.longitude,
      requests: diagnostic.requests,
      cacheStats: await getAlertPlaceCacheStats(),
    };
  } catch (error) {
    await flushAlertPlaceCache();
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function resolveAndFetchCounty(county, scope, fetcher, settings, dependencies, scopeSignal, diagnostic) {
  const failureKey = `${aggregateRequestKey(scope, settings)}:${county.code}`;
  const previousFailure = countyFailureCache.get(failureKey);
  if (previousFailure?.expiresAt > Date.now()) {
    diagnostic.cache.failureCooldown = true;
    const error = new Error(`区县请求失败，${Math.max(1, Math.ceil((previousFailure.expiresAt - Date.now()) / 1000))} 秒内暂不重试：${previousFailure.message}`);
    error.code = previousFailure.code;
    error.stage = previousFailure.stage;
    error.category = previousFailure.category;
    error.httpStatus = previousFailure.httpStatus || null;
    error.url = previousFailure.url || null;
    diagnostic.category = previousFailure.category || classifyCountyFailure(error, previousFailure.stage);
    diagnostic.categoryLabel = COUNTY_RESULT_LABELS[diagnostic.category] || diagnostic.category;
    diagnostic.queryState = 'failure-cooldown';
    diagnostic.error = {
      type: error.code || 'cached-failure', message: error.message.slice(0, 220),
      httpStatus: error.httpStatus, timedOut: diagnostic.category === 'request-timeout',
      url: safeRequestUrl(error.url || ''),
    };
    throw error;
  }
  if (previousFailure) countyFailureCache.delete(failureKey);

  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(new Error('区县预警查询超时')), COUNTY_REQUEST_TIMEOUT_MS);
  const parentSignals = [scopeSignal, timeoutController.signal].filter(Boolean);
  const countyFetcher = (url, options = {}) => rateLimitedFetch(fetcher, url, options, parentSignals, diagnostic);
  let locationResolveMs = 0;
  let alertWallMs = 0;
  let stage = 'location';
  const started = performance.now();
  try {
    const resolveStarted = performance.now();
    let resolved;
    try { resolved = await resolveCountyLocation(county, scope, countyFetcher, dependencies); }
    finally { locationResolveMs = performance.now() - resolveStarted; }
    diagnostic.locationResolved = true;
    diagnostic.locationMatchMethod = resolved.location.locationMatchMethod || 'provider-hierarchy';
    diagnostic.locationQuery = resolved.query || diagnostic.locationQuery;
    diagnostic.resolvedLocation = resolved.location.name || null;
    diagnostic.locationIdentifier = resolved.location.providerIds?.placeId
      || resolved.location.providerIds?.entityId
      || resolved.location.providerIds?.geoId
      || `${Number(resolved.location.latitude).toFixed(5)},${Number(resolved.location.longitude).toFixed(5)}`;
    diagnostic.cache.location = Boolean(resolved.cacheHit);
    diagnostic.cache.locationSource = resolved.cacheSource || null;
    diagnostic.cache.geocoding = Boolean(resolved.geocodingCacheHit);
    diagnostic.timings.locationResolveMs = locationResolveMs;
    stage = 'alert-fetch';
    const fetchSnapshot = dependencies.fetchSnapshot || getWeatherAlertSnapshot;
    const snapshotStarted = performance.now();
    let snapshot;
    try { snapshot = await fetchSnapshot(resolved.location, countyFetcher, settings); }
    finally { alertWallMs = performance.now() - snapshotStarted; }
    diagnostic.cache.alerts = Boolean(snapshot.cacheHit);
    diagnostic.pageFetched = Boolean(snapshot.pageFetched || snapshot.cacheHit && snapshot.requestUrl);
    diagnostic.alertDataExtracted = Boolean(snapshot.alertDataExtracted ?? true);
    diagnostic.alertCount = Array.isArray(snapshot.alerts) ? snapshot.alerts.length : 0;
    diagnostic.provider = snapshot.source || null;
    diagnostic.requestUrl = snapshot.requestUrl ? safeRequestUrl(snapshot.requestUrl) : null;
    countyFailureCache.delete(failureKey);
    diagnostic.category = diagnostic.alertCount ? 'success-with-alerts' : 'success-no-alerts';
    diagnostic.categoryLabel = COUNTY_RESULT_LABELS[diagnostic.category];
    diagnostic.queryState = 'finished';
    diagnostic.httpStatus = diagnostic.requests.at(-1)?.httpStatus ?? null;
    return {
      snapshot,
      location: resolved.location,
      timings: {
        locationResolveMs,
        locationCacheHit: resolved.cacheHit,
        locationCacheSource: resolved.cacheSource,
        geocodingCacheHit: Boolean(resolved.geocodingCacheHit),
        locationCoalesced: resolved.coalesced,
        alertWallMs,
        alertCacheHit: Boolean(snapshot.cacheHit),
        requestMs: Number(snapshot.timings?.requestMs) || 0,
        providerParseMs: Number(snapshot.timings?.providerParseMs) || 0,
        normalizeMs: Number(snapshot.timings?.normalizeMs) || 0,
      },
    };
  } catch (error) {
    if (timeoutController.signal.aborted || scopeSignal?.aborted) {
      error.code ||= 'timeout';
      error.timedOut = true;
    }
    diagnostic.category = error.category || classifyCountyFailure(error, error.stage || stage);
    diagnostic.categoryLabel = COUNTY_RESULT_LABELS[diagnostic.category] || diagnostic.category;
    diagnostic.queryState = 'failed';
    diagnostic.cache.negativeLocation = Boolean(error.negativePlaceCacheHit);
    if (error.candidateLocation) {
      diagnostic.locationQuery = error.locationQuery || diagnostic.locationQuery;
      diagnostic.resolvedLocation = error.candidateLocation.name || null;
      diagnostic.locationIdentifier = error.candidateLocation.providerIds?.placeId
        || error.candidateLocation.providerIds?.entityId
        || error.candidateLocation.providerIds?.geoId
        || `${Number(error.candidateLocation.latitude).toFixed(5)},${Number(error.candidateLocation.longitude).toFixed(5)}`;
      diagnostic.locationMatchMethod = error.candidateLocation.locationMatchMethod || null;
    }
    diagnostic.error = {
      type: error.code || error.name || 'Error',
      message: String(error?.message || error).slice(0, 220),
      httpStatus: error.httpStatus || diagnostic.requests.at(-1)?.httpStatus || null,
      timedOut: Boolean(error.timedOut || error.code === 'timeout'),
      url: safeRequestUrl(error.url || diagnostic.requests.at(-1)?.url || ''),
    };
    diagnostic.httpStatus = diagnostic.error.httpStatus;
    diagnostic.pageFetched = Boolean(error.pageFetched);
    diagnostic.alertDataExtracted = Boolean(error.alertDataExtracted);
    diagnostic.requestUrl = safeRequestUrl(error.url || diagnostic.requestUrl || '');
    diagnostic.timings.locationResolveMs = locationResolveMs;
    diagnostic.timings.alertRequestMs = alertWallMs;
    if (error && typeof error === 'object') {
      error.weatherTimings = {
        locationResolveMs,
        alertWallMs,
        networkRequestMs: alertWallMs,
        providerParseMs: 0,
        normalizeMs: 0,
      };
    }
    if (!scopeSignal?.aborted && error?.code !== 'location-not-found') {
      cacheFailure(failureKey, error);
      const cachedFailure = countyFailureCache.get(failureKey);
      if (cachedFailure) {
        cachedFailure.httpStatus = diagnostic.error.httpStatus;
        cachedFailure.url = diagnostic.error.url;
      }
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
    diagnostic.timings.totalMs = performance.now() - started;
  }
}

export async function getWeatherAlertCoverageSnapshot(input, location, fetcher = fetch, settings = {}, dependencies = {}) {
  const pointSnapshot = dependencies.fetchSnapshot || getWeatherAlertSnapshot;
  const regionalIntent = regionalQueryIntent(input, location);
  let scope = null;
  let scopeError = null;
  try {
    scope = await (dependencies.findScope || findAdministrativeAlertScope)(input, location);
  } catch (error) {
    scopeError = error;
  }

  if (!scope || scope.kind === 'county') {
    const exactLocation = scope?.kind === 'county'
      ? { ...location, administrativeArea: { ...(location.administrativeArea || {}), code: scope.division.code } }
      : location;
    const snapshot = await pointSnapshot(exactLocation, fetcher, settings);
    if (!scope) {
      return {
        ...snapshot,
        coverage: { kind: regionalIntent ? 'point-only' : 'point', total: 1, successful: 1, failed: 0, unqueried: 0, complete: !regionalIntent },
        scopeNote: pointScopeNote(input, location, regionalIntent, scopeError ? '行政区划数据读取失败，未执行区域汇总。' : ''),
      };
    }
    return {
      ...snapshot,
      coverage: { kind: 'county', total: 1, successful: 1, failed: 0, unqueried: 0, complete: true },
      scopeNote: `范围：仅查询${scope.province.name}${scope.city?.name || ''}${scope.division.name}地点预警；不向上扩展到地级市或省级范围。`,
    };
  }

  const counties = scope.counties;
  const regionName = regionScopeLabel(scope);
  if (!counties.length || counties.length > MAX_AGGREGATE_COUNTIES) {
    const snapshot = await pointSnapshot(location, fetcher, settings);
    return {
      ...snapshot,
      status: 'partial',
      coverage: { kind: scope.kind, total: counties.length, successful: 0, failed: 0, unqueried: counties.length, complete: false },
      scopeNote: `范围：${regionName}未能取得可用的下属区县列表，当前仅查询代表地点“${location.name}”；结果不代表整个区域。`,
    };
  }

  const requestKey = aggregateRequestKey(scope, settings);
  await loadAggregateCache();
  if (!dependencies.proactiveBackground) {
    await registerActiveRegion(requestKey, input, location, fetcher, settings, dependencies);
  }
  const aggregateCached = readAggregateCache(requestKey);
  if (aggregateCached && !dependencies.forceRefresh) return aggregateCached;
  if (aggregateRequests.has(requestKey)) {
    const stale = readStaleAggregateCache(requestKey);
    if (dependencies.proactiveBackground || !stale || !aggregateRequestBackground.has(requestKey)) {
      return aggregateRequests.get(requestKey).then(snapshot => ({ ...snapshot, coalesced: true }));
    }
    return stale;
  }
  const stale = readStaleAggregateCache(requestKey);
  const proactiveEnabled = dependencies.backgroundRefresh !== false && process.env.WEATHER_ALERT_BACKGROUND_REFRESH !== '0';
  if (stale && !dependencies.forceRefresh && proactiveEnabled) {
    const active = activeRegions.get(requestKey);
    if (active) {
      active.nextRefreshAt = Date.now();
      scheduleNextActiveRefresh();
      scheduleActiveRegionsWrite();
    }
    return stale;
  }
  let requestController = null;
  const job = (async () => {
    const controller = new AbortController();
    if (dependencies.proactiveBackground) {
      requestController = controller;
      backgroundControllers.add(controller);
    }
    if (dependencies.proactiveBackground) {
      const state = regionRefreshStates.get(requestKey);
      if (state) state.controller = controller;
    }
    const requests = { msnPlaceSearch: 0, msnWeatherPage: 0, weatherApi: 0, other: 0 };
    const phaseTimings = {
      locationResolveMs: 0,
      placeSearchRequestMs: 0,
      networkRequestMs: 0,
      providerParseMs: 0,
      normalizationMs: 0,
      dedupeMs: 0,
      renderMs: 0,
      locationCacheHits: 0,
      placeMappingCacheHits: 0,
      negativePlaceCacheHits: 0,
      persistentPlaceCacheHits: 0,
      geocodingCacheHits: 0,
      placeCachePersistMs: 0,
      alertCacheHits: 0,
      countyFailuresCached: 0,
    };
    const fetcherForScope = boundedFetcher(fetcher, controller, (rawUrl, elapsedMs) => {
      const url = String(rawUrl);
      if (/assets\.msn\.cn\/service\/weather\/api\/v\d+\/Places\/AutoSuggest/i.test(url)) {
        requests.msnPlaceSearch++;
        phaseTimings.placeSearchRequestMs += elapsedMs;
      } else if (/api\.weatherapi\.com/i.test(url)) requests.weatherApi++;
      else if (/msn\.(?:cn|com)\//i.test(url)) requests.msnWeatherPage++;
      else requests.other++;
    });
    const configuredBudget = configuredInteger('WEATHER_ALERT_TOTAL_TIMEOUT_MS', MAX_AGGREGATE_DURATION_MS, 1_000, 180_000);
    const requestedBudget = Number.isFinite(Number(dependencies.timeoutMs))
      ? Number(dependencies.timeoutMs) : configuredBudget;
    const timeBudgetMs = Math.max(1, Math.min(requestedBudget, 180_000));
    const startedAt = Date.now();
    const deadlineAt = startedAt + timeBudgetMs;
    const concurrency = Math.max(1, Math.min(
      MAX_AGGREGATE_CONCURRENCY,
      dependencies.concurrency ?? configuredInteger('WEATHER_ALERT_CONCURRENCY', DEFAULT_AGGREGATE_CONCURRENCY, 1, MAX_AGGREGATE_CONCURRENCY),
      counties.length,
    ));
    const records = [];
    let oldestSnapshotFetchedAt = Date.now();
    const diagnostics = counties.map(county => createCountyDiagnostic(county, scope));
    const sourceLabels = new Set();
    const sourceKinds = new Set();
    let next = 0;
    let started = 0;
    let completed = 0;
    let successful = 0;
    let failed = 0;
    let closed = false;
    const failureSamples = [];
    const workers = Array.from({ length: concurrency }, async () => {
      while (!closed && Date.now() < deadlineAt) {
        const index = next++;
        if (index >= counties.length) return;
        const county = counties[index];
        const diagnostic = diagnostics[index];
        diagnostic.queryState = 'in-progress';
        diagnostic.backgroundRefresh = Boolean(dependencies.proactiveBackground);
        started++;
        try {
          const result = await resolveAndFetchCounty(
            county, scope, fetcherForScope,
            dependencies.proactiveBackground ? { ...settings, forceAlertRefresh: true } : settings,
            dependencies, controller.signal, diagnostic,
          );
          if (closed) return;
          completed++;
          successful++;
          const countyFetchedAt = Date.parse(result.snapshot.fetchedAt || '');
          if (Number.isFinite(countyFetchedAt)) oldestSnapshotFetchedAt = Math.min(oldestSnapshotFetchedAt, countyFetchedAt);
          for (const alert of result.snapshot.alerts || []) records.push({ alert, county });
          const canonicalSource = canonicalAlertSource(result.snapshot.source, result.snapshot.sourceLabel);
          if (canonicalSource) sourceLabels.add(canonicalSource);
          if (result.snapshot.source) sourceKinds.add(result.snapshot.source);
          phaseTimings.locationResolveMs += result.timings.locationResolveMs;
          if (result.timings.locationCacheHit) {
            phaseTimings.locationCacheHits++;
            phaseTimings.placeMappingCacheHits++;
            if (result.timings.locationCacheSource === 'disk') phaseTimings.persistentPlaceCacheHits++;
          }
          if (result.timings.geocodingCacheHit) phaseTimings.geocodingCacheHits++;
          if (result.timings.alertCacheHit) phaseTimings.alertCacheHits++;
          if (!result.timings.alertCacheHit) {
            phaseTimings.networkRequestMs += result.timings.requestMs;
            phaseTimings.providerParseMs += result.timings.providerParseMs;
            phaseTimings.normalizationMs += result.timings.normalizeMs;
          }
          try { dependencies.onCountyDiagnostic?.(diagnostic); } catch {}
        } catch (error) {
          if (closed) return;
          completed++;
          failed++;
          if (/短时间内|暂不重试/.test(String(error?.message || ''))) phaseTimings.countyFailuresCached++;
          if (diagnostic.cache.negativeLocation) phaseTimings.negativePlaceCacheHits++;
          phaseTimings.locationResolveMs += Number(error?.weatherTimings?.locationResolveMs) || 0;
          phaseTimings.networkRequestMs += Number(error?.weatherTimings?.networkRequestMs) || 0;
          if (failureSamples.length < 5) failureSamples.push({ county: county.name, reason: String(error?.message || error).slice(0, 180) });
          try { dependencies.onCountyDiagnostic?.(diagnostic); } catch {}
        }
      }
    });
    let timeoutHandle;
    const timedOut = new Promise(resolve => {
      const remaining = Math.max(1, deadlineAt - Date.now());
      timeoutHandle = setTimeout(() => {
        controller.abort();
        resolve(false);
      }, remaining);
    });
    const finished = await Promise.race([Promise.all(workers).then(() => true), timedOut]);
    clearTimeout(timeoutHandle);
    closed = true;
    if (!finished) {
      controller.abort(new Error('省市级预警扫描达到总时限'));
      for (const diagnostic of diagnostics) {
        if (diagnostic.queryState !== 'in-progress') continue;
        diagnostic.queryState = 'failed';
        diagnostic.category = 'request-timeout';
        diagnostic.categoryLabel = COUNTY_RESULT_LABELS['request-timeout'];
        diagnostic.error = {
          type: 'aggregate-timeout', message: '省市级预警扫描达到总时限',
          httpStatus: diagnostic.requests.at(-1)?.httpStatus ?? null,
          timedOut: true, url: diagnostic.requests.at(-1)?.url || '',
        };
        try { dependencies.onCountyDiagnostic?.(diagnostic); } catch {}
      }
    }
    for (const diagnostic of diagnostics) {
      if (diagnostic.queryState === 'not-queried') {
        try { dependencies.onCountyDiagnostic?.(diagnostic); } catch {}
      }
    }
    const placeCachePersistStarted = performance.now();
    await flushAlertPlaceCache();
    phaseTimings.placeCachePersistMs = performance.now() - placeCachePersistStarted;
    const successfulCategories = new Set(['success-with-alerts', 'success-no-alerts']);
    const resultCounts = Object.fromEntries(Object.keys(COUNTY_RESULT_LABELS).map(category => [category, 0]));
    for (const diagnostic of diagnostics) resultCounts[diagnostic.category] = (resultCounts[diagnostic.category] || 0) + 1;
    successful = resultCounts['success-with-alerts'] + resultCounts['success-no-alerts'];
    failed = diagnostics.filter(item => !successfulCategories.has(item.category) && item.category !== 'not-queried').length;
    const unqueried = resultCounts['not-queried'];
    const complete = finished && successful === counties.length && failed === 0 && unqueried === 0;
    const dedupeStarted = performance.now();
    const alerts = dedupeAggregatedWeatherAlerts(records);
    phaseTimings.dedupeMs = performance.now() - dedupeStarted;
    const coverage = {
      kind: scope.kind,
      total: counties.length,
      successful,
      failed,
      unqueried,
      complete,
      resultCounts,
      failureCounts: Object.fromEntries(Object.entries(resultCounts).filter(([category, count]) => count > 0
        && !successfulCategories.has(category) && category !== 'not-queried')),
      diagnostics,
      requests,
      realRequests: Object.values(requests).reduce((sum, count) => sum + count, 0),
      failureSamples,
      dataDate: scope.dataDate || ADMIN_DIVISION_DATA_DATE,
      dataSource: ADMIN_DIVISION_DATA_SOURCE,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      oldestDataFetchedAt: new Date(oldestSnapshotFetchedAt).toISOString(),
      timings: phaseTimings,
    };
    const sources = [...sourceLabels];
    const sourceLabel = sources.length ? sources.join('、') : null;
    const snapshot = {
      status: complete ? 'ok' : 'partial',
      alerts,
      source: sourceKinds.size === 1 ? [...sourceKinds][0] : sourceKinds.size ? 'mixed' : null,
      sources,
      sourceLabel,
      fetchedAt: new Date(oldestSnapshotFetchedAt).toISOString(),
      coverage,
      timings: { ...phaseTimings, totalMs: coverage.elapsedMs },
      scopeNote: `已查询 ${successful}/${counties.length} 个地区${failed ? ` · ${failed} 个地区查询失败` : ''}${unqueried ? ` · ${unqueried} 个地区未查询` : ''}`,
    };
    if (complete) clearBackgroundRetry(requestKey);
    else scheduleBackgroundRetry(requestKey, input, location, fetcher, settings, dependencies, coverage);
    const previous = aggregateCache.get(requestKey);
    const preservePrevious = dependencies.proactiveBackground && !complete
      && previous?.snapshot?.coverage?.complete === true;
    if (preservePrevious) {
      previous.refreshFailedAt = Date.now();
      scheduleAggregateCacheWrite();
      return snapshot;
    }
    return cacheAggregateSnapshot(requestKey, snapshot);
  })();
  aggregateRequests.set(requestKey, job);
  if (dependencies.proactiveBackground) aggregateRequestBackground.add(requestKey);
  try { return await job; }
  finally {
    aggregateRequests.delete(requestKey);
    aggregateRequestBackground.delete(requestKey);
    if (requestController) backgroundControllers.delete(requestController);
    const state = regionRefreshStates.get(requestKey);
    if (state) delete state.controller;
  }
}

export async function getWeatherAlerts(location, fetcher = fetch, settings = {}) {
  return (await getWeatherAlertSnapshot(location, fetcher, settings)).alerts;
}
