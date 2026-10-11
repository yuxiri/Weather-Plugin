import { precipitationForecastWindow, precipitationForecastWindowComplete } from './precipitation.js';

const escapeHtml = value => String(value ?? '—').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);
const iconName = name => ['sun', 'moon', 'partly', 'night', 'rainy', 'cloudy'].includes(name) ? name : 'cloudy';
const numeric = value => {
  if (value == null || value === '' || value === '—') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const degree = value => {
  const parsed = numeric(value);
  return parsed == null ? '—' : `${Math.round(parsed)}°`;
};
const chartWidth = 1048;

function smoothSegment(points) {
  if (points.length < 2) return '';
  let path = `M${points[0].x},${points[0].y}`;
  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index], end = points[index + 1];
    const third = (end.x - start.x) / 3;
    path += ` C${start.x + third},${start.y} ${end.x - third},${end.y} ${end.x},${end.y}`;
  }
  return path;
}

function precipitationChartValue(hour) {
  const direct = numeric(hour.precipitationProbability) ?? numeric(hour.rain);
  if (direct != null) return { value: direct, label: `${Math.round(Math.max(0, Math.min(100, direct)))}%` };
  const rain = numeric(hour.rainProbability);
  const snow = numeric(hour.snowProbability);
  if (rain == null && snow == null) return { value: null, label: '—' };
  const value = Math.max(rain ?? 0, snow ?? 0);
  const percent = chance => `${Math.round(Math.max(0, Math.min(100, chance)))}%`;
  const label = rain != null && snow != null ? `雨${percent(rain)}/雪${percent(snow)}`
    : rain != null ? `雨${percent(rain)}` : `雪${percent(snow)}`;
  return { value, label };
}

function buildHourlyChart(hours) {
  if (!hours.length) return '';
  const temperatures = hours.map(hour => numeric(hour.temp));
  const valid = temperatures.filter(value => value != null);
  const min = valid.length ? Math.min(...valid) : 0;
  const max = valid.length ? Math.max(...valid) : 0;
  const actualRange = max - min;
  // Keep small real changes visible while retaining a linear, non-overshooting scale.
  const domainSpan = Math.max(7, actualRange * 1.25);
  const domainMin = (min + max - domainSpan) / 2;
  const plotTop = 25, plotBottom = 79;
  const xAt = index => (index + 0.5) * chartWidth / hours.length;
  const yAt = value => plotBottom - ((value - domainMin) / domainSpan) * (plotBottom - plotTop);
  const points = hours.map((hour, index) => {
    const value = temperatures[index];
    return value == null ? null : { x: xAt(index), y: yAt(value), value };
  });
  const segments = [];
  let segment = [];
  for (const point of points) {
    if (point) segment.push(point);
    else if (segment.length) { segments.push(segment); segment = []; }
  }
  if (segment.length) segments.push(segment);

  const areas = segments.filter(row => row.length > 1).map(row => {
    const path = smoothSegment(row);
    return `<path class="temperature-area" d="${path} L${row.at(-1).x},94 L${row[0].x},94 Z"/>`;
  }).join('');
  const lines = segments.map(row => `<path class="temperature-line" d="${smoothSegment(row)}"/>`).join('');
  const dots = points.filter(Boolean).map(point => `<g class="temperature-point"><circle cx="${point.x}" cy="${point.y}" r="7"/><circle class="point-core" cx="${point.x}" cy="${point.y}" r="3.5"/></g>`).join('');
  const labels = points.map(point => point
    ? `<text class="temperature-label" x="${point.x}" y="${Math.max(15, point.y - 13)}">${escapeHtml(degree(point.value))}</text>`
    : '').join('');
  const bars = hours.map((hour, index) => {
    const { value: chance, label } = precipitationChartValue(hour);
    const height = chance == null ? 0 : Math.max(0, Math.min(100, chance)) * 0.17;
    const x = xAt(index);
    const rect = height > 0 ? `<rect class="precipitation-bar" x="${x - 7}" y="${120 - height}" width="14" height="${height}" rx="5"/>` : '';
    return `${rect}<text class="precipitation-label" x="${x}" y="140">${label}</text>`;
  }).join('');
  const noTemperature = valid.length ? '' : '<text class="chart-empty" x="524" y="54">暂无温度数据</text>';

  return `<defs>
    <linearGradient id="temperatureFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#59a6ed" stop-opacity=".22"/>
      <stop offset="1" stop-color="#59a6ed" stop-opacity=".015"/>
    </linearGradient>
  </defs>
  ${areas}${bars}${lines}${dots}${labels}${noTemperature}`;
}

function forecastKind(event) {
  const condition = String(event?.condition || '');
  const raw = String(event?.precipitationType || '').toLowerCase();
  if (raw === 'sleet' || /雨夹雪|雨雪|雨.*雪|雪.*雨/.test(condition)) return 'sleet';
  if (raw === 'snow' || /雪/.test(condition)) return 'snow';
  if (raw === 'rain' || /雨|雷/.test(condition)) return 'rain';
  const rainProbability = numeric(event?.rainProbability);
  const snowProbability = numeric(event?.snowProbability);
  if (rainProbability > 0 && !(snowProbability > 0)) return 'rain';
  if (snowProbability > 0 && !(rainProbability > 0)) return 'snow';
  return 'precipitation';
}

function validProbability(value) {
  const parsed = numeric(value);
  return parsed != null && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function validAmount(value) {
  const parsed = numeric(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function hasPrecipitationObservation(hour) {
  const condition = String(hour?.condition || '').trim();
  return (condition && condition !== '天气状况未知')
    || ['rainProbability', 'snowProbability', 'precipitationProbability', 'precipitationAmount', 'rainAmount', 'snowAmount']
      .some(field => numeric(hour?.[field]) != null);
}

function hasNearPrecipitationObservation(hour) {
  const condition = String(hour?.condition || '').trim();
  const rawType = String(hour?.precipitationType || '').toLowerCase();
  const typedCondition = /雨|雪|雷/.test(condition)
    || ['rain', 'snow', 'sleet'].includes(rawType);
  return typedCondition
    || ['rainProbability', 'snowProbability', 'precipitationProbability', 'rain']
      .some(field => validProbability(hour?.[field]) != null)
    || ['precipitationAmount', 'rainAmount', 'snowAmount']
      .some(field => validAmount(hour?.[field]) != null);
}

function probabilityForForecast(hour, kind) {
  const specific = kind === 'rain' ? numeric(hour?.rainProbability)
    : kind === 'snow' ? numeric(hour?.snowProbability) : null;
  if (specific != null) return { label: kind === 'rain' ? '降雨概率' : '降雪概率', value: specific };
  const generic = numeric(hour?.precipitationProbability) ?? numeric(hour?.rain);
  if (generic != null) return { label: '降水概率', value: generic };
  const rain = numeric(hour?.rainProbability);
  const snow = numeric(hour?.snowProbability);
  if (rain != null || snow != null) {
    const details = [
      rain == null ? '' : `降雨 ${Math.round(Math.max(0, Math.min(100, rain)))}%`,
      snow == null ? '' : `降雪 ${Math.round(Math.max(0, Math.min(100, snow)))}%`,
    ].filter(Boolean);
    return { label: '分类型概率', value: null, displayText: details.join(' · ') };
  }
  return { label: '降水概率', value: null };
}

function forecastTimeLabel(row, timezone, now) {
  const time = row.time || String(row.hour?.time || '').match(/(?:T|\s)(\d{2}:\d{2})/)?.[1] || '';
  if (!row.date || row.date === localDateParts(timezone, now)) return time;
  const today = localDateParts(timezone, now);
  const delta = Math.round((Date.parse(`${row.date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  const day = delta === 1 ? '明天' : `${Number(row.date.slice(5, 7))}月${Number(row.date.slice(8, 10))}日`;
  return `${day} ${time}`;
}

function forecastSignal(row) {
  const hour = row.hour;
  const kind = forecastKind(hour);
  const probability = probabilityForForecast(hour, kind);
  const amount = numeric(kind === 'snow' ? hour?.snowAmount : kind === 'rain' ? hour?.rainAmount : hour?.precipitationAmount);
  const genericAmount = numeric(hour?.precipitationAmount);
  const specificPossible = (numeric(hour?.rainProbability) ?? 0) > 0 || (numeric(hour?.snowProbability) ?? 0) > 0;
  const hasTypedDescription = kind !== 'precipitation';
  const possible = (probability.value != null && probability.value > 0)
    || specificPossible
    || (amount != null && amount > 0)
    || (genericAmount != null && genericAmount > 0)
    || hasTypedDescription;
  return { ...row, kind, probability, amount, possible };
}

function nearWindowKind(hour) {
  const condition = String(hour?.condition || '');
  const raw = String(hour?.precipitationType || '').toLowerCase();
  if (raw === 'sleet' || /雨夹雪|雨雪|雨.*雪|雪.*雨/.test(condition)) return 'sleet';
  if (raw === 'snow' || /雪/.test(condition)) return 'snow';
  if (raw === 'rain' || /雨|雷/.test(condition)) return 'rain';
  const rain = validProbability(hour?.rainProbability);
  const snow = validProbability(hour?.snowProbability);
  if (rain > 0 && !(snow > 0)) return 'rain';
  if (snow > 0 && !(rain > 0)) return 'snow';
  const rainAmount = validAmount(hour?.rainAmount);
  const snowAmount = validAmount(hour?.snowAmount);
  if (rainAmount > 0 && !(snowAmount > 0)) return 'rain';
  if (snowAmount > 0 && !(rainAmount > 0)) return 'snow';
  return 'precipitation';
}

function nearForecastSignal(row) {
  const hour = row.hour;
  const kind = nearWindowKind(hour);
  const probability = nearWindowProbability(hour, kind);
  const amount = validAmount(kind === 'snow' ? hour?.snowAmount : kind === 'rain' ? hour?.rainAmount : hour?.precipitationAmount);
  const typedDescription = /雨|雪|雷/.test(String(hour?.condition || ''))
    || ['rain', 'snow', 'sleet'].includes(String(hour?.precipitationType || '').toLowerCase());
  const possible = (probability?.value != null && probability.value > 0)
    || (amount != null && amount > 0)
    || typedDescription;
  return { ...row, kind, probability, amount, possible, typedDescription };
}

function nearWindowProbability(hour, kind) {
  const rain = validProbability(hour?.rainProbability);
  const snow = validProbability(hour?.snowProbability);
  const generic = validProbability(hour?.precipitationProbability) ?? validProbability(hour?.rain);
  if (kind === 'rain' && rain != null) return { value: rain, label: '降雨' };
  if (kind === 'snow' && snow != null) return { value: snow, label: '降雪' };
  if (generic != null) return { value: generic, label: '降水' };
  if (rain == null && snow == null) return null;
  return rain != null && (snow == null || rain >= snow)
    ? { value: rain, label: '降雨' }
    : { value: snow, label: '降雪' };
}

function probabilityBand(probability) {
  const { value, label } = probability;
  if (value < 10) return `${label}概率极低`;
  if (value < 30) return `${label}可能性较低`;
  if (value < 50) return `有一定${label}可能`;
  if (value < 70) return `${label}可能性较高`;
  return `${label}概率高`;
}

function describedPrecipitation(samples) {
  const kinds = new Set(samples.filter(sample => sample.typedDescription || sample.amount > 0).map(sample => {
    if (sample.kind === 'rain') return '降雨';
    if (sample.kind === 'snow') return '降雪';
    if (sample.kind === 'sleet') return '雨夹雪';
    return sample.amount > 0 ? '降水' : '';
  }).filter(Boolean));
  if (!kinds.size) return '';
  if (kinds.size === 1) return `预报有${[...kinds][0]}`;
  return '预报有雨雪';
}

function nearWindowDescription(samples, allFuture, now, timezone) {
  const probabilities = samples.filter(sample => sample.probability)
    .sort((a, b) => b.probability.value - a.probability.value || a.timestamp - b.timestamp);
  const eventSamples = samples.filter(sample => sample.possible);
  const completeWindow = allFuture.length > 0
    && allFuture.every(row => hasNearPrecipitationObservation(row.hour))
    && precipitationForecastWindowComplete(allFuture, now, 2);
  const partial = !completeWindow || probabilities.length < allFuture.length;

  if (probabilities.length) {
    const highest = probabilities[0];
    const eventLabel = describedPrecipitation(eventSamples);
    const qualifier = partial ? '已知时段：' : '';
    const summary = `${qualifier}${eventLabel ? `${eventLabel} · ` : ''}${probabilityBand(highest.probability)}`;
    const time = forecastTimeLabel(highest, timezone, now);
    return `${summary}\n最高 ${Math.round(highest.probability.value)}%${time ? ` · ${time}` : ''}`;
  }

  if (eventSamples.length) {
    const first = eventSamples.sort((a, b) => a.timestamp - b.timestamp)[0];
    const eventLabel = describedPrecipitation(eventSamples) || '预报有降水';
    const time = forecastTimeLabel(first, timezone, now);
    return `${partial ? '已知时段：' : ''}${eventLabel}\n概率数据暂缺${time ? ` · ${time}` : ''}`;
  }

  return '暂无近两小时降水数据';
}

function precipitationText(data, now = new Date()) {
  const timezone = data.timezone || 'UTC';
  const allFuture = precipitationForecastWindow(data, now, timezone, 2);
  const samples = allFuture.map(nearForecastSignal);
  const currentCondition = String(data.condition || '');
  const currentRain = /雨|雷/.test(currentCondition);
  const currentSnow = /雪/.test(currentCondition);
  const currentKind = currentRain && currentSnow ? '雨雪' : currentSnow ? '降雪' : '降雨';
  const currentRate = numeric(data.currentPrecipitationRate);
  const currentAmount = numeric(data.currentPrecipitationAmount);
  const intensity = currentRate != null ? `强度${currentRate}mm/h`
    : currentAmount != null ? `近1小时${currentAmount.toFixed(1)}mm` : '';

  if (currentRain || currentSnow) {
    const current = `当前${currentKind}${intensity ? ` · ${intensity}` : ''}`;
    return `${current}\n${nearWindowDescription(samples, allFuture, now, timezone)}`;
  }

  return nearWindowDescription(samples, allFuture, now, timezone);
}

function numericValue(value) {
  if (value == null || value === '' || value === '—') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function localDateParts(timezone, date = new Date()) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function forecastLocalParts(event, timezone) {
  const dateTime = String(event?.dateTime || event?.datetime || '');
  const offsetTimestamp = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(dateTime) ? Date.parse(dateTime) : NaN;
  if (Number.isFinite(offsetTimestamp)) {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(offsetTimestamp)).map(part => [part.type, part.value]));
      return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
    } catch {}
  }
  const local = dateTime.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  const date = local?.[1] || String(event?.date || event?.localDate || '').match(/^\d{4}-\d{2}-\d{2}$/)?.[0] || '';
  const time = local?.[2] || String(event?.time || '').match(/^(?:[01]\d|2[0-3]):[0-5]\d$/)?.[0] || '';
  return { date, time };
}

const precipitationIcons = {
  rain: '<svg viewBox="0 0 96 96" aria-hidden="true"><path d="M25 54h45a15 15 0 0 0 0-30 22 22 0 0 0-42-3 17 17 0 0 0-3 33Z" fill="#fff" stroke="#74a9d3" stroke-width="3"/><path d="m34 65-5 10m21-10-5 10m21-10-5 10" stroke="#4c9cdd" stroke-width="5" stroke-linecap="round"/></svg>',
  snow: '<svg viewBox="0 0 96 96" aria-hidden="true"><path d="M25 52h45a15 15 0 0 0 0-30 22 22 0 0 0-42-3 17 17 0 0 0-3 33Z" fill="#fff" stroke="#74a9d3" stroke-width="3"/><g stroke="#559bd2" stroke-width="3" stroke-linecap="round"><path d="M34 63v20m-9-15 18 10m0-10L25 78M58 63v20m-9-15 18 10m0-10L49 78"/></g></svg>',
  sleet: '<svg viewBox="0 0 96 96" aria-hidden="true"><path d="M24 49h46a15 15 0 0 0 0-30 22 22 0 0 0-42-3 17 17 0 0 0-4 33Z" fill="#fff" stroke="#74a9d3" stroke-width="3"/><path d="m34 59-4 9m18-9-4 9" stroke="#4c9cdd" stroke-width="4" stroke-linecap="round"/><g stroke="#559bd2" stroke-width="2.5" stroke-linecap="round"><path d="M65 62v16m-7-12 14 8m0-8-14 8"/></g></svg>',
  precipitation: '<svg viewBox="0 0 96 96" aria-hidden="true"><path d="M25 54h45a15 15 0 0 0 0-30 22 22 0 0 0-42-3 17 17 0 0 0-3 33Z" fill="#fff" stroke="#74a9d3" stroke-width="3"/><path d="m34 65-5 10m21-10-5 10m21-10-5 10" stroke="#4c9cdd" stroke-width="5" stroke-linecap="round"/></svg>',
  none: '<svg viewBox="0 0 96 96" aria-hidden="true"><path d="M22 54h50a16 16 0 0 0 0-32 23 23 0 0 0-44-3 18 18 0 0 0-6 35Z" fill="#fff" stroke="#74a9d3" stroke-width="3"/><path d="M33 69h30" stroke="#83b5d7" stroke-width="4" stroke-linecap="round"/></svg>',
};

function precipitationDayPart(time) {
  const hour = Number(String(time || '').slice(0, 2));
  if (!Number.isFinite(hour)) return '';
  if (hour >= 5 && hour < 12) return '上午';
  if (hour >= 12 && hour < 18) return '下午';
  if (hour >= 18 && hour < 23) return '晚上';
  return '夜间';
}

function precipitationTimePeriod(date, time, timezone, now) {
  if (!date || !time) return '预报日期暂缺';
  const today = localDateParts(timezone, now);
  const dayDelta = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  const part = precipitationDayPart(time);
  if (dayDelta === 0) return `今天${part}`;
  if (dayDelta === 1) return `明天${part}`;
  if (dayDelta > 1 && dayDelta < 7) return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日${part}`;
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日${part}`;
}

function precipitationSourceName(source) {
  const value = String(source || '').toLowerCase();
  if (/weatherapi/.test(value)) return 'WeatherAPI';
  if (/bing|msn/.test(value)) return 'MSN 天气';
  if (/open.?meteo/.test(value)) return 'Open-Meteo';
  return String(source || '未获取到');
}

export function precipitationReminderView(location, weather, event, source = 'bing', now = new Date()) {
  const kinds = {
    rain: { title: '降雨提醒', timeLabel: '预计降雨时间', probabilityLabel: '降雨概率', icon: precipitationIcons.rain, advice: '预报显示有降雨可能，外出建议携带雨具。' },
    snow: { title: '降雪提醒', timeLabel: '预计降雪时间', probabilityLabel: '降雪概率', icon: precipitationIcons.snow, advice: '预报显示有降雪可能，出行请留意道路湿滑。' },
    sleet: { title: '雨雪提醒', timeLabel: '预计雨雪时间', probabilityLabel: '降水概率', icon: precipitationIcons.sleet, advice: '预报提示有雨夹雪可能，注意道路湿滑及低温。' },
    precipitation: { title: '降水预报', timeLabel: '预计降水时间', probabilityLabel: '降水概率', icon: precipitationIcons.precipitation, advice: '未来有降水可能，请留意天气变化。' },
  };
  const timezone = weather?.timezone || location?.timezone || 'UTC';
  const windowRows = precipitationForecastWindow(weather, now, timezone, 24);
  const candidates = windowRows.map(forecastSignal).filter(sample => sample.possible);
  const eventLocal = forecastLocalParts(event, timezone);
  const eventTimeKey = event && eventLocal.date && eventLocal.time ? `${eventLocal.date}T${eventLocal.time}` : '';
  const matchedCandidate = eventTimeKey
    ? candidates.find(sample => `${sample.date}T${sample.time}` === eventTimeKey)
    : null;
  const primary = event
    ? matchedCandidate || forecastSignal({ hour: event, date: eventLocal.date, time: eventLocal.time })
    : candidates[0] || null;
  const kind = primary ? primary.kind : 'precipitation';
  const config = kinds[kind];
  const forecast = primary
    ? { date: primary.date || eventLocal.date, time: primary.time || eventLocal.time }
    : { date: '', time: '' };
  const dateLabel = precipitationTimePeriod(forecast.date, forecast.time, timezone, now);
  const probability = primary?.probability.value ?? null;
  const probabilityLabel = primary?.probability.label || config.probabilityLabel;
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(forecast.time) ? forecast.time : '暂无数据';
  const hasEvent = Boolean(primary);
  const allForecastRowsKnown = windowRows.length > 0 && windowRows.every(row => hasPrecipitationObservation(row.hour));
  const forecastComplete = allForecastRowsKnown && precipitationForecastWindowComplete(windowRows, now, 24);
  const localToday = (() => {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(now instanceof Date ? now : new Date(now)).map(part => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    } catch { return new Date(now).toISOString().slice(0, 10); }
  })();
  const nextLocalDay = new Date(Date.parse(`${localToday}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const dailyTextPossible = (Array.isArray(weather?.days) ? weather.days : []).some(day => {
    if (!day?.date || day.date < localToday || day.date > nextLocalDay) return false;
    const condition = String(day?.condition || '');
    const rainOrSnowText = /雨|雪|雷|rain|shower|sleet|snow|thunder/i.test(condition);
    const chance = numeric(day?.precipitationProbability);
    const amount = numeric(day?.precipitationAmount);
    return rainOrSnowText || (chance != null && chance > 0) || (amount != null && amount > 0);
  });
  const otherPeriods = candidates.filter(sample => sample !== matchedCandidate && sample !== primary);
  const shownOtherPeriods = otherPeriods.slice(0, 5);
  const moreCount = Math.max(0, otherPeriods.length - shownOtherPeriods.length);
  const additionalPeriodsHtml = shownOtherPeriods.length || moreCount
    ? `<div class="period-list"><div class="period-list-title">其他预报时段</div><div class="period-list-items">${shownOtherPeriods.map(sample => {
      const label = sample.kind === 'sleet' ? '雨夹雪' : sample.kind === 'snow' ? '降雪' : sample.kind === 'rain' ? '降雨' : '类型暂不明确';
      const chance = sample.probability.displayText
        ? `${sample.probability.label}：${sample.probability.displayText}`
        : sample.probability.value == null ? '概率暂无数据' : `${sample.probability.label}${Math.round(Math.max(0, Math.min(100, sample.probability.value)))}%`;
      const period = precipitationTimePeriod(sample.date, sample.time, timezone, now);
      return `<span class="period-chip">${escapeHtml(period)} ${escapeHtml(sample.time || '')} · ${escapeHtml(chance)} · ${escapeHtml(label)}</span>`;
    }).join('')}${moreCount ? `<span class="period-chip">另有 ${moreCount} 个时段</span>` : ''}</div></div>`
    : '';
  const typeLabel = !hasEvent ? '类型暂不明确'
    : kind === 'precipitation' ? '类型暂不明确'
      : kind === 'sleet' ? '雨夹雪' : kind === 'snow' ? '降雪' : '降雨';
  const coverageNote = hasEvent && !forecastComplete
    ? '逐小时预报数据不完整，以下仅展示已获取时段。' : '';
  const cityName = location?.name || '天气';
  const reminderTitle = hasEvent ? config.title : '降水预报';
  return {
    title: `${cityName} · ${reminderTitle}`,
    cityName,
    reminderTitle,
    subtitle: '未来24小时降水预测',
    iconHtml: hasEvent ? config.icon : precipitationIcons.none,
    timeLabel: hasEvent ? config.timeLabel : '预计降水时间',
    time,
    timePeriod: time === '暂无数据' ? '预报时间未提供' : dateLabel,
    typeLabel,
    probabilityLabel,
    probability: primary?.probability.displayText || (probability == null ? '暂无数据' : `${Math.round(Math.min(100, Math.max(0, probability)))}%`),
    probabilityNote: probability == null && !primary?.probability.displayText ? '该时段降水概率数据暂缺' : '仅对应当前预报时段',
    advice: hasEvent ? config.advice : '',
    additionalPeriodsHtml,
    coverageNote,
    emptyMessage: hasEvent ? '' : dailyTextPossible ? '未来24小时存在降水可能，具体时间及类型暂不明确。'
      : forecastComplete ? '未来24小时暂无明确降水预报' : '未来24小时降水预报数据不足，暂无法判断。',
    hasEvent,
    showEmpty: !hasEvent,
    sourceNote: `数据来源：${precipitationSourceName(source)} · 天气预报仅供参考。`,
  };
}

function statusClass(value, breakpoints) {
  const parsed = numeric(value);
  if (parsed == null) return 'status-neutral';
  if (parsed <= breakpoints[0]) return 'status-good';
  if (parsed <= breakpoints[1]) return 'status-moderate';
  return 'status-high';
}

function shortAlertSummary(alert) {
  const value = String(alert.summary || '').replace(/\s+/g, ' ').trim();
  return value.length > 220 ? `${value.slice(0, 219)}…` : value;
}

function alertBannerHtml(alert, otherCount) {
  const color = ['red', 'orange', 'yellow', 'blue'].includes(alert.color) ? alert.color : 'neutral';
  const severity = alert.severity || alert.level || '';
  const title = alert.event && alert.event !== '天气预警' ? alert.event : alert.headline || '气象预警';
  const summary = shortAlertSummary(alert);
  return `<aside class="weather-alert-banner alert-${color}">
    <span class="weather-alert-symbol" aria-hidden="true">${warningTypeIcon(alert.kind)}</span>
    <div class="weather-alert-copy">
      <div class="weather-alert-title-line"><div class="weather-alert-title">${escapeHtml(title)}</div>${severity ? `<span class="weather-alert-level">${escapeHtml(severity)}</span>` : ''}</div>
      ${summary ? `<div class="weather-alert-summary">${escapeHtml(summary)}</div>` : ''}
    </div>
    ${otherCount ? `<div class="weather-alert-meta">另有 ${otherCount} 条预警</div>` : ''}
  </aside>`;
}

function formatAlertTime(value, timezone) {
  if (!value) return '未提供';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone || 'Asia/Shanghai', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(date);
  } catch { return String(value); }
}

function warningTypeIcon(kind) {
  const drawings = {
    '台风': '<path d="M20 9a8 8 0 1 0 1 4"/><path d="M16 6a5 5 0 1 0 1 7"/><path d="M12 9a2.5 2.5 0 1 0 2.5 2.5"/><path d="M21 3v6h-6"/>',
    '雷暴': '<path d="M13 2 5 14h6l-1 8 9-12h-6z"/>',
    '暴雨 / 洪水': '<path d="M6 15.5h11a4 4 0 0 0 .3-8A6 6 0 0 0 6 9a3.3 3.3 0 0 0 0 6.5Z"/><path d="m8 18-1 3m6-3-1 3m6-3-1 3"/>',
    '大雾': '<path d="M3 8c2.4-3 4.7 3 7 0s4.6 3 7 0 3.5-.5 4 .2M2 12c2.5-3 4.8 3 7.2 0s4.6 3 7 0 4-.5 5.3.2M4 16c2.2-2.6 4.5 2.6 6.8 0s4.5 2.6 6.8 0 3.2-.5 4.4.2"/>',
    '大风': '<path d="M3 8h12a3 3 0 1 0-3-3M2 12h17a3 3 0 1 1-3 3M5 16h7"/>',
    '暴雪': '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9 5l3 2 3-2M9 19l3-2 3 2M4.5 11l.2-3.6 3-1.4M19.5 13l-.2 3.6-3 1.4M7.7 18l-3-1.4L4.5 13M16.3 6l3 1.4.2 3.6"/>',
    '寒潮': '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9 5l3 2 3-2M9 19l3-2 3 2"/>',
    '高温': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    '冰雹': '<path d="M6 14.5h11a4 4 0 0 0 .3-8A6 6 0 0 0 6 8a3.3 3.3 0 0 0 0 6.5Z"/><circle cx="8" cy="18" r="1.2"/><circle cx="13" cy="19" r="1.2"/><circle cx="18" cy="17.5" r="1.2"/>',
    '沙尘暴': '<path d="M3 8h11a2.5 2.5 0 1 0-2.5-2.5M2 12h16a2.5 2.5 0 1 1-2.5 2.5M4 16h8"/><circle cx="20" cy="18" r="1"/>',
    '道路结冰': '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9 5l3 2 3-2M9 19l3-2 3 2"/><path d="m5 3 1 1m12 0 1-1"/>',
  };
  const drawing = drawings[kind] || '<path d="M12 3 22 20H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>';
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${drawing}</svg>`;
}

function warningCardHtml(alert, index, timezone, historical = false) {
  const color = ['red', 'orange', 'yellow', 'blue'].includes(alert.color) ? alert.color : 'neutral';
  const severity = alert.severity || alert.level || '未提供';
  const body = alert.description
    ? `<section class="warning-section"><h3>预警说明</h3><p>${escapeHtml(alert.description)}</p></section>` : '';
  const instruction = alert.sourceInstruction
    ? `<section class="warning-section"><h3>发布机构提示</h3><p>${escapeHtml(alert.sourceInstruction)}</p></section>` : '';
  const guide = alert.defenseGuide
    ? `<section class="warning-section defense-guide"><h3>防御指南</h3><p>${escapeHtml(alert.defenseGuide)}</p></section>`
    : '<section class="warning-section defense-guide"><h3>防御指南</h3><p class="missing-detail">发布机构未提供防御指南。</p></section>';
  const period = alert.expires
    ? `${alert.effective ? formatAlertTime(alert.effective, timezone) : '生效时间未提供'} 至 ${formatAlertTime(alert.expires, timezone)}`
    : '有效期未提供';
  const title = alert.event && alert.event !== '天气预警' ? alert.event : alert.headline || '天气预警';
  const summary = shortAlertSummary(alert);
  const area = alert.areas
    ? `<div><span>影响地区</span><strong>${escapeHtml(alert.areas)}</strong></div>` : '';
  const matchedLocations = Array.isArray(alert.matchedLocations) ? alert.matchedLocations : [];
  const matchedLabel = matchedLocations.length > 1
    ? `${matchedLocations.slice(0, 8).join('、')}${matchedLocations.length > 8 ? ` 等 ${matchedLocations.length} 个查询地点` : ''}`
    : !alert.areas && matchedLocations.length === 1 ? matchedLocations[0] : '';
  const matchedArea = matchedLabel
    ? `<div><span>查询命中地点</span><strong>${escapeHtml(matchedLabel)}</strong></div>` : '';
  return `<article class="warning-card alert-${color}">
    <header class="warning-card-heading">
      <span class="warning-symbol">${warningTypeIcon(alert.kind)}</span>
      <div class="warning-title-copy">
        <div class="warning-counter">${historical ? '历史预警' : '预警'} ${index + 1}</div>
        <h2>${escapeHtml(title)}</h2>
        <div class="warning-tags"><span>${escapeHtml(severity)}</span></div>
      </div>
    </header>
    <div class="warning-meta-grid">
      <div><span>发布机构</span><strong>${escapeHtml(alert.sourceAgency || '未提供')}</strong></div>
      <div><span>发布时间</span><strong>${escapeHtml(formatAlertTime(alert.publishedAt, timezone))}</strong></div>
      <div><span>有效时间</span><strong>${escapeHtml(period)}</strong></div>
      ${area}
      ${matchedArea}
    </div>
    ${summary ? `<div class="warning-summary">${escapeHtml(summary)}</div>` : ''}
    ${body}
    ${instruction}
    ${guide}
  </article>`;
}

export function weatherWarningsView(location, snapshot, scopeNote = '') {
  scopeNote ||= snapshot?.scopeNote || '';
  const alerts = Array.isArray(snapshot?.alerts) ? snapshot.alerts : [];
  const historical = Boolean(snapshot?.historical);
  const updatedAt = formatAlertTime(snapshot?.fetchedAt, location.timezone);
  const visibleAlerts = alerts.slice(0, 8);
  const partialCoverage = snapshot?.status === 'partial' || snapshot?.coverage?.complete === false;
  let cardsHtml;
  if (visibleAlerts.length) {
    cardsHtml = visibleAlerts.map((alert, index) => warningCardHtml(alert, index, location.timezone, historical)).join('');
    if (alerts.length > visibleAlerts.length) {
      cardsHtml += `<section class="more-alerts">另有 ${alerts.length - visibleAlerts.length} 条预警未在本张图片展示，已按等级及发布时间排序。</section>`;
    }
  } else if (historical) {
    cardsHtml = '<section class="no-weather-alerts is-partial"><span aria-hidden="true">!</span><div><strong>历史快照未显示预警</strong><p>数据正在更新，历史结果不能用于判断当前是否有生效预警。</p></div></section>';
  } else if (partialCoverage) {
    const allUnavailable = Number(snapshot?.coverage?.total) > 0 && Number(snapshot?.coverage?.successful) === 0;
    cardsHtml = allUnavailable
      ? '<section class="no-weather-alerts is-partial"><span aria-hidden="true">!</span><div><strong>预警数据获取失败</strong><p>本次未能取得任何目标地区的有效预警数据，请稍后重试。</p></div></section>'
      : '<section class="no-weather-alerts is-partial"><span aria-hidden="true">!</span><div><strong>区域预警查询未完成</strong><p>已查询范围内未发现生效预警，但仍有地区未取得有效结果，不能据此确认整个区域无预警。</p></div></section>';
  } else {
    const description = ['province', 'city'].includes(snapshot?.coverage?.kind)
      ? '已完成下辖县级地区查询，本次未发现生效预警。'
      : '本次查询未发现适用于该地点的生效预警。';
    cardsHtml = `<section class="no-weather-alerts"><span aria-hidden="true">✓</span><div><strong>当前暂无生效气象预警</strong><p>${description}</p></div></section>`;
  }
  const sourceValues = Array.isArray(snapshot?.sources) && snapshot.sources.length
    ? snapshot.sources
    : [snapshot?.source, snapshot?.sourceLabel].filter(Boolean);
  const sourceNames = [...new Set(sourceValues.map(value => {
    const text = String(value || '').toLocaleLowerCase();
    if (/weatherapi/.test(text)) return 'WeatherAPI';
    if (/msn|bing/.test(text)) return 'MSN 天气';
    return String(value || '').trim();
  }).filter(Boolean))];
  return {
    title: '气象预警',
    locationName: location.name,
    alertCount: String(alerts.length),
    alertCountLabel: historical ? `历史快照：${alerts.length} 条` : `当前生效：${alerts.length} 条`,
    updatedAt,
    scopeNote,
    warningCardsHtml: cardsHtml,
    sourceNote: `数据来源：${sourceNames.length ? sourceNames.join('、') : '未获取到'} · 气象预警请以官方发布为准。`,
  };
}

export function weatherView(data, theme = 'ocean', alertSnapshot = null, now = new Date()) {
  // Keep provider payloads available to callers for diagnostics without passing them
  // through the HTML renderer's template context.
  const { providerData: _providerData, ...templateData } = data;
  const themeName = ['ocean', 'sunset', 'night'].includes(theme) ? theme : 'ocean';
  const days = Array.isArray(data.days) ? data.days : [];
  const hourly = Array.isArray(data.hourly) ? data.hourly : [];
  const alerts = Array.isArray(alertSnapshot?.alerts) ? alertSnapshot.alerts : [];
  const currentAlert = alerts[0];
  const alertClass = currentAlert ? 'has-weather-alert' : '';
  const alertHtml = currentAlert ? alertBannerHtml(currentAlert, alerts.length - 1) : '';
    const alertStatusNote = alertSnapshot?.status === 'timeout'
      ? ' · 预警查询超时，稍后可重试'
      : alertSnapshot?.status === 'unavailable'
        ? ' · 预警查询暂不可用' : alertSnapshot?.status === 'unsupported' ? ' · 当前地区暂不支持预警查询' : '';
  const daysHtml = days.map((day, index) => `<div class="day ${index === 0 ? 'today' : ''}">
    <div class="day-name">${escapeHtml(day.name)}</div>
    <svg class="wxicon" aria-hidden="true"><use href="#${iconName(day.icon)}"/></svg>
    <div class="day-temp"><strong class="day-high">${degree(day.high)}</strong><span class="day-low">${degree(day.low)}</span></div>
  </div>`).join('');
  const hoursHtml = hourly.map(hour => `<div class="hour"><span class="hour-time">${escapeHtml(hour.time)}</span></div>`).join('');

  return {
    ...templateData,
    icon: iconName(data.icon),
    temperature: data.temperature ?? '—',
    highText: degree(data.high), lowText: degree(data.low),
    humidityText: data.humidity === '—' ? '—' : `${data.humidity}%`,
    dewPointText: degree(data.dewPoint),
    themeClass: `theme-${themeName}`,
    weatherAlertClass: alertClass,
    weatherAlertHtml: alertHtml,
    sourceNote: `${data.sourceNote || ''}${alertStatusNote}`,
    aqiClass: statusClass(data.aqi, [50, 100]),
    uvClass: statusClass(data.uv, [2, 5]),
    daysHtml,
    hoursHtml: hoursHtml || '<div class="hour-empty">暂无时间数据</div>',
    hourCount: Math.max(1, hourly.length),
    chartHtml: buildHourlyChart(hourly),
    nearPrecipitationText: precipitationText(data, now),
  };
}
