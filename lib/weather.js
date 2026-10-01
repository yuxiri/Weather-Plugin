const ALIASES = new Map([
  ['北京', ['Beijing', 'CN']], ['北京市', ['Beijing', 'CN']],
  ['东京', ['Tokyo', 'JP']], ['东京都', ['Tokyo', 'JP']],
  ['洛杉矶', ['Los Angeles', 'US']], ['洛杉磯', ['Los Angeles', 'US']],
]);

export async function getJson(url, fetcher = fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`天气接口返回 HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.reason || '天气接口返回错误');
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
const hm = s => s.slice(11, 16);
const minutes = s => Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16));
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

export async function getWeather(location, fetcher = fetch) {
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
