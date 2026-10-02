import fs from 'node:fs/promises';
import path from 'node:path';

const ALIASES = new Map([
  ['北京', ['Beijing', 'CN']], ['北京市', ['Beijing', 'CN']],
  ['东京', ['Tokyo', 'JP']], ['东京都', ['Tokyo', 'JP']],
  ['洛杉矶', ['Los Angeles', 'US']], ['洛杉磯', ['Los Angeles', 'US']],
]);

const GEOCODING_CACHE_TTL = 90 * 24 * 60 * 60 * 1000;
const GEOCODING_CACHE_LIMIT = 1000;
const geocodingCacheFile = path.resolve(process.env.WEATHER_GEOCODING_CACHE_FILE || 'data/weather-panel/geocoding-cache.json');
const geocodingCache = new Map();
let geocodingCacheLoad;
let geocodingCacheWrite = Promise.resolve();
let photonQueue = Promise.resolve();
let lastPhotonRequest = 0;

async function loadGeocodingCache() {
  if (!geocodingCacheLoad) {
    geocodingCacheLoad = (async () => {
      try {
        const data = JSON.parse(await fs.readFile(geocodingCacheFile, 'utf8'));
        for (const [key, item] of Object.entries(data)) {
          if (item?.expiresAt > Date.now() && item.location?.latitude != null && item.location?.longitude != null) {
            geocodingCache.set(key, item);
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    })();
  }
  await geocodingCacheLoad;
}

async function cachedLocation(key) {
  await loadGeocodingCache();
  const item = geocodingCache.get(key);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    geocodingCache.delete(key);
    return null;
  }
  geocodingCache.delete(key);
  geocodingCache.set(key, item);
  return item.location;
}

async function cacheLocation(key, location) {
  await loadGeocodingCache();
  geocodingCache.delete(key);
  geocodingCache.set(key, { expiresAt: Date.now() + GEOCODING_CACHE_TTL, location });
  while (geocodingCache.size > GEOCODING_CACHE_LIMIT) geocodingCache.delete(geocodingCache.keys().next().value);
  const job = geocodingCacheWrite.then(async () => {
    await fs.mkdir(path.dirname(geocodingCacheFile), { recursive: true });
    const temp = `${geocodingCacheFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(Object.fromEntries(geocodingCache), null, 2), 'utf8');
    await fs.rename(temp, geocodingCacheFile);
  });
  geocodingCacheWrite = job.catch(() => {});
  await job;
}

const normalizedPlace = value => String(value || '').toLocaleLowerCase().replace(/[\s,，、·._-]/g, '');

function photonLocationName(properties, requestedName) {
  const name = String(properties.name || requestedName).trim();
  const parent = properties.city || properties.district || properties.state || '';
  return parent && normalizedPlace(parent) !== normalizedPlace(name) ? `${name}·${parent}` : name;
}

function selectPhotonFeature(features, raw, namePart, parentHints, countryCode) {
  const wanted = normalizedPlace(namePart);
  const rawName = normalizedPlace(raw);
  const hints = parentHints.map(normalizedPlace).filter(Boolean);
  const candidates = (features || []).map(feature => {
    const properties = feature?.properties || {};
    const coordinates = feature?.geometry?.coordinates || [];
    const name = normalizedPlace(properties.name);
    const exact = name && (name === wanted || rawName.includes(name));
    const admin = ['district', 'city', 'county', 'locality'].includes(properties.type)
      || properties.osm_key === 'place'
      || (properties.osm_key === 'boundary' && properties.osm_value === 'administrative');
    const context = [properties.city, properties.district, properties.state, properties.country]
      .filter(Boolean).map(normalizedPlace);
    const contextMatches = hints.filter(hint => context.some(value => value.includes(hint) || hint.includes(value))).length;
    const countryMatches = !countryCode || String(properties.countrycode || '').toUpperCase() === countryCode;
    return {
      feature, properties, coordinates, exact, admin, contextMatches, countryMatches,
      score: (exact ? 100 : 0) + (admin ? 20 : 0) + contextMatches * 60 + (countryMatches ? 10 : -100),
    };
  }).filter(item => item.countryMatches && item.coordinates.length >= 2
    && Number.isFinite(Number(item.coordinates[0])) && Number.isFinite(Number(item.coordinates[1])))
    .sort((a, b) => b.score - a.score);

  const top = candidates[0];
  if (!top) return null;
  const duplicate = candidates.find(item => item !== top && item.exact && item.admin && top.exact && top.admin
    && item.score === top.score
    && normalizedPlace(item.properties.city || item.properties.state) !== normalizedPlace(top.properties.city || top.properties.state));
  if (duplicate && !hints.length) {
    const parents = [...new Set([top, duplicate].map(item => item.properties.city || item.properties.state).filter(Boolean))];
    throw new Error(`“${namePart}”有多个同名区县，请补充上级城市，例如“${namePart},${parents[0] || '城市名'}”。`);
  }
  return top;
}

async function photonSearch(query, fetcher) {
  const params = new URLSearchParams({ q: query.replace(/[,，]/g, ' '), limit: '10' });
  const url = `https://photon.komoot.io/api/?${params}`;
  const job = photonQueue.then(async () => {
    const delay = 1000 - (Date.now() - lastPhotonRequest);
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    lastPhotonRequest = Date.now();
    return getJson(url, fetcher, {
      headers: { 'User-Agent': 'Yunzai-Weather-Plugin/1.1 (https://github.com/yuxiri/Yunzai-Weather-Plugin)' },
    });
  });
  photonQueue = job.catch(() => {});
  return job;
}

async function timezoneAt(latitude, longitude, countryCode, fetcher) {
  const fixedZones = { CN: 'Asia/Shanghai', HK: 'Asia/Hong_Kong', MO: 'Asia/Macau', TW: 'Asia/Taipei' };
  if (fixedZones[countryCode]) return fixedZones[countryCode];
  const params = new URLSearchParams({
    latitude: String(latitude), longitude: String(longitude), current: 'temperature_2m',
    timezone: 'auto', forecast_days: '1',
  });
  const data = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`, fetcher);
  if (!data.timezone) throw new Error('无法确定该区县的当地时区');
  return data.timezone;
}

export async function getJson(url, fetcher = fetch, options = {}) {
  let response;
  try {
    response = await fetcher(url, { ...options, signal: AbortSignal.timeout(12000) });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' ? '天气接口请求超时，请稍后重试' : '连接天气接口失败，请检查网络后重试');
  }
  if (!response.ok) throw new Error(`天气接口返回 HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || data.reason || '天气接口返回错误');
  return data;
}

export async function resolveCity(input, fetcher = fetch) {
  const raw = String(input || '').trim().replace(/，/g, ',');
  if (!raw || raw.length > 80) throw new Error('请输入有效的城市或区县名');
  const commaParts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const [namePart, ...locationParts] = commaParts;
  const parentHints = locationParts.flatMap(part => part.split(/\s+/).filter(Boolean));
  const countryPart = locationParts[0] || '';
  const alias = ALIASES.get(namePart);
  const name = alias?.[0] || namePart;
  const countryCode = /^[A-Za-z]{2}$/.test(countryPart || '') ? countryPart.toUpperCase() : alias?.[1];
  const cacheKey = normalizedPlace(raw);
  const cached = await cachedLocation(cacheKey);
  if (cached) return cached;
  const params = new URLSearchParams({ name, count: '10', language: 'zh', format: 'json' });
  if (countryCode) params.set('countryCode', countryCode);
  else if (commaParts.length > 1) params.set('name', `${name}, ${locationParts.join(' ')}`);
  let openMeteoError = null;
  try {
    const data = await getJson(`https://geocoding-api.open-meteo.com/v1/search?${params}`, fetcher);
    const results = data.results || [];
    if (results.length) {
      const maxPopulation = Math.max(...results.map(item => Number(item.population) || 0));
      const strongExact = item => normalizedPlace(item.name) === normalizedPlace(name)
        && ((Number(item.population) || 0) >= maxPopulation * 0.05 || /^PPLA/.test(item.feature_code || ''));
      const best = [...results].sort((a, b) => {
        const parentScore = item => parentHints.filter(hint =>
          [item.admin1, item.admin2, item.admin3, item.country]
            .some(value => normalizedPlace(value).includes(normalizedPlace(hint)))
        ).length;
        return parentScore(b) - parentScore(a) || Number(strongExact(b)) - Number(strongExact(a))
          || (b.population || 0) - (a.population || 0);
      })[0];
      const location = {
        name: alias || /^[\x00-\x7F]+$/.test(namePart) ? namePart : best.name,
        country: best.country || '', countryCode: best.country_code || '',
        latitude: best.latitude, longitude: best.longitude, timezone: best.timezone, geocoder: 'open-meteo',
      };
      await cacheLocation(cacheKey, location);
      return location;
    }
  } catch (error) { openMeteoError = error; }

  try {
    const data = await photonSearch(raw, fetcher);
    const match = selectPhotonFeature(data.features, raw, namePart, parentHints, countryCode);
    if (!match) throw new Error(`未找到“${raw}”，请补充区县所属城市或省份，例如“渝中区,重庆”。`);
    const [longitude, latitude] = match.coordinates.map(Number);
    const resultCountryCode = String(match.properties.countrycode || countryCode || '').toUpperCase();
    const location = {
      name: photonLocationName(match.properties, namePart),
      country: match.properties.country || '', countryCode: resultCountryCode,
      latitude, longitude, timezone: await timezoneAt(latitude, longitude, resultCountryCode, fetcher),
      geocoder: 'photon',
    };
    await cacheLocation(cacheKey, location);
    return location;
  } catch (error) {
    if (/多个同名区县/.test(error.message)) throw error;
    if (/未找到/.test(error.message)) throw error;
    const detail = openMeteoError ? `Open-Meteo：${openMeteoError.message}；` : '';
    throw new Error(`${detail}区县地理编码暂不可用，请稍后重试。`);
  }
}

const condition = code => {
  if (code === 0) return ['晴', 'sun'];
  if (code <= 2) return ['晴间多云', 'partly'];
  if (code === 3) return ['阴', 'cloudy'];
  if (code <= 48) return ['有雾', 'cloudy'];
  if (code <= 67) return ['有雨', 'rainy'];
  if (code <= 77) return ['有雪', 'cloudy'];
  if (code <= 82) return ['阵雨', 'rainy'];
  return ['雷雨', 'rainy'];
};
const r = n => n == null || n === '' ? null : Number.isFinite(Number(n)) ? Math.round(Number(n)) : null;
const hm = s => String(s || '').slice(11, 16);
const minutes = s => Number(String(s).slice(11, 13)) * 60 + Number(String(s).slice(14, 16));
const weekday = date => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${date}T12:00:00Z`).getUTCDay()];
const aqiLabel = n => n == null ? '未提供' : n <= 50 ? '优' : n <= 100 ? '良' : n <= 150 ? '敏感人群注意' : n <= 200 ? '不健康' : n <= 300 ? '非常不健康' : '危险';
const uvLabel = n => n == null ? '未提供' : n < 3 ? '低' : n < 6 ? '中等' : n < 8 ? '高' : n < 11 ? '很高' : '极高';
const visibilityLabel = n => n >= 10 ? '良好' : n >= 5 ? '一般' : n >= 1 ? '较差' : '很差';
const windLevel = n => n < 6 ? 1 : n < 12 ? 2 : n < 20 ? 3 : n < 29 ? 4 : n < 39 ? 5 : 6;
const isSnowCode = code => [71, 73, 75, 77, 85, 86].includes(Number(code));
const isRainCode = code => [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(Number(code));

function generatedLifeIndices({ high, low, uv, rain, snow, condition: weatherText }) {
  const indices = [];
  if ((rain ?? 0) >= 50 || /雨|雷/.test(weatherText || '')) indices.push({ name: '出行', detail: '降雨概率较高，建议携带雨具。' });
  else if ((snow ?? 0) >= 30 || /雪/.test(weatherText || '')) indices.push({ name: '出行', detail: '可能降雪，留意道路湿滑和交通变化。' });
  else indices.push({ name: '出行', detail: '降水风险较低，适合正常出行。' });
  if (low != null && low <= 5) indices.push({ name: '穿衣', detail: '气温偏低，建议穿保暖外套。' });
  else if (high != null && high >= 30) indices.push({ name: '穿衣', detail: '天气偏热，建议穿轻薄透气衣物。' });
  else indices.push({ name: '穿衣', detail: '建议按早晚温差采用分层穿搭。' });
  indices.push({ name: '紫外线', detail: uv == null ? '紫外线数据暂缺。' : uv >= 6 ? '紫外线较强，外出注意防晒。' : uv >= 3 ? '紫外线中等，可适当防晒。' : '紫外线较弱。' });
  indices.push({ name: '户外活动', detail: /雷|暴雨|大雪|暴雪/.test(weatherText || '') ? '天气不稳定，建议减少长时间户外活动。' : '可安排日常户外活动，留意天气变化。' });
  return indices;
}

function makeOpenMeteoHour(h, index) {
  const code = h.weather_code[index];
  const [label, icon] = condition(code);
  const precipitation = r(h.precipitation_probability?.[index]);
  const snow = isSnowCode(code) || Number(h.snowfall?.[index]) > 0;
  return {
    time: hm(h.time[index]), temp: r(h.temperature_2m[index]), condition: label, icon,
    rainProbability: snow ? 0 : precipitation,
    snowProbability: snow ? precipitation : 0,
    rainAmount: r(h.rain?.[index]), snowAmount: r(h.snowfall?.[index]),
    rain: precipitation ?? 0,
  };
}

export function formatWeather(location, forecast, air = {}) {
  const c = forecast.current, d = forecast.daily, h = forecast.hourly;
  if (!c?.time || !d?.time?.length || !h?.time?.length) throw new Error('天气数据不完整');
  const today = d.time.indexOf(c.time.slice(0, 10));
  if (today < 0) throw new Error('天气日期不匹配');
  const [label, dayIcon] = condition(c.weather_code);
  const nowMinutes = minutes(c.time), sunriseMinutes = minutes(d.sunrise[today]), sunsetMinutes = minutes(d.sunset[today]);
  const night = nowMinutes < sunriseMinutes || nowMinutes > sunsetMinutes;
  const icon = night && dayIcon === 'sun' ? 'moon' : night && dayIcon === 'partly' ? 'night' : dayIcon;
  const first = h.time.findIndex(s => s.slice(0, 10) === c.time.slice(0, 10) && minutes(s) >= nowMinutes - 15);
  if (first < 0) throw new Error('逐小时天气数据不完整');
  const aqi = air.current?.us_aqi ?? null;
  const visibility = c.visibility == null ? null : r(c.visibility / 1000);
  const uv = d.uv_index_max[today] == null ? null : r(d.uv_index_max[today]);
  const duration = sunsetMinutes - sunriseMinutes;
  const hourly24 = h.time.slice(first, first + 24).map((_, i) => makeOpenMeteoHour(h, first + i));
  const days = d.time.slice(today, today + 7).map((date, i) => {
    const code = d.weather_code[today + i];
    const [dayCondition, dayIcon] = condition(code);
    const precipitation = r(d.precipitation_probability_max?.[today + i]);
    const snow = isSnowCode(code) || Number(d.snowfall_sum?.[today + i]) > 0;
    return {
      name: i === 0 ? '今天' : `${weekday(date)} ${Number(date.slice(8))}`,
      icon: dayIcon, condition: dayCondition,
      high: r(d.temperature_2m_max[today + i]), low: r(d.temperature_2m_min[today + i]),
      rainProbability: snow ? 0 : precipitation, snowProbability: snow ? precipitation : 0,
      rainAmount: r(d.rain_sum?.[today + i]), snowAmount: r(d.snowfall_sum?.[today + i]),
      uv: r(d.uv_index_max?.[today + i]),
    };
  });
  const todayData = days[0];
  return {
    city: `${location.name} ${hm(c.time)}`,
    updated: `当地时间 ${c.time.replace('T', ' ')} 更新`,
    temperature: r(c.temperature_2m), condition: label, icon,
    high: todayData.high, low: todayData.low,
    days,
    hourly24,
    hourly: hourly24.filter((_, i) => i % 3 === 0).slice(0, 8),
    visibility: visibility ?? '—', visibilityNote: visibility == null ? '未提供' : visibilityLabel(visibility),
    pressure: r(c.pressure_msl) ?? '—', pressureNote: '当前气压',
    aqi: aqi == null ? '—' : r(aqi), aqiNote: aqiLabel(aqi),
    uv: uv ?? '—', uvNote: uvLabel(uv),
    wind: r(c.wind_speed_10m) ?? '—', gust: r(c.wind_gusts_10m) ?? '—',
    windDirection: r(c.wind_direction_10m) ?? 0, windNote: c.wind_speed_10m == null ? '风力未知' : `风力: ${windLevel(c.wind_speed_10m)}级`,
    humidity: r(c.relative_humidity_2m) ?? '—', dewPoint: r(c.dew_point_2m) ?? '—',
    humidityNote: c.relative_humidity_2m == null ? '未提供' : c.relative_humidity_2m >= 70 ? '潮湿' : c.relative_humidity_2m >= 40 ? '适中' : '干燥',
    daylight: `${Math.floor(duration / 60)}小时 ${duration % 60}分钟`,
    sunrise: hm(d.sunrise[today]), sunset: hm(d.sunset[today]),
    lifeIndices: generatedLifeIndices({ high: todayData.high, low: todayData.low, uv, rain: todayData.rainProbability, snow: todayData.snowProbability, condition: todayData.condition }),
    sourceNote: `数据来源：Open-Meteo · ${location.name}当地时间 ${c.time.replace('T', ' ')} 的天气快照。`,
  };
}

const WEATHER_API_RAIN = new Set([1063, 1069, 1072, 1087, 1150, 1153, 1168, 1171, 1180, 1183, 1186, 1189, 1192, 1195, 1198, 1201, 1204, 1207, 1237, 1240, 1243, 1246, 1249, 1252, 1261, 1264, 1273, 1276, 1279, 1282]);
const WEATHER_API_SNOW = new Set([1066, 1069, 1114, 1117, 1210, 1213, 1216, 1219, 1222, 1225, 1237, 1255, 1258]);

function weatherApiIcon(code, isDay = true) {
  if (code === 1000) return isDay ? 'sun' : 'moon';
  if (code === 1003) return isDay ? 'partly' : 'night';
  if (WEATHER_API_RAIN.has(Number(code))) return 'rainy';
  if (WEATHER_API_SNOW.has(Number(code))) return 'cloudy';
  return 'cloudy';
}

function weatherApiTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return String(value || '—');
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'PM') hour += 12;
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

function weatherApiTimeMinutes(value) {
  const normalized = weatherApiTime(value);
  const [hour, minute] = normalized.split(':').map(Number);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
}

const localTimestamp = value => Date.parse(`${String(value || '').replace(' ', 'T')}Z`);

function weatherApiAqiLabel(value) {
  return ({ 1: '优', 2: '良', 3: '对敏感人群不健康', 4: '不健康', 5: '非常不健康', 6: '危险' })[Number(value)] || '未提供';
}

export function formatWeatherApi(location, forecast) {
  const current = forecast.current;
  const days = forecast.forecast?.forecastday || [];
  const localtime = forecast.location?.localtime || current?.last_updated;
  if (!current || !days.length || !localtime) throw new Error('WeatherAPI 返回的天气数据不完整');
  const date = localtime.slice(0, 10);
  const today = days.find(day => day.date === date) || days[0];
  const dayForecast = today.day || {};
  const dayNumber = Number(today.date.slice(8));
  const name = today.date === date ? '今天' : `${weekday(today.date)} ${dayNumber}`;
  const currentCode = current.condition?.code;
  const currentIcon = weatherApiIcon(currentCode, current.is_day !== 0);
  const hourRows = days.flatMap(day => day.hour || []);
  const currentTime = current.last_updated || localtime;
  const currentStamp = localTimestamp(currentTime);
  const start = hourRows.findIndex(hour => localTimestamp(hour.time) >= currentStamp - 15 * 60000);
  if (start < 0) throw new Error('WeatherAPI 没有返回可用的逐小时天气');

  const sunrise = weatherApiTime(today.astro?.sunrise);
  const sunset = weatherApiTime(today.astro?.sunset);
  const sunriseMinute = weatherApiTimeMinutes(today.astro?.sunrise);
  const sunsetMinute = weatherApiTimeMinutes(today.astro?.sunset);
  const daylightMinutes = sunriseMinute == null || sunsetMinute == null
    ? null : (sunsetMinute - sunriseMinute + 1440) % 1440;
  const aqiRaw = current.air_quality?.['us-epa-index'];
  const aqi = r(aqiRaw);
  const high = r(dayForecast.maxtemp_c), low = r(dayForecast.mintemp_c);
  const visibility = r(current.vis_km);
  const humidity = r(current.humidity);
  const wind = r(current.wind_kph);
  const hourly24 = hourRows.slice(start, start + 24).map(hour => {
    const conditionText = hour.condition?.text || '天气状况未知';
    const rainProbability = r(hour.chance_of_rain);
    const snowProbability = r(hour.chance_of_snow);
    return {
      time: hour.time.slice(11, 16), temp: r(hour.temp_c), condition: conditionText,
      icon: weatherApiIcon(hour.condition?.code),
      rainProbability, snowProbability,
      rainAmount: r(hour.precip_mm), snowAmount: r(hour.snow_cm),
      rain: Math.max(rainProbability || 0, snowProbability || 0),
    };
  });
  const normalizedDays = days.map((item, index) => {
    const day = item.day || {};
    const rainProbability = r(day.daily_chance_of_rain);
    const snowProbability = r(day.daily_chance_of_snow);
    return {
      name: index === 0 ? (item.date === date ? '今天' : name) : `${weekday(item.date)} ${Number(item.date.slice(8))}`,
      icon: weatherApiIcon(day.condition?.code), condition: day.condition?.text || '天气状况未知',
      high: r(day.maxtemp_c), low: r(day.mintemp_c), rainProbability, snowProbability,
      rainAmount: r(day.totalprecip_mm), snowAmount: r(day.totalsnow_cm), uv: r(day.uv),
    };
  });
  const todayData = normalizedDays.find(item => item.name === '今天') || normalizedDays[0];

  return {
    city: `${location.name} ${localtime.slice(11, 16)}`,
    updated: `当地时间 ${localtime} 更新`,
    temperature: r(current.temp_c),
    condition: current.condition?.text || '天气状况未知',
    icon: currentIcon,
    high: todayData?.high ?? high, low: todayData?.low ?? low,
    days: normalizedDays,
    hourly24,
    hourly: hourly24.filter((_, index) => index % 3 === 0).slice(0, 8),
    visibility: visibility ?? '—', visibilityNote: visibility == null ? '未提供' : visibilityLabel(visibility),
    pressure: r(current.pressure_mb) ?? '—', pressureNote: '当前气压',
    aqi: aqi ?? '—', aqiNote: weatherApiAqiLabel(aqi),
    uv: r(dayForecast.uv) ?? '—', uvNote: uvLabel(r(dayForecast.uv)),
    wind: wind ?? '—', gust: r(current.gust_kph) ?? '—',
    windDirection: r(current.wind_degree) ?? 0, windNote: wind == null ? '风力未知' : `风力: ${windLevel(wind)}级`,
    humidity: humidity ?? '—', dewPoint: r(current.dewpoint_c) ?? '—',
    humidityNote: humidity == null ? '未提供' : humidity >= 70 ? '潮湿' : humidity >= 40 ? '适中' : '干燥',
    daylight: daylightMinutes == null ? '—' : `${Math.floor(daylightMinutes / 60)}小时 ${daylightMinutes % 60}分钟`,
    sunrise, sunset,
    lifeIndices: generatedLifeIndices({ high, low, uv: r(dayForecast.uv), rain: todayData?.rainProbability, snow: todayData?.snowProbability, condition: todayData?.condition }),
    sourceNote: `数据来源：WeatherAPI.com · ${location.name}当地时间 ${localtime} 的天气快照。`,
  };
}

async function getText(url, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(url, {
      signal: AbortSignal.timeout(12000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' ? 'Bing/MSN 天气请求超时，请稍后重试' : '无法连接 Bing/MSN 天气，请检查网络后重试');
  }
  if (!response.ok) throw new Error(`Bing/MSN 天气页面返回 HTTP ${response.status}`);
  return response.text();
}

function bingSearchResultUrl(html) {
  for (const match of html.matchAll(/href=(['"])(.*?)\1/gi)) {
    const href = match[2]
      .replaceAll('\\/', '/')
      .replaceAll('&amp;', '&')
      .replaceAll('&#x3D;', '=')
      .replaceAll('&#39;', "'");
    try {
      const url = new URL(href);
      if (/^www\.msn\.(?:cn|com)$/i.test(url.hostname)
        && /^\/zh-cn\/weather\/forecast\/in-/i.test(url.pathname)) return url;
    } catch {}
  }
  return null;
}

async function msnForecastUrl(location, fetcher) {
  const term = `${location.name}${location.country ? ` ${location.country}` : ''} 天气`;
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(term)}&setlang=zh-CN&cc=CN&mkt=zh-CN`;
  let pageUrl;
  try {
    const bingHtml = await getText(searchUrl, fetcher);
    pageUrl = bingSearchResultUrl(bingHtml);
  } catch {
    // Some networks block Bing search HTML; the coordinate-specific MSN page remains usable.
  }
  if (!pageUrl) pageUrl = new URL(`https://www.msn.cn/zh-cn/weather/forecast/in-${location.latitude},${location.longitude}`);

  // MSN may otherwise use the server's detected location instead of the city requested by the user.
  const loc = Buffer.from(JSON.stringify({ x: String(location.longitude), y: String(location.latitude) })).toString('base64');
  pageUrl.hostname = 'www.msn.cn';
  pageUrl.searchParams.set('loc', loc);
  pageUrl.searchParams.set('weadegreetype', 'C');
  return pageUrl;
}

const msnNumber = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const match = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
};

function msnIcon(symbol, description = '') {
  const text = String(description);
  if (/(雨|雷|阵雨|暴雨)/.test(text)) return 'rainy';
  if (/(雪|冰雹)/.test(text)) return 'cloudy';
  const code = String(symbol || '').replace(/^[dn]/i, '');
  if (/^(?:4[1-9]|5\d|6\d|8\d|9\d)/.test(code)) return 'rainy';
  if (/^0+/.test(code)) return String(symbol || '').startsWith('n') ? 'moon' : 'sun';
  if (/^[12]/.test(code)) return String(symbol || '').startsWith('n') ? 'night' : 'partly';
  if (/^[34]/.test(code)) return 'cloudy';
  if (/(晴)/.test(text)) return String(symbol || '').startsWith('n') ? 'moon' : 'sun';
  if (/(多云|阴|云)/.test(text)) return 'cloudy';
  return 'cloudy';
}

function msnDayDate(day) {
  const value = day.almanac?.valid || day.almanac?.sunrise || day.validTime?.dataValue || day.day?.dataValue;
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

function msnAqiLabel(value, severity) {
  if (severity) return String(severity).replace(/^空气/, '');
  const aqi = msnNumber(value);
  return aqi == null ? '未提供' : aqi <= 50 ? '优' : aqi <= 100 ? '良' : aqi <= 150 ? '轻度污染' : aqi <= 200 ? '中度污染' : aqi <= 300 ? '重度污染' : '严重污染';
}

export function formatBingWeather(location, weather) {
  const raw = weather?.currentCondition?.currentRaw;
  const current = weather?.currentCondition;
  const forecasts = weather?.forecast;
  const created = raw?.created;
  if (!raw || !current || !Array.isArray(forecasts) || !forecasts.length || !created) {
    throw new Error('MSN 天气页面没有返回完整的天气数据');
  }

  const date = created.slice(0, 10);
  const localTimestamp = created.replace('T', ' ').replace(/[+-]\d{2}:?\d{2}$/, '');
  const today = Math.max(0, forecasts.findIndex(day => msnDayDate(day) === date));
  const todayForecast = forecasts[today];
  const sunrise = todayForecast?.almanac?.sunrise || '';
  const sunset = todayForecast?.almanac?.sunset || '';
  const daylightMinutes = sunrise && sunset
    ? (minutes(sunset) - minutes(sunrise) + 1440) % 1440
    : null;
  const localTime = created.match(/T(\d{2}:\d{2})/)?.[1] || '—';
  const currentTime = Date.parse(created);
  const allHours = forecasts.flatMap(day => day.hourly || [])
    .filter(hour => hour.timeStr && Number.isFinite(msnNumber(hour.temperature)))
    .sort((a, b) => Date.parse(a.timeStr) - Date.parse(b.timeStr));
  const hours = [...new Map(allHours.map(hour => [hour.timeStr, hour])).values()];
  const firstHour = hours.findIndex(hour => !Number.isFinite(currentTime) || Date.parse(hour.timeStr) >= currentTime - 15 * 60000);
  const hourly = Array.from({ length: 8 }, (_, index) => hours[firstHour + index * 3])
    .filter(Boolean)
    .map(hour => ({
      time: hour.timeStr.slice(11, 16),
      temp: r(msnNumber(hour.temperature)),
      rain: r(msnNumber(hour.precipitation)),
    }));
  if (!hourly.length) throw new Error('MSN 天气页面没有返回可用的逐小时预报');
  const hourly24 = hours.slice(firstHour, firstHour + 24).map(hour => {
    const conditionText = hour.cap || '天气状况未知';
    const precipitation = r(msnNumber(hour.precipitation));
    const rainAmount = r(msnNumber(hour.rainAmount));
    const snowAmount = r(msnNumber(hour.snowAmount));
    const snow = /雪/.test(conditionText) || (snowAmount != null && snowAmount > 0);
    return {
      time: hour.timeStr.slice(11, 16), temp: r(msnNumber(hour.temperature)),
      condition: conditionText, icon: msnIcon(hour.symbol, conditionText),
      rainProbability: snow ? 0 : precipitation, snowProbability: snow ? precipitation : 0,
      rainAmount, snowAmount, rain: precipitation ?? 0,
    };
  });

  const humidity = r(msnNumber(raw.rh ?? current.humidity));
  const visibility = r(msnNumber(raw.vis ?? current.visiblity));
  const aqi = r(msnNumber(raw.aqi ?? current.aqi));
  const wind = r(msnNumber(raw.windSpd ?? current.windSpeedNumber));
  const gust = r(msnNumber(raw.windGust ?? current.windGustNumber));
  const uv = r(msnNumber(raw.uv ?? current.uv));
  const pressure = r(msnNumber(raw.baro ?? current.baro));
  const conditionText = raw.cap || current.shortCap || '天气状况未知';
  const days = forecasts.slice(today, today + 7).map((day, index) => {
    const description = day.dayCap || day.cap || '天气状况未知';
    const precipitation = r(msnNumber(day.precipitation));
    const snowAmount = r(msnNumber(day.snowAmount));
    const snow = /雪/.test(description) || (snowAmount != null && snowAmount > 0);
    const dayDate = msnDayDate(day);
    return {
      name: index === 0 ? '今天' : dayDate ? `${weekday(dayDate)} ${Number(dayDate.slice(8))}` : `第${index + 1}天`,
      icon: msnIcon(day.daySymbol || day.symbol, description), condition: description,
      high: r(msnNumber(day.highTemp)), low: r(msnNumber(day.lowTemp)),
      rainProbability: snow ? 0 : precipitation, snowProbability: snow ? precipitation : 0,
      rainAmount: r(msnNumber(day.rainAmount)), snowAmount, uv: r(msnNumber(day.uv)),
    };
  });
  const todayData = days[0];
  const lifeTypeNames = new Map(['1:1:穿衣指数', '1:3:风寒指数', '1:4:高温指数', '2:10:雨伞指数', '3:26:户外活动'].map(value => {
    const [type, subtype, ...name] = value.split(':');
    return [`${type}:${subtype}`, name.join(':')];
  }));
  const msnLife = (weather.lifeActivityData?.days?.[today]?.lifeDailyIndices || [])
    .map(item => ({
      name: lifeTypeNames.get(`${item.type}:${item.subType}`) || '生活提示',
      detail: item.shortSummary || item.taskbarSummary || item.summary || '',
    }))
    .filter(item => item.detail)
    .slice(0, 5);
  const lifeIndices = msnLife.length ? msnLife : generatedLifeIndices({
    high: todayData?.high, low: todayData?.low, uv, rain: todayData?.rainProbability,
    snow: todayData?.snowProbability, condition: todayData?.condition,
  });

  return {
    city: `${location.name} ${localTime}`,
    updated: `当地时间 ${localTimestamp} 更新`,
    temperature: r(msnNumber(raw.temp ?? current.currentTemperature)),
    condition: conditionText,
    icon: msnIcon(raw.symbol || current.symbol, conditionText),
    high: todayData?.high ?? r(msnNumber(todayForecast.highTemp)),
    low: todayData?.low ?? r(msnNumber(todayForecast.lowTemp)),
    days, hourly24, hourly,
    visibility: visibility ?? '—',
    visibilityNote: visibility == null ? '未提供' : visibilityLabel(visibility),
    pressure: pressure ?? '—', pressureNote: '当前气压',
    aqi: aqi ?? '—', aqiNote: msnAqiLabel(raw.aqi ?? current.aqi, current.aqiSeverity),
    uv: uv ?? '—', uvNote: uvLabel(uv),
    wind: wind ?? '—', gust: gust ?? '—',
    windDirection: r(msnNumber(raw.windDir ?? current.windDir)) ?? 0,
    windNote: current.windDesc || raw.pvdrWindSpd || (wind == null ? '风力未知' : `风速 ${wind} 公里/小时`),
    humidity: humidity ?? '—', dewPoint: r(msnNumber(raw.dewPt ?? current.dewPoint)) ?? '—',
    humidityNote: humidity == null ? '未提供' : humidity >= 70 ? '潮湿' : humidity >= 40 ? '适中' : '干燥',
    daylight: daylightMinutes == null ? '—' : `${Math.floor(daylightMinutes / 60)}小时 ${daylightMinutes % 60}分钟`,
    sunrise: sunrise.slice(11, 16) || '—', sunset: sunset.slice(11, 16) || '—',
    lifeIndices,
    sourceNote: `数据来源：Bing 天气（MSN 天气预报）· ${location.name}当地时间 ${localTimestamp} 的天气快照。`,
  };
}

async function getBingWeather(location, fetcher) {
  const url = await msnForecastUrl(location, fetcher);
  const html = await getText(url, fetcher);
  const match = html.match(/<script id="redux-data" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('MSN 天气页面未提供可读取的预报数据');
  let payload;
  try { payload = JSON.parse(match[1]); }
  catch { throw new Error('无法解析 MSN 天气页面的数据'); }
  return formatBingWeather(location, payload?.WeatherData?.['_@STATE@_']);
}

function addGeocoderCredit(location, weather) {
  if (location.geocoder === 'photon') {
    weather.sourceNote += ' · 地点解析：Photon / © OpenStreetMap contributors';
  }
  return weather;
}

export async function getWeather(location, fetcher = fetch, settings = {}) {
  const source = settings.source || 'bing';
  if (source === 'bing') return addGeocoderCredit(location, await getBingWeather(location, fetcher));
  if (source === 'weatherapi') {
    const apiKey = String(settings.weatherApiKey || '').trim();
    if (!apiKey) throw new Error('尚未配置 WeatherAPI 密钥；请先配置后发送 #切换天气源 WeatherAPI。');
    const params = new URLSearchParams({
      key: apiKey,
      q: `${location.latitude},${location.longitude}`,
      days: '3', aqi: 'yes', alerts: 'no', lang: 'zh',
    });
    const forecast = await getJson(`https://api.weatherapi.com/v1/forecast.json?${params}`, fetcher);
    return addGeocoderCredit(location, formatWeatherApi(location, forecast));
  }
  if (source !== 'open-meteo') throw new Error(`未知天气数据源：${source}`);

  const params = new URLSearchParams({
    latitude: String(location.latitude), longitude: String(location.longitude), timezone: location.timezone,
    current: 'temperature_2m,relative_humidity_2m,dew_point_2m,weather_code,pressure_msl,wind_speed_10m,wind_gusts_10m,wind_direction_10m,visibility',
    hourly: 'temperature_2m,precipitation_probability,precipitation,rain,snowfall,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,rain_sum,snowfall_sum,sunrise,sunset,uv_index_max', forecast_days: '7',
  });
  const airParams = new URLSearchParams({ latitude: String(location.latitude), longitude: String(location.longitude), timezone: location.timezone, current: 'us_aqi' });
  const [forecast, air] = await Promise.all([
    getJson(`https://api.open-meteo.com/v1/forecast?${params}`, fetcher),
    getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?${airParams}`, fetcher).catch(() => ({})),
  ]);
  return addGeocoderCredit(location, formatWeather(location, forecast, air));
}

export function localDateTime(timezone, date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
