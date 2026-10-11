import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const CACHE_VERSION = 1;
const CACHE_LIMIT = 4_000;
let positiveEntries = new Map();
let negativeEntries = new Map();
let loaded = false;
let loadPromise;
let writeQueue = Promise.resolve();
let writeTimer;

function cacheFile() {
  return path.resolve(process.env.WEATHER_ALERT_PLACE_CACHE_FILE || 'data/weather-panel/alert-place-cache.json');
}

function positiveTtlMs() {
  const days = Number(process.env.WEATHER_ALERT_PLACE_CACHE_TTL_DAYS);
  const value = Number.isFinite(days) ? Math.max(1, Math.min(730, Math.floor(days))) : 180;
  return value * 24 * 60 * 60 * 1000;
}

function negativeTtlMs() {
  const hours = Number(process.env.WEATHER_ALERT_PLACE_NEGATIVE_TTL_HOURS);
  const value = Number.isFinite(hours) ? Math.max(1, Math.min(720, Math.floor(hours))) : 24;
  return value * 60 * 60 * 1000;
}

function finiteTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function validPositiveEntry(entry) {
  const location = entry?.location;
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);
  return /^\d{2,12}$/u.test(String(entry?.adminCode || ''))
    && typeof entry?.provinceName === 'string' && entry.provinceName.length > 0
    && typeof entry?.countyName === 'string' && entry.countyName.length > 0
    && location?.geocoder === 'msn'
    && String(location?.countryCode || location?.administrativeArea?.countryCode || '').toUpperCase() === 'CN'
    && Number.isFinite(latitude) && Math.abs(latitude) <= 90
    && Number.isFinite(longitude) && Math.abs(longitude) <= 180
    && Boolean(location?.name)
    && finiteTimestamp(entry?.expiresAt) > Date.now();
}

function validNegativeEntry(entry) {
  return /^\d{2,12}$/u.test(String(entry?.adminCode || ''))
    && typeof entry?.provinceName === 'string' && entry.provinceName.length > 0
    && typeof entry?.countyName === 'string' && entry.countyName.length > 0
    && entry?.errorCode === 'location-not-found'
    && finiteTimestamp(entry?.expiresAt) > Date.now();
}

async function writeSnapshot() {
  const file = cacheFile();
  const now = Date.now();
  const positive = [...positiveEntries.entries()]
    .filter(([, entry]) => validPositiveEntry(entry))
    .slice(-CACHE_LIMIT);
  const negative = [...negativeEntries.entries()]
    .filter(([, entry]) => validNegativeEntry(entry))
    .slice(-CACHE_LIMIT);
  const contents = JSON.stringify({ version: CACHE_VERSION, positive, negative });
  const job = writeQueue.then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${now}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, contents, 'utf8');
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  });
  writeQueue = job.catch(error => {
    console.warn(`[天气插件] 地点映射缓存写入失败：${error?.message || error}`);
  });
  await job.catch(() => {});
}

function scheduleWrite() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void writeSnapshot();
  }, 1000);
  writeTimer.unref?.();
}

async function loadCache() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    let rebuild = false;
    try {
      const saved = JSON.parse(await fs.readFile(cacheFile(), 'utf8'));
      if (saved?.version !== CACHE_VERSION || !Array.isArray(saved.positive) || !Array.isArray(saved.negative)) {
        rebuild = true;
      } else {
        for (const [key, entry] of saved.positive) {
          if (String(key) === String(entry?.adminCode) && validPositiveEntry(entry)) positiveEntries.set(String(key), entry);
          else rebuild = true;
        }
        for (const [key, entry] of saved.negative) {
          if (String(key) === String(entry?.adminCode) && validNegativeEntry(entry)) negativeEntries.set(String(key), entry);
          else rebuild = true;
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        rebuild = true;
        console.warn(`[天气插件] 地点映射缓存无效，将安全重建：${error?.message || error}`);
      }
    }
    loaded = true;
    if (rebuild) await writeSnapshot();
  })().catch(error => {
    loaded = true;
    console.warn(`[天气插件] 地点映射缓存读取失败，继续使用空缓存：${error?.message || error}`);
  });
  return loadPromise;
}

export async function getAlertPlaceMapping(adminCode) {
  await loadCache();
  const key = String(adminCode);
  const entry = positiveEntries.get(key);
  if (!entry) return null;
  if (!validPositiveEntry(entry)) {
    positiveEntries.delete(key);
    scheduleWrite();
    return null;
  }
  positiveEntries.delete(key);
  positiveEntries.set(key, entry);
  return { ...entry, cacheSource: 'disk' };
}

export async function setAlertPlaceMapping(mapping) {
  await loadCache();
  const now = Date.now();
  const entry = {
    ...mapping,
    validatedAt: now,
    expiresAt: now + positiveTtlMs(),
  };
  if (!validPositiveEntry(entry)) return false;
  const key = String(entry.adminCode);
  positiveEntries.delete(key);
  positiveEntries.set(key, entry);
  negativeEntries.delete(key);
  while (positiveEntries.size > CACHE_LIMIT) positiveEntries.delete(positiveEntries.keys().next().value);
  scheduleWrite();
  return true;
}

export async function getAlertPlaceNegative(adminCode) {
  await loadCache();
  const key = String(adminCode);
  const entry = negativeEntries.get(key);
  if (!entry) return null;
  if (!validNegativeEntry(entry)) {
    negativeEntries.delete(key);
    scheduleWrite();
    return null;
  }
  negativeEntries.delete(key);
  negativeEntries.set(key, entry);
  return { ...entry, cacheSource: 'disk' };
}

export async function setAlertPlaceNegative(entry) {
  await loadCache();
  const now = Date.now();
  const value = { ...entry, cachedAt: now, expiresAt: now + negativeTtlMs() };
  if (!validNegativeEntry(value)) return false;
  const key = String(value.adminCode);
  positiveEntries.delete(key);
  negativeEntries.delete(key);
  negativeEntries.set(key, value);
  while (negativeEntries.size > CACHE_LIMIT) negativeEntries.delete(negativeEntries.keys().next().value);
  scheduleWrite();
  return true;
}

export async function deleteAlertPlaceEntry(adminCode) {
  await loadCache();
  const key = String(adminCode);
  const changed = positiveEntries.delete(key) || negativeEntries.delete(key);
  negativeEntries.delete(key);
  positiveEntries.delete(key);
  if (changed) scheduleWrite();
  return changed;
}

export async function clearAlertPlaceCache() {
  await loadCache();
  const count = positiveEntries.size + negativeEntries.size;
  positiveEntries.clear();
  negativeEntries.clear();
  clearTimeout(writeTimer);
  writeTimer = null;
  await writeSnapshot();
  return count;
}

export async function flushAlertPlaceCache() {
  await loadCache();
  if (!writeTimer) return writeQueue;
  clearTimeout(writeTimer);
  writeTimer = null;
  await writeSnapshot();
}

export async function getAlertPlaceCacheStats() {
  await loadCache();
  const now = Date.now();
  return {
    positive: [...positiveEntries.values()].filter(entry => entry.expiresAt > now).length,
    negative: [...negativeEntries.values()].filter(entry => entry.expiresAt > now).length,
    file: cacheFile(),
    positiveTtlMs: positiveTtlMs(),
    negativeTtlMs: negativeTtlMs(),
    loaded,
  };
}
