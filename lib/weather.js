const ALIASES = new Map([
  ['北京', ['Beijing', 'CN']], ['北京市', ['Beijing', 'CN']],
  ['东京', ['Tokyo', 'JP']], ['东京都', ['Tokyo', 'JP']],
  ['洛杉矶', ['Los Angeles', 'US']], ['洛杉磯', ['Los Angeles', 'US']],
]);

export async function getJson(url, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(12000) });
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
  if (!raw || raw.length > 80) throw new Error('请输入有效的城市名');
  const [namePart, countryPart] = raw.split(',').map(s => s.trim());
  const alias = ALIASES.get(namePart);
  const name = alias?.[0] || namePart;
  const countryCode = /^[A-Za-z]{2}$/.test(countryPart || '') ? countryPart.toUpperCase() : alias?.[1];
  const params = new URLSearchParams({ name, count: '10', language: 'zh', format: 'json' });
  if (countryCode) params.set('countryCode', countryCode);
  else if (countryPart) params.set('name', `${name}, ${countryPart}`);
  const data = await getJson(`https://geocoding-api.open-meteo.com/v1/search?${params}`, fetcher);
  const results = data.results || [];
  if (!results.length) throw new Error(`未找到“${raw}”，可试试“城市,国家代码”，例如“东京,JP”`);
  const best = [...results].sort((a, b) => (b.population || 0) - (a.population || 0))[0];
  return {
    name: alias ? namePart : best.name,
    country: best.country || '', countryCode: best.country_code || '',
    latitude: best.latitude, longitude: best.longitude, timezone: best.timezone,
  };
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
  return {
    city: `${location.name} ${hm(c.time)}`,
    updated: `当地时间 ${c.time.replace('T', ' ')} 更新`,
    temperature: r(c.temperature_2m), condition: label, icon,
    high: r(d.temperature_2m_max[today]), low: r(d.temperature_2m_min[today]),
    days: d.time.slice(today, today + 7).map((date, i) => ({
      name: i === 0 ? '今天' : `${weekday(date)} ${Number(date.slice(8))}`,
      icon: condition(d.weather_code[today + i])[1],
      high: r(d.temperature_2m_max[today + i]), low: r(d.temperature_2m_min[today + i]),
    })),
    hourly: Array.from({ length: 8 }, (_, j) => first + j * 3).filter(i => i < h.time.length).map(i => ({
      time: hm(h.time[i]), temp: r(h.temperature_2m[i]), rain: r(h.precipitation_probability[i]) ?? 0,
    })),
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

  return {
    city: `${location.name} ${localtime.slice(11, 16)}`,
    updated: `当地时间 ${localtime} 更新`,
    temperature: r(current.temp_c),
    condition: current.condition?.text || '天气状况未知',
    icon: currentIcon,
    high, low,
    days: days.map((item, index) => ({
      name: index === 0 ? (item.date === date ? '今天' : name) : `${weekday(item.date)} ${Number(item.date.slice(8))}`,
      icon: weatherApiIcon(item.day?.condition?.code),
      high: r(item.day?.maxtemp_c), low: r(item.day?.mintemp_c),
    })),
    hourly: Array.from({ length: 8 }, (_, index) => hourRows[start + index * 3]).filter(Boolean).map(hour => ({
      time: hour.time.slice(11, 16), temp: r(hour.temp_c),
      rain: r(Math.max(Number(hour.chance_of_rain) || 0, Number(hour.chance_of_snow) || 0)) ?? 0,
    })),
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
    sourceNote: `数据来源：WeatherAPI.com · ${location.name}当地时间 ${localtime} 的天气快照。`,
  };
}

export async function getWeather(location, fetcher = fetch, settings = {}) {
  const source = settings.source || 'open-meteo';
  if (source === 'weatherapi') {
    const apiKey = String(settings.weatherApiKey || '').trim();
    if (!apiKey) throw new Error('尚未配置 WeatherAPI 密钥；请先配置后发送 #切换天气源 WeatherAPI。');
    const params = new URLSearchParams({
      key: apiKey,
      q: `${location.latitude},${location.longitude}`,
      days: '3', aqi: 'yes', alerts: 'no', lang: 'zh',
    });
    const forecast = await getJson(`https://api.weatherapi.com/v1/forecast.json?${params}`, fetcher);
    return formatWeatherApi(location, forecast);
  }
  if (source !== 'open-meteo') throw new Error(`未知天气数据源：${source}`);

  const params = new URLSearchParams({
    latitude: String(location.latitude), longitude: String(location.longitude), timezone: location.timezone,
    current: 'temperature_2m,relative_humidity_2m,dew_point_2m,weather_code,pressure_msl,wind_speed_10m,wind_gusts_10m,wind_direction_10m,visibility',
    hourly: 'temperature_2m,precipitation_probability,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max', forecast_days: '7',
  });
  const airParams = new URLSearchParams({ latitude: String(location.latitude), longitude: String(location.longitude), timezone: location.timezone, current: 'us_aqi' });
  const [forecast, air] = await Promise.all([
    getJson(`https://api.open-meteo.com/v1/forecast?${params}`, fetcher),
    getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?${airParams}`, fetcher).catch(() => ({})),
  ]);
  return formatWeather(location, forecast, air);
}

export function localDateTime(timezone, date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

