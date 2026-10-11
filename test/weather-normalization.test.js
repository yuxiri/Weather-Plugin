import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatBingWeather, formatWeather, formatWeatherApi, getWeather } from '../lib/weather.js';
import { precipitationReminderView, weatherView } from '../lib/view.js';
import { classifyPrecipitation } from '../lib/precipitation.js';

const location = { name: '测试市', latitude: 31, longitude: 121, timezone: 'Asia/Shanghai' };

function openMeteoFixture() {
  const hours = Array.from({ length: 30 }, (_, index) => {
    const absoluteHour = 8 + index;
    const date = absoluteHour < 24 ? '2026-10-10' : '2026-10-11';
    const hour = String(absoluteHour % 24).padStart(2, '0');
    return `${date}T${hour}:00`;
  });
  const d = {
    time: ['2026-10-10', '2026-10-11'],
    weather_code: [85, 999],
    temperature_2m_max: [18, 20], temperature_2m_min: [9, 11],
    precipitation_probability_max: [0, null], precipitation_sum: [0.6, null], rain_sum: [0.4, null], snowfall_sum: [0.2, null],
    sunrise: ['2026-10-10T06:00', '2026-10-11T06:01'], sunset: ['2026-10-10T18:00', '2026-10-11T17:59'],
    uv_index_max: [2, null],
  };
  return {
    timezone: 'Asia/Shanghai',
    current: {
      time: '2026-10-10T08:00', temperature_2m: 12, relative_humidity_2m: 65, dew_point_2m: null,
      weather_code: 85, pressure_msl: 1012, wind_speed_10m: 0, wind_gusts_10m: null,
      wind_direction_10m: null, visibility: 8000,
    },
    daily: d,
    hourly: {
      time: hours,
      temperature_2m: hours.map((_, index) => 12 + index % 2),
      precipitation_probability: [0, null, ...Array(28).fill(10)],
      precipitation: [0.6, null, ...Array(28).fill(0)], rain: [0.4, null, ...Array(28).fill(0)],
      snowfall: [0.2, null, ...Array(28).fill(0)], weather_code: [85, 999, ...Array(28).fill(0)],
    },
  };
}

test('Open-Meteo keeps its general precipitation chance separate and preserves missing values', () => {
  const raw = openMeteoFixture();
  const weather = formatWeather(location, raw, {});
  assert.equal(weather.hourly24[0].precipitationProbability, 0);
  assert.equal(weather.hourly24[0].rain, 0);
  assert.equal(weather.hourly24[0].rainProbability, null);
  assert.equal(weather.hourly24[0].snowProbability, null);
  assert.equal(weather.hourly24[0].rainAmount, 0.4);
  assert.equal(weather.hourly24[0].snowAmount, 0.2);
  assert.equal(weather.hourly24[0].precipitationAmount, 0.6);
  assert.equal(weather.hourly24[1].precipitationProbability, null);
  assert.equal(weather.days[0].rainProbability, null);
  assert.equal(weather.days[0].snowProbability, null);
  assert.equal(weather.days[0].precipitationProbability, 0);
  assert.equal(weather.days[0].rainAmount, 0.4);
  assert.equal(weather.days[0].precipitationAmount, 0.6);
  assert.equal(weather.condition, '有雪');
  assert.equal(weather.icon, 'snowy');
  assert.equal(weather.days[0].icon, 'snowy');
  assert.equal(weather.hourly24[0].icon, 'sleet');
  assert.equal(weather.precipitationKind, 'snow');
  assert.equal(weather.precipitationIntensity, 'light');
  assert.equal(weather.displayCondition, '小阵雪');
  assert.equal(weather.days[0].precipitationIntensity, 'light');
  assert.equal(weather.hourly24[0].precipitationKind, 'mixed');
  assert.equal(weather.hourly24[0].precipitationIntensity, 'unknown');
  assert.equal(weather.hourly24[1].icon, 'cloudy');
  assert.equal(weather.days[1].condition, '天气状况未知');
  assert.match(weather.lifeIndices[0].detail, /雨雪/);
  const dry = openMeteoFixture();
  dry.current.weather_code = 0;
  dry.daily.weather_code[0] = 0;
  dry.daily.precipitation_sum[0] = 0;
  dry.daily.rain_sum[0] = 0;
  dry.daily.snowfall_sum[0] = 0;
  assert.match(formatWeather(location, dry, {}).lifeIndices[0].detail, /降水概率为 0%/);
  assert.equal(weather.providerData.source, 'open-meteo');
  assert.equal(weather.providerData.current, raw.current);
  assert.equal(weather.timezone, 'Asia/Shanghai');
  assert.equal(Object.hasOwn(weatherView(weather), 'providerData'), false);

  const displayForecast = openMeteoFixture();
  displayForecast.current.time = '2026-10-10T07:00';
  displayForecast.hourly.precipitation_probability[0] = 16;
  const displayWeather = formatWeather(location, displayForecast, {});
  const display = precipitationReminderView(location, displayWeather, null, 'open-meteo', new Date('2026-10-09T23:00:00Z'));
  assert.equal(display.time, '08:00');
  assert.equal(display.probabilityLabel, '降水概率');
  assert.equal(display.probability, '16%');
});

test('WeatherAPI uses separate rain/snow chance fields, keeps zero and does not invent a missing chance', () => {
  const forecast = {
    location: { name: 'Test', localtime: '2026-10-10 08:00', tz_id: 'Asia/Shanghai' },
    current: {
      last_updated: '2026-10-10 08:00', temp_c: 12, condition: { text: 'Sunny', code: 1000 }, is_day: 1,
      precip_mm: 0.4, pressure_mb: 1012, humidity: 65, vis_km: 8, wind_kph: 0, wind_degree: null,
      air_quality: {},
    },
    forecast: { forecastday: [{
      date: '2026-10-10', day: {
        maxtemp_c: 18, mintemp_c: 9, daily_chance_of_rain: 0, daily_chance_of_snow: null,
        totalprecip_mm: 0.4, totalsnow_cm: null, uv: 2, condition: { text: 'Sunny', code: 1000 },
      }, astro: { sunrise: '06:00 AM', sunset: '06:00 PM' },
      hour: [
        { time: '2026-10-10 08:00', temp_c: 12, condition: { text: 'Sunny', code: 1000 }, chance_of_rain: 0, chance_of_snow: null, precip_mm: 0.4 },
        { time: '2026-10-10 09:00', temp_c: 13, condition: { text: 'Cloudy', code: 1006 }, chance_of_rain: 26, chance_of_snow: null },
      ],
    }] },
  };
  const weather = formatWeatherApi(location, forecast);
  assert.equal(weather.hourly24[0].rainProbability, 0);
  assert.equal(weather.hourly24[0].snowProbability, null);
  assert.equal(weather.hourly24[0].precipitationProbability, null);
  assert.equal(weather.hourly24[0].rain, null);
  assert.equal(weather.hourly24[0].rainAmount, null);
  assert.equal(weather.hourly24[0].precipitationAmount, 0.4);
  assert.equal(weather.hourly24[1].rainProbability, 26);
  assert.equal(weather.hourly24[1].snowProbability, null);
  assert.equal(weather.hourly24[1].precipitationProbability, null);
  assert.equal(weather.days[0].rainProbability, 0);
  assert.equal(weather.days[0].snowProbability, null);
  assert.equal(weather.days[0].rainAmount, null);
  assert.equal(weather.days[0].precipitationAmount, 0.4);
  assert.equal(weather.providerData.source, 'weatherapi');
  assert.equal(weather.providerData.current, forecast.current);
  assert.equal(weather.timezone, 'Asia/Shanghai');
  const display = precipitationReminderView(location, weather, null, 'weatherapi', new Date('2026-10-10T00:00:00Z'));
  assert.equal(display.time, '09:00');
  assert.equal(display.probabilityLabel, '降雨概率');
  assert.equal(display.probability, '26%');
  assert.match(weatherView(weather).chartHtml, /雨0%/);

  const typedProbabilities = {
    ...forecast,
    forecast: { forecastday: [{
      ...forecast.forecast.forecastday[0],
      hour: forecast.forecast.forecastday[0].hour.map(hour => hour.time.endsWith('09:00')
        ? { ...hour, chance_of_snow: 35 } : hour),
    }] },
  };
  const typedWeather = formatWeatherApi(location, typedProbabilities);
  assert.equal(typedWeather.hourly24[1].rainProbability, 26);
  assert.equal(typedWeather.hourly24[1].snowProbability, 35);
  assert.equal(typedWeather.hourly24[1].precipitationProbability, null);
  const typeView = precipitationReminderView(location, typedWeather, null, 'weatherapi', new Date('2026-10-10T00:00:00Z'));
  assert.equal(typeView.typeLabel, '类型暂不明确');
  assert.equal(typeView.probabilityLabel, '分类型概率');
  assert.equal(typeView.probability, '降雨 26% · 降雪 35%');
});

test('MSN generic probability is not mislabeled, and source payload remains available for diagnostics', () => {
  const raw = {
    created: '2026-10-10T08:00:00+08:00', temp: '12°C', rh: '65%', windSpd: '0 km/h', baro: '1012 hPa',
    cap: '晴', symbol: '01',
  };
  const day = {
    almanac: { valid: '2026-10-10', sunrise: '2026-10-10T06:00:00+08:00', sunset: '2026-10-10T18:00:00+08:00' },
    highTemp: '18°C', lowTemp: '9°C', dayCap: '晴', daySymbol: '01', precipitation: '0%',
    hourly: [
      { timeStr: '2026-10-10T09:00:00+08:00', temperature: '13°C', precipitation: '0%', cap: '晴', symbol: '01' },
      { timeStr: '2026-10-10T10:00:00+08:00', temperature: '14°C', precipitation: '16%', cap: '多云', symbol: '02' },
    ],
  };
  const rawWeather = { currentCondition: { currentRaw: raw, currentTemperature: '12°C' }, forecast: [day] };
  const weather = formatBingWeather(location, rawWeather);
  assert.equal(weather.hourly24[0].precipitationProbability, 0);
  assert.equal(weather.hourly24[0].rainProbability, null);
  assert.equal(weather.hourly24[0].snowProbability, null);
  assert.equal(weather.days[0].precipitationProbability, 0);
  assert.equal(weather.days[0].rainProbability, null);
  assert.equal(weather.providerData.source, 'msn');
  assert.equal(weather.providerData.currentRaw, raw);
  const display = precipitationReminderView(location, weather, null, 'bing', new Date('2026-10-10T00:00:00Z'));
  assert.equal(display.time, '10:00');
  assert.equal(display.probabilityLabel, '降水概率');
  assert.equal(display.probability, '16%');
});

test('ordinary weather icons distinguish snow, fog, thunder, sleet and hail across providers', () => {
  const iconCases = [
    ['小雪', 'snowy-light'], ['大雾', 'foggy'], ['雷雨', 'thunderstorm'],
    ['雨夹雪', 'sleet'], ['冰雹', 'hail'],
  ];

  for (const [description, expected] of iconCases.slice(0, 3)) {
    const open = openMeteoFixture();
    const code = ({ 'snowy-light': 71, foggy: 45, thunderstorm: 95, sleet: 56, hail: 96 })[expected];
    open.current.weather_code = code;
    open.hourly.weather_code[0] = code;
    open.daily.weather_code[0] = code;
    open.hourly.rain.fill(0);
    open.hourly.snowfall.fill(0);
    open.daily.rain_sum.fill(0);
    open.daily.snowfall_sum.fill(0);
    const openData = formatWeather(location, open, {});
    assert.equal(openData.icon, expected, `Open-Meteo current ${description}`);
    assert.equal(openData.hourly24[0].icon, expected, `Open-Meteo hourly ${description}`);
    assert.equal(openData.days[0].icon, expected, `Open-Meteo daily ${description}`);
    assert.equal(weatherView(openData).icon, expected, `Open-Meteo rendered ${description}`);
  }

  const apiBase = {
    location: { name: 'Test', localtime: '2026-10-10 08:00', tz_id: 'Asia/Shanghai' },
    current: { last_updated: '2026-10-10 08:00', temp_c: 12, condition: { text: '未知', code: 1006 }, is_day: 1 },
    forecast: { forecastday: [{ date: '2026-10-10', day: { maxtemp_c: 18, mintemp_c: 9, condition: { text: '未知', code: 1006 } },
      astro: { sunrise: '06:00 AM', sunset: '06:00 PM' },
      hour: [{ time: '2026-10-10 08:00', temp_c: 12, condition: { text: '未知', code: 1006 } }] }] },
  };
  const apiCodes = { snowy: 1066, foggy: 1135, thunderstorm: 1087, sleet: 1069, hail: 1237 };
  for (const [expected, code] of Object.entries(apiCodes)) {
    const sample = structuredClone(apiBase);
    sample.current.condition.code = code;
    sample.forecast.forecastday[0].day.condition.code = code;
    sample.forecast.forecastday[0].hour[0].condition.code = code;
    const apiData = formatWeatherApi(location, sample);
    assert.equal(apiData.icon, expected, `WeatherAPI current ${expected}`);
    assert.equal(apiData.hourly24[0].icon, expected, `WeatherAPI hourly ${expected}`);
    assert.equal(apiData.days[0].icon, expected, `WeatherAPI daily ${expected}`);
    assert.equal(weatherView(apiData).icon, expected, `WeatherAPI rendered ${expected}`);
  }

  const msnBase = {
    currentCondition: { currentRaw: { created: '2026-10-10T08:00:00+08:00', temp: '12°C', cap: '晴', symbol: '01' } },
    forecast: [{ almanac: { valid: '2026-10-10' }, highTemp: '18°C', lowTemp: '9°C', dayCap: '晴', daySymbol: '01',
      hourly: [{ timeStr: '2026-10-10T09:00:00+08:00', temperature: '13°C', precipitation: '0%', cap: '晴', symbol: '01' }] }],
  };
  const msnCases = { '小雪': 'snowy-light', '大雾': 'foggy', '雷雨': 'thunderstorm', '雨夹雪': 'sleet', '冰雹': 'hail' };
  for (const [description, expected] of Object.entries(msnCases)) {
    const sample = structuredClone(msnBase);
    sample.currentCondition.currentRaw.cap = description;
    sample.forecast[0].dayCap = description;
    sample.forecast[0].hourly[0].cap = description;
    const msnData = formatBingWeather(location, sample);
    assert.equal(msnData.icon, expected, `MSN current ${description}`);
    assert.equal(msnData.hourly24[0].icon, expected, `MSN hourly ${description}`);
    assert.equal(msnData.days[0].icon, expected, `MSN daily ${description}`);
    assert.equal(weatherView(msnData).icon, expected, `MSN rendered ${description}`);
  }
});

test('MSN Chinese and English rain/snow descriptions map to six intensity icons without rewriting condition text', () => {
  const cases = [
    ['小雨', 'rain', 'light', 'rainy-light'], ['中雨', 'rain', 'moderate', 'rainy-moderate'], ['暴雨', 'rain', 'heavy', 'rainy-heavy'],
    ['小雪', 'snow', 'light', 'snowy-light'], ['中雪', 'snow', 'moderate', 'snowy-moderate'], ['暴雪', 'snow', 'heavy', 'snowy-heavy'],
    ['Light rain', 'rain', 'light', 'rainy-light'], ['Moderate rain', 'rain', 'moderate', 'rainy-moderate'], ['Heavy rain', 'rain', 'heavy', 'rainy-heavy'],
    ['Light snow', 'snow', 'light', 'snowy-light'], ['Moderate snow', 'snow', 'moderate', 'snowy-moderate'], ['Heavy snow', 'snow', 'heavy', 'snowy-heavy'],
  ];
  const base = {
    currentCondition: { currentRaw: { created: '2026-10-10T08:00:00+08:00', temp: '12°C', cap: '晴', symbol: '01' } },
    forecast: [{ almanac: { valid: '2026-10-10' }, highTemp: '18°C', lowTemp: '9°C', dayCap: '晴', daySymbol: '01',
      hourly: [{ timeStr: '2026-10-10T09:00:00+08:00', temperature: '13°C', precipitation: '90%', cap: '晴', symbol: '01' }] }],
  };
  for (const [description, kind, intensity, icon] of cases) {
    const raw = structuredClone(base);
    raw.currentCondition.currentRaw.cap = description;
    raw.forecast[0].dayCap = description;
    raw.forecast[0].hourly[0].cap = description;
    const weather = formatBingWeather(location, raw);
    for (const row of [weather, weather.days[0], weather.hourly24[0]]) {
      assert.equal(row.condition, description);
      assert.equal(row.precipitationKind, kind);
      assert.equal(row.precipitationIntensity, intensity);
      assert.equal(row.icon, icon);
    }
    assert.equal(weatherView(weather).icon, icon);
    assert.match(weatherView(weather).daysHtml, new RegExp(`href="#${icon}"`));
  }
});

test('Open-Meteo WMO 61/63/65 and 71/73/75 map consistently across current, hourly and daily forecasts', () => {
  const cases = [
    [61, 'rain', 'light', 'rainy-light', '小雨'], [63, 'rain', 'moderate', 'rainy-moderate', '中雨'], [65, 'rain', 'heavy', 'rainy-heavy', '大雨'],
    [71, 'snow', 'light', 'snowy-light', '小雪'], [73, 'snow', 'moderate', 'snowy-moderate', '中雪'], [75, 'snow', 'heavy', 'snowy-heavy', '大雪'],
  ];
  for (const [code, kind, intensity, icon, description] of cases) {
    const raw = openMeteoFixture();
    raw.current.weather_code = code;
    raw.hourly.weather_code.fill(code);
    raw.daily.weather_code.fill(code);
    raw.hourly.rain.fill(0);
    raw.hourly.snowfall.fill(0);
    raw.daily.rain_sum.fill(0);
    raw.daily.snowfall_sum.fill(0);
    const weather = formatWeather(location, raw, {});
    for (const row of [weather, weather.days[0], weather.hourly24[0]]) {
      assert.equal(row.precipitationKind, kind, `WMO ${code} kind`);
      assert.equal(row.precipitationIntensity, intensity, `WMO ${code} intensity`);
      assert.equal(row.icon, icon, `WMO ${code} icon`);
      assert.equal(row.displayCondition, description, `WMO ${code} description`);
    }
    assert.equal(weatherView(weather).condition, description);
    assert.equal(weatherView(weather).icon, icon);
    assert.match(weatherView(weather).daysHtml, new RegExp(`href="#${icon}"`));
    assert.equal(weather.condition, kind === 'rain' ? '有雨' : '有雪');
  }
});

test('Open-Meteo special WMO phenomena retain their descriptions and do not receive ordinary intensity icons', () => {
  const cases = [
    [51, '毛毛雨', 'rainy'], [80, '小阵雨', 'rainy'], [85, '小阵雪', 'snowy'],
    [95, '雷雨', 'thunderstorm'], [96, '雷暴伴小冰雹', 'thunderstorm'], [97, '强雷暴', 'thunderstorm'], [99, '雷暴伴大冰雹', 'thunderstorm'],
  ];
  for (const [code, description, icon] of cases) {
    const raw = openMeteoFixture();
    raw.current.weather_code = code;
    raw.hourly.weather_code.fill(code);
    raw.daily.weather_code.fill(code);
    raw.hourly.rain.fill(0);
    raw.hourly.snowfall.fill(0);
    raw.daily.rain_sum.fill(0);
    raw.daily.snowfall_sum.fill(0);
    const weather = formatWeather(location, raw, {});
    assert.equal(weather.displayCondition, description);
    assert.equal(weather.icon, icon);
    assert.equal(weather.hourly24[0].icon, icon);
    assert.equal(weather.days[0].icon, icon);
    if (code === 97) {
      assert.equal(weather.condition, '天气状况未知');
      assert.equal(weather.precipitationKind, 'unknown');
    }
  }
});

test('WeatherAPI explicit condition codes map six intensity icons in current, hourly and daily data', () => {
  const cases = [
    [1180, 'Patchy light rain', 'rain', 'light', 'rainy-light'],
    [1186, 'Moderate rain at times', 'rain', 'moderate', 'rainy-moderate'],
    [1195, 'Heavy rain', 'rain', 'heavy', 'rainy-heavy'],
    [1210, 'Patchy light snow', 'snow', 'light', 'snowy-light'],
    [1216, 'Patchy moderate snow', 'snow', 'moderate', 'snowy-moderate'],
    [1225, 'Heavy snow', 'snow', 'heavy', 'snowy-heavy'],
  ];
  for (const [code, description, kind, intensity, icon] of cases) {
    const forecast = {
      location: { name: 'Test', localtime: '2026-10-10 08:00', tz_id: 'Asia/Shanghai' },
      current: { last_updated: '2026-10-10 08:00', temp_c: 12, condition: { text: description, code }, is_day: 1 },
      forecast: { forecastday: [{ date: '2026-10-10', day: {
        maxtemp_c: 18, mintemp_c: 9, condition: { text: description, code },
      }, astro: { sunrise: '06:00 AM', sunset: '06:00 PM' }, hour: [{
        time: '2026-10-10 08:00', temp_c: 12, condition: { text: description, code }, chance_of_rain: 90, chance_of_snow: 90,
      }] }] },
    };
    const weather = formatWeatherApi(location, forecast);
    for (const row of [weather, weather.days[0], weather.hourly24[0]]) {
      assert.equal(row.precipitationKind, kind, `WeatherAPI ${code} kind`);
      assert.equal(row.precipitationIntensity, intensity, `WeatherAPI ${code} intensity`);
      assert.equal(row.icon, icon, `WeatherAPI ${code} icon`);
    }
    assert.equal(weatherView(weather).icon, icon);
    assert.match(weatherView(weather).daysHtml, new RegExp(`href="#${icon}"`));
    assert.equal(weather.condition, description);
  }
});

test('special precipitation stays on its specific icon and probabilities never determine intensity', () => {
  const specialCases = [
    ['毛毛雨', 'open-meteo', 51, 'rain', 'light'],
    ['阵雨', 'open-meteo', 80, 'rain', 'light'],
    ['阵雪', 'open-meteo', 85, 'snow', 'light'],
    ['Heavy freezing rain', 'weatherapi', 1201, 'rain', 'heavy'],
    ['Moderate or heavy rain shower', 'weatherapi', 1243, 'rain', 'unknown'],
    ['Moderate or heavy rain with thunder', 'weatherapi', 1276, 'rain', 'unknown'],
    ['Light sleet', 'weatherapi', 1204, 'mixed', 'unknown'],
  ];
  for (const [condition, source, code, kind, intensity] of specialCases) {
    const classification = classifyPrecipitation(condition, { source, code });
    assert.equal(classification.precipitationKind, kind, condition);
    assert.equal(classification.precipitationIntensity, intensity, condition);
    assert.equal(classification.icon, kind === 'mixed' ? 'sleet' : null, condition);
  }

  const forecast = {
    location: { name: 'Test', localtime: '2026-10-10 08:00', tz_id: 'Asia/Shanghai' },
    current: { last_updated: '2026-10-10 08:00', temp_c: 12, condition: { text: 'Cloudy', code: 1006 }, is_day: 1 },
    forecast: { forecastday: [{ date: '2026-10-10', day: { maxtemp_c: 18, mintemp_c: 9, condition: { text: 'Cloudy', code: 1006 } },
      astro: { sunrise: '06:00 AM', sunset: '06:00 PM' }, hour: [{
        time: '2026-10-10 08:00', temp_c: 12, condition: { text: 'Cloudy', code: 1006 }, chance_of_rain: 90,
      }] }] },
  };
  const weather = formatWeatherApi(location, forecast);
  assert.equal(weather.hourly24[0].precipitationKind, 'unknown');
  assert.equal(weather.hourly24[0].precipitationIntensity, 'unknown');
  assert.equal(weather.hourly24[0].icon, 'cloudy');
  assert.equal(weather.hourly24[0].rainProbability, 90);
  assert.equal(classifyPrecipitation('Rain').icon, null);
  assert.equal(classifyPrecipitation('Snow').icon, null);
  assert.deepEqual(classifyPrecipitation('天气状况未知', { rainAmount: 4 }), {
    precipitationKind: 'rain', precipitationIntensity: 'unknown', icon: null,
  });
  assert.deepEqual(classifyPrecipitation('小雨', { source: 'weatherapi', code: 1225 }), {
    precipitationKind: 'unknown', precipitationIntensity: 'unknown', icon: null,
  });
});

test('weather card SVG sprite defines every icon used by ordinary forecast mapping', async () => {
  const template = await readFile(new URL('../resources/weather.html', import.meta.url), 'utf8');
  for (const name of [
    'sun', 'moon', 'partly', 'night', 'rainy', 'snowy', 'rainy-light', 'rainy-moderate', 'rainy-heavy',
    'snowy-light', 'snowy-moderate', 'snowy-heavy', 'foggy', 'thunderstorm', 'sleet', 'hail', 'cloudy',
  ]) {
    assert.match(template, new RegExp(`<symbol\\s+id="${name}"`), `missing SVG symbol: ${name}`);
  }
});

test('switching weather sources fetches the selected provider and does not reuse another source result', async () => {
  const calls = { openMeteo: 0, air: 0, bingSearch: 0, msnPage: 0, weatherApi: 0 };
  const currentRaw = { created: '2026-10-10T08:00:00+08:00', temp: '12°C', rh: '65%', cap: '晴', symbol: '01' };
  const msnState = {
    currentCondition: { currentRaw },
    forecast: [{ almanac: { valid: '2026-10-10' }, highTemp: '18°C', lowTemp: '9°C', dayCap: '晴',
      hourly: [{ timeStr: '2026-10-10T09:00:00+08:00', temperature: '13°C', precipitation: '0%', cap: '晴', symbol: '01' }] }],
  };
  const apiForecast = {
    location: { localtime: '2026-10-10 08:00', tz_id: 'Asia/Shanghai' },
    current: { last_updated: '2026-10-10 08:00', temp_c: 12, condition: { text: '晴', code: 1000 }, is_day: 1 },
    forecast: { forecastday: [{ date: '2026-10-10', day: { maxtemp_c: 18, mintemp_c: 9, condition: { text: '晴', code: 1000 } },
      hour: [{ time: '2026-10-10 09:00', temp_c: 13, condition: { text: '晴', code: 1000 }, chance_of_rain: 0, chance_of_snow: 0 }] }] },
  };
  const response = (body, contentType = 'json') => ({
    ok: true, status: 200,
    json: async () => body,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  });
  const fetcher = async url => {
    const value = String(url);
    if (value.includes('air-quality-api.open-meteo.com')) { calls.air++; return response({}); }
    if (value.includes('api.open-meteo.com/v1/forecast')) { calls.openMeteo++; return response(openMeteoFixture()); }
    if (value.includes('www.bing.com/search')) { calls.bingSearch++; return response('<a href="https://www.msn.cn/zh-cn/weather/forecast/in-test">MSN</a>', 'text'); }
    if (value.includes('www.msn.cn/zh-cn/weather/forecast')) {
      calls.msnPage++;
      return response(`<script id="redux-data" type="application/json">${JSON.stringify({ WeatherData: { '_@STATE@_': msnState } })}</script>`, 'text');
    }
    if (value.includes('api.weatherapi.com/v1/forecast.json')) { calls.weatherApi++; return response(apiForecast); }
    throw new Error('Unexpected provider request');
  };
  const open = await getWeather(location, fetcher, { source: 'open-meteo' });
  const bing = await getWeather(location, fetcher, { source: 'bing' });
  const api = await getWeather(location, fetcher, { source: 'weatherapi', weatherApiKey: 'fixture-only' });
  assert.equal(open.providerData.source, 'open-meteo');
  assert.equal(bing.providerData.source, 'msn');
  assert.equal(api.providerData.source, 'weatherapi');
  assert.equal(calls.openMeteo, 1);
  assert.equal(calls.air, 1);
  assert.equal(calls.bingSearch, 1);
  assert.equal(calls.msnPage, 1);
  assert.equal(calls.weatherApi, 1);
});
