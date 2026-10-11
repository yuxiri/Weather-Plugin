import fs from 'node:fs/promises';
import path from 'node:path';

export let ADMIN_DIVISION_DATA_DATE = '2025-12-31';
export const ADMIN_DIVISION_DATA_SOURCE = 'China National Place Names Information Database, mirrored by FHZDCJ';
export const ADMIN_DIVISION_UPDATE_INTERVAL_MS = 180 * 24 * 60 * 60 * 1000;
export const ADMIN_DIVISION_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;

const DATA_FILE = path.resolve('data/weather-panel/admin-divisions.json');
const META_FILE = path.resolve('data/weather-panel/admin-divisions-meta.json');
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const MAX_DATA_BYTES = 2 * 1024 * 1024;
const MAX_README_BYTES = 256 * 1024;
const DEFAULT_SOURCES = [
  {
    id: 'github',
    dataUrl: 'https://raw.githubusercontent.com/FHZDCJ/administrative-division-code-of-China/main/Dist/pca-code.json',
    readmeUrl: 'https://raw.githubusercontent.com/FHZDCJ/administrative-division-code-of-China/main/README.md',
  },
  {
    id: 'gitee',
    dataUrl: 'https://gitee.com/FHZDCJ/administrative-division-code-of-china/raw/main/Dist/pca-code.json',
    readmeUrl: 'https://gitee.com/FHZDCJ/administrative-division-code-of-china/raw/main/README.md',
  },
];

let divisionsPromise;
let divisionsData;
let backgroundUpdatePromise;
let updateTimer;

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validateAdministrativeDivisions(data) {
  if (!Array.isArray(data) || data.length < 31 || data.length > 40) {
    throw new Error('行政区划数据省级节点数量异常');
  }

  const codes = new Set();
  let prefectures = 0;
  let counties = 0;
  const validateNode = (node, depth) => {
    if (!isRecord(node) || typeof node.code !== 'string' || !/^\d{2,12}$/u.test(node.code)
      || typeof node.name !== 'string' || !node.name.trim() || codes.has(node.code)) {
      throw new Error('行政区划数据包含无效或重复的节点');
    }
    codes.add(node.code);
    if (node.children !== undefined && !Array.isArray(node.children)) {
      throw new Error('行政区划数据层级格式错误');
    }
    if (depth > 2 && Array.isArray(node.children) && node.children.length) {
      throw new Error('行政区划数据超过预期层级');
    }
    if (Array.isArray(node.children)) {
      if (depth === 0) {
        for (const child of node.children) {
          if (Array.isArray(child?.children)) {
            prefectures++;
            validateNode(child, depth + 1);
          } else {
            counties++;
            validateNode(child, depth + 2);
          }
        }
      } else if (depth === 1) {
        for (const child of node.children) {
          counties++;
          validateNode(child, depth + 1);
        }
      }
    }
  };

  for (const province of data) validateNode(province, 0);
  if (prefectures < 300 || counties < 2_500) {
    throw new Error(`行政区划数据覆盖数量异常（地级 ${prefectures}，县级 ${counties}）`);
  }
  return data;
}

function validDataDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseSourceDataDate(readme) {
  const text = String(readme || '');
  const match = text.match(/截止日期(?:为|是|：|:)\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/u)
    || text.match(/截止日期(?:为|是|：|:)\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/u);
  if (!match) throw new Error('未能从数据源说明中确认行政区划数据日期');
  const [, year, month, day] = match;
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (!validDataDate(date)) throw new Error('数据源提供的行政区划日期无效');
  return date;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), 'utf8');
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function requestOptions(etag) {
  const headers = { 'User-Agent': 'Weather-Plugin/1.1', Accept: 'application/json, text/plain;q=0.9, */*;q=0.8' };
  if (etag) headers['If-None-Match'] = etag;
  return { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}

async function fetchText(fetcher, url, limit, etag = '') {
  const response = await fetcher(url, requestOptions(etag));
  if (response.status === 304) return { notModified: true, etag };
  if (!response.ok) throw new Error(`数据源返回 HTTP ${response.status}`);
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new Error('数据源文件超过大小限制');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > limit) throw new Error('数据源文件超过大小限制');
  return { text, etag: response.headers?.get?.('etag') || '' };
}

function timestamp(value) {
  const number = Date.parse(value || '');
  return Number.isFinite(number) ? number : 0;
}

function nextUpdateTimestamp(meta) {
  const nextAttemptAt = timestamp(meta?.nextAttemptAt);
  const lastSuccessAt = timestamp(meta?.lastSuccessAt);
  const lastAttemptAt = timestamp(meta?.lastAttemptAt);
  if (meta?.lastError) return nextAttemptAt;
  if (lastSuccessAt && lastAttemptAt <= lastSuccessAt) {
    return Math.max(nextAttemptAt, lastSuccessAt + ADMIN_DIVISION_UPDATE_INTERVAL_MS);
  }
  return nextAttemptAt;
}

function normalizeSuccessfulSchedule(meta) {
  const nextAt = nextUpdateTimestamp(meta);
  if (!nextAt || !meta?.lastSuccessAt || meta.lastError || nextAt <= timestamp(meta.nextAttemptAt)) return meta;
  return { ...meta, nextAttemptAt: new Date(nextAt).toISOString() };
}

function shouldCheckForUpdate(meta, now) {
  const nextAt = nextUpdateTimestamp(meta);
  return !nextAt || nextAt <= now;
}

export async function refreshAdministrativeDivisionData({
  dataFile = DATA_FILE,
  metaFile = META_FILE,
  sources = DEFAULT_SOURCES,
  fetcher = fetch,
  now = Date.now(),
  force = false,
} = {}) {
  const storedMeta = await readJson(metaFile).catch(() => null) || {};
  const meta = normalizeSuccessfulSchedule(storedMeta);
  if (meta !== storedMeta) await writeJsonAtomic(metaFile, meta);
  if (!force && !shouldCheckForUpdate(meta, now)) {
    return { updated: false, skipped: true, dataDate: meta.dataDate || ADMIN_DIVISION_DATA_DATE };
  }

  const existingData = await readJson(dataFile).catch(() => null);
  let validatedExisting = null;
  try { validatedExisting = validateAdministrativeDivisions(existingData); } catch {}

  const attemptAt = new Date(now).toISOString();
  const retryMeta = {
    ...meta,
    lastAttemptAt: attemptAt,
    nextAttemptAt: new Date(now + ADMIN_DIVISION_RETRY_INTERVAL_MS).toISOString(),
  };
  await writeJsonAtomic(metaFile, retryMeta);

  const errors = [];
  for (const source of sources) {
    try {
      const etag = meta.sourceId === source.id ? String(meta.etag || '') : '';
      const remote = await fetchText(fetcher, source.dataUrl, MAX_DATA_BYTES, etag);
      if (remote.notModified) {
        if (!validatedExisting || !validDataDate(meta.dataDate)) throw new Error('服务器返回未变更，但本地数据或版本日期缺失');
        const successMeta = {
          ...retryMeta,
          dataDate: meta.dataDate,
          sourceId: source.id,
          etag: remote.etag || etag,
          lastSuccessAt: attemptAt,
          nextAttemptAt: new Date(now + ADMIN_DIVISION_UPDATE_INTERVAL_MS).toISOString(),
        };
        delete successMeta.lastError;
        await writeJsonAtomic(metaFile, successMeta);
        return { updated: false, skipped: false, unchanged: true, data: validatedExisting, dataDate: successMeta.dataDate };
      }

      const data = validateAdministrativeDivisions(JSON.parse(remote.text));
      const readme = await fetchText(fetcher, source.readmeUrl, MAX_README_BYTES);
      if (readme.notModified) throw new Error('数据源说明返回异常状态');
      const dataDate = parseSourceDataDate(readme.text);
      const nextMeta = {
        ...retryMeta,
        dataDate,
        sourceId: source.id,
        etag: remote.etag,
        lastSuccessAt: attemptAt,
        nextAttemptAt: new Date(now + ADMIN_DIVISION_UPDATE_INTERVAL_MS).toISOString(),
      };
      delete nextMeta.lastError;

      await writeJsonAtomic(dataFile, data);
      await writeJsonAtomic(metaFile, nextMeta);
      if (path.resolve(dataFile) === DATA_FILE) {
        divisionsData = data;
        ADMIN_DIVISION_DATA_DATE = dataDate;
      }
      return { updated: true, data, dataDate, source: source.id };
    } catch (error) {
      errors.push(`${source.id}: ${String(error?.message || error).slice(0, 180)}`);
    }
  }

  const message = `行政区划自动更新失败：${errors.join('；') || '没有可用数据源'}`;
  await writeJsonAtomic(metaFile, { ...retryMeta, lastError: message }).catch(() => {});
  return { updated: false, dataDate: meta.dataDate || ADMIN_DIVISION_DATA_DATE, error: message };
}

async function initializeDivisions() {
  let meta = {};
  try {
    meta = await readJson(META_FILE) || {};
  } catch {}
  const normalizedMeta = normalizeSuccessfulSchedule(meta);
  if (normalizedMeta !== meta) {
    meta = normalizedMeta;
    void writeJsonAtomic(META_FILE, meta).catch(() => {});
  }

  try {
    divisionsData = validateAdministrativeDivisions(await readJson(DATA_FILE));
    if (validDataDate(meta.dataDate)) ADMIN_DIVISION_DATA_DATE = meta.dataDate;
  } catch {
    divisionsData = null;
  }

  if (!divisionsData) {
    divisionsData = validateAdministrativeDivisions(
      await fs.readFile(new URL('../resources/admin-divisions.json', import.meta.url), 'utf8').then(JSON.parse),
    );
    ADMIN_DIVISION_DATA_DATE = '2025-12-31';
  }

  const autoUpdateDisabled = process.env.WEATHER_ADMIN_DIVISION_AUTO_UPDATE === '0';
  if (!autoUpdateDisabled) {
    if (shouldCheckForUpdate(meta, Date.now())) void startBackgroundUpdate();
    else scheduleAdministrativeUpdate(nextUpdateTimestamp(meta));
  }
}

function scheduleAdministrativeUpdate(nextAt) {
  if (process.env.WEATHER_ADMIN_DIVISION_AUTO_UPDATE === '0') return;
  clearTimeout(updateTimer);
  const now = Date.now();
  const delay = Math.min(nextAt > now ? nextAt - now : ADMIN_DIVISION_RETRY_INTERVAL_MS, MAX_TIMER_DELAY_MS);
  updateTimer = setTimeout(() => {
    updateTimer = null;
    void startBackgroundUpdate();
  }, delay);
  updateTimer.unref?.();
}

function startBackgroundUpdate() {
  if (process.env.WEATHER_ADMIN_DIVISION_AUTO_UPDATE === '0' || backgroundUpdatePromise) return backgroundUpdatePromise;
  backgroundUpdatePromise = refreshAdministrativeDivisionData()
    .then(result => {
      if (result.error) console.warn(`[天气插件] ${result.error}，继续使用本地行政区划数据。`);
    })
    .catch(error => console.warn(`[天气插件] 行政区划自动更新失败，继续使用本地数据：${error?.message || error}`))
    .finally(async () => {
      backgroundUpdatePromise = null;
      let nextAt = 0;
      try { nextAt = nextUpdateTimestamp(await readJson(META_FILE)); } catch {}
      scheduleAdministrativeUpdate(nextAt);
    });
  return backgroundUpdatePromise;
}

async function loadDivisions() {
  if (!divisionsPromise) divisionsPromise = initializeDivisions();
  await divisionsPromise;
  return divisionsData;
}

export async function initializeAdministrativeDivisionUpdates() {
  await loadDivisions();
}

function normalizedName(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[\s,，、·._-]/g, '')
    .replace(/(?:特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|自治盟|自治县|自治旗|地区|省|市|区|县|旗|盟|州)$/u, '');
}

function normalizedPath(value) {
  return normalizedName(value).replace(/(?:特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|自治盟|自治县|自治旗|地区|省|市|区|县|旗|盟|州)/gu, '');
}

function divisionRows(data) {
  const rows = [];
  for (const province of data) {
    const cities = (province.children || []).filter(item => Array.isArray(item.children));
    const countiesDirect = (province.children || []).filter(item => !Array.isArray(item.children));
    rows.push({ province, city: null, county: null, kind: 'province',
      children: [
        ...countiesDirect.map(county => ({ ...county, parentCity: null })),
        ...cities.flatMap(city => (city.children || []).map(county => ({ ...county, parentCity: city.name }))),
      ] });
    for (const city of cities) {
      rows.push({ province, city, county: null, kind: 'city',
        children: (city.children || []).map(county => ({ ...county, parentCity: city.name })) });
      for (const county of city.children || []) {
        rows.push({ province, city, county, kind: 'county', children: [] });
      }
    }
    for (const county of countiesDirect) {
      rows.push({ province, city: null, county, kind: 'county', children: [] });
    }
  }
  return rows;
}

function resolveDivision(rows, input, location) {
  const name = normalizedName(input);
  const inputPath = normalizedPath(input);
  if (!name) return null;
  const resolvedPath = normalizedPath(location?.name || '');
  const area = location?.administrativeArea || {};
  const region = normalizedName(area.region);
  const subregion = normalizedName(area.subregion);

  const candidates = rows.filter(row => {
    const node = row.kind === 'province' ? row.province
      : row.kind === 'city' ? row.city : row.county;
    const pathValue = [row.province.name, row.city?.name, row.county?.name].filter(Boolean).join('');
    if (!node || (normalizedName(node.name) !== name && normalizedPath(pathValue) !== inputPath)) return false;
    if (row.kind === 'city' && region && normalizedName(row.province.name) !== region) return false;
    if (row.kind === 'county' && region && normalizedName(row.province.name) !== region) return false;
    if (row.kind === 'county' && subregion && row.city
      && normalizedName(row.city.name) !== subregion) return false;
    return true;
  });
  if (!candidates.length) return null;

  const pathMatches = candidates.filter(row => {
    const pathValue = [row.province.name, row.city?.name, row.county?.name].filter(Boolean).join('');
    return resolvedPath && resolvedPath.includes(normalizedPath(pathValue));
  });
  const narrowed = pathMatches.length ? pathMatches : candidates;
  const priority = { county: 3, city: 2, province: 1 };
  const highest = Math.max(...narrowed.map(row => priority[row.kind]));
  const best = narrowed.filter(row => priority[row.kind] === highest);
  if (best.length !== 1) return null;
  return best[0];
}

export async function findAdministrativeAlertScope(input, location) {
  const data = await loadDivisions();
  const rows = divisionRows(data);
  const row = resolveDivision(rows, input, location);
  if (!row) return null;
  if (row.kind === 'county') {
    return {
      kind: 'county',
      division: row.county,
      province: row.province,
      city: row.city,
      counties: [row.county],
      dataDate: ADMIN_DIVISION_DATA_DATE,
    };
  }

  const counties = row.children.filter(item => item && item.code && item.name);
  const province = row.province;
  const city = row.city;
  return {
    kind: row.kind,
    division: city || province,
    province,
    city,
    counties,
    dataDate: ADMIN_DIVISION_DATA_DATE,
  };
}

export async function getAdministrativeAlertDataStats() {
  const data = await loadDivisions();
  const rows = divisionRows(data);
  return {
    provinces: data.length,
    prefectures: rows.filter(row => row.kind === 'city').length,
    counties: rows.filter(row => row.kind === 'county').length,
    dataDate: ADMIN_DIVISION_DATA_DATE,
  };
}
