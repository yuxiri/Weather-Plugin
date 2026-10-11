const numberOrNull = value => {
  if (value == null || value === '' || value === '—') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const probabilityOrNull = value => {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return null;
  const probability = numberOrNull(value);
  return probability != null && probability >= 0 && probability <= 100 ? probability : null;
};

export const DEFAULT_RAIN_ALERT_THRESHOLD = 70;

const OPEN_METEO_PRECIPITATION_CODES = new Map([
  [51, { type: 'rain', intensity: 'light', special: true }],
  [53, { type: 'rain', intensity: 'moderate', special: true }],
  [55, { type: 'rain', intensity: 'unknown', special: true }],
  [56, { type: 'rain', intensity: 'light', special: true }],
  [57, { type: 'rain', intensity: 'unknown', special: true }],
  [61, { type: 'rain', intensity: 'light' }],
  [63, { type: 'rain', intensity: 'moderate' }],
  [65, { type: 'rain', intensity: 'heavy' }],
  [66, { type: 'rain', intensity: 'light', special: true }],
  [67, { type: 'rain', intensity: 'heavy', special: true }],
  [71, { type: 'snow', intensity: 'light' }],
  [73, { type: 'snow', intensity: 'moderate' }],
  [75, { type: 'snow', intensity: 'heavy' }],
  [77, { type: 'snow', intensity: 'unknown', special: true }],
  [80, { type: 'rain', intensity: 'light', special: true }],
  [81, { type: 'rain', intensity: 'moderate', special: true }],
  [82, { type: 'rain', intensity: 'heavy', special: true }],
  [85, { type: 'snow', intensity: 'light', special: true }],
  [86, { type: 'snow', intensity: 'heavy', special: true }],
]);

const WEATHERAPI_PRECIPITATION_CODES = new Map([
  [1063, { type: 'rain', intensity: 'unknown', special: true }],
  [1066, { type: 'snow', intensity: 'unknown', special: true }],
  [1069, { type: 'mixed', intensity: 'unknown', special: true }],
  [1072, { type: 'rain', intensity: 'unknown', special: true }],
  [1087, { type: 'unknown', intensity: 'unknown', special: true }],
  [1114, { type: 'snow', intensity: 'unknown', special: true }],
  [1117, { type: 'snow', intensity: 'heavy' }],
  [1150, { type: 'rain', intensity: 'light', special: true }],
  [1153, { type: 'rain', intensity: 'light', special: true }],
  [1168, { type: 'rain', intensity: 'light', special: true }],
  [1171, { type: 'rain', intensity: 'heavy', special: true }],
  [1180, { type: 'rain', intensity: 'light' }],
  [1183, { type: 'rain', intensity: 'light' }],
  [1186, { type: 'rain', intensity: 'moderate' }],
  [1189, { type: 'rain', intensity: 'moderate' }],
  [1192, { type: 'rain', intensity: 'heavy' }],
  [1195, { type: 'rain', intensity: 'heavy' }],
  [1198, { type: 'rain', intensity: 'light', special: true }],
  [1201, { type: 'rain', intensity: 'unknown', special: true }],
  [1204, { type: 'mixed', intensity: 'unknown', special: true }],
  [1207, { type: 'mixed', intensity: 'unknown', special: true }],
  [1210, { type: 'snow', intensity: 'light' }],
  [1213, { type: 'snow', intensity: 'light' }],
  [1216, { type: 'snow', intensity: 'moderate' }],
  [1219, { type: 'snow', intensity: 'moderate' }],
  [1222, { type: 'snow', intensity: 'heavy' }],
  [1225, { type: 'snow', intensity: 'heavy' }],
  [1237, { type: 'unknown', intensity: 'unknown', special: true }],
  [1240, { type: 'rain', intensity: 'light', special: true }],
  [1243, { type: 'rain', intensity: 'unknown', special: true }],
  [1246, { type: 'rain', intensity: 'heavy', special: true }],
  [1249, { type: 'mixed', intensity: 'unknown', special: true }],
  [1252, { type: 'mixed', intensity: 'unknown', special: true }],
  [1255, { type: 'snow', intensity: 'light', special: true }],
  [1258, { type: 'snow', intensity: 'unknown', special: true }],
  [1261, { type: 'unknown', intensity: 'unknown', special: true }],
  [1264, { type: 'unknown', intensity: 'unknown', special: true }],
  [1273, { type: 'rain', intensity: 'light', special: true }],
  [1276, { type: 'rain', intensity: 'unknown', special: true }],
  [1279, { type: 'snow', intensity: 'light', special: true }],
  [1282, { type: 'snow', intensity: 'unknown', special: true }],
]);

function precipitationTypeFromText(text) {
  if (/雨夹雪|雨雪|雪.*雨|雨.*雪|\bsleet\b|\bwintry mix\b|\bmixed precipitation\b/i.test(text)) return 'mixed';
  if (/雪|\bsnow\b|\bblizzard\b/i.test(text)) return 'snow';
  if (/雨|\brain\b|\bdrizzle\b|\b雷阵雨\b|\brain.*thunder\b|\bthunder.*rain\b/i.test(text)) return 'rain';
  return 'unknown';
}

function precipitationIntensityFromText(text, type) {
  if (type === 'rain') {
    if (/(?:小雨|中雨|大雨|暴雨).*(?:到|转).*(?:小雨|中雨|大雨|暴雨)|\b(?:light|slight|moderate)\s+to\s+(?:moderate|heavy)\s+(?:freezing\s+)?rain\b|\bmoderate\s+or\s+heavy\s+(?:freezing\s+)?rain\b/i.test(text)) return 'unknown';
    if (/小雨|小冻雨|\b(?:light|slight)\s+(?:patchy\s+)?(?:freezing\s+)?rain\b/i.test(text)) return 'light';
    if (/中雨|中冻雨|\bmoderate\s+(?:freezing\s+)?rain\b/i.test(text)) return 'moderate';
    if (/特大暴雨|大暴雨|暴雨|大雨|强降雨|强冻雨|大冻雨|\bheavy\s+(?:freezing\s+)?rain\b|\btorrential\s+rain\b|\brainstorm\b/i.test(text)) return 'heavy';
  }
  if (type === 'snow') {
    if (/(?:小雪|中雪|大雪|暴雪).*(?:到|转).*(?:小雪|中雪|大雪|暴雪)|\b(?:light|slight|moderate)\s+to\s+(?:moderate|heavy)\s+snow\b|\bmoderate\s+or\s+heavy\s+snow\b/i.test(text)) return 'unknown';
    if (/小雪|\b(?:light|slight)\s+(?:patchy\s+)?snow\b/i.test(text)) return 'light';
    if (/中雪|\bmoderate\s+snow\b/i.test(text)) return 'moderate';
    if (/特大暴雪|大暴雪|暴雪|大雪|强降雪|\bheavy\s+snow\b|\bblizzard\b|\bsnowstorm\b/i.test(text)) return 'heavy';
  }
  return 'unknown';
}

/** Normalize explicit precipitation type/intensity without using probability or temperature. */
export function classifyPrecipitation(condition = '', { source = '', code = null, rainAmount = null, snowAmount = null } = {}) {
  const text = String(condition || '').trim();
  const normalizedSource = String(source || '').toLowerCase();
  const numericCode = Number(code);
  const codeProfile = normalizedSource === 'open-meteo'
    ? OPEN_METEO_PRECIPITATION_CODES.get(numericCode)
    : normalizedSource === 'weatherapi' ? WEATHERAPI_PRECIPITATION_CODES.get(numericCode) : null;
  const textType = precipitationTypeFromText(text);
  const hasRainAmount = Number.isFinite(Number(rainAmount)) && Number(rainAmount) > 0;
  const hasSnowAmount = Number.isFinite(Number(snowAmount)) && Number(snowAmount) > 0;
  const amountType = hasRainAmount && hasSnowAmount ? 'mixed' : hasSnowAmount ? 'snow' : hasRainAmount ? 'rain' : 'unknown';
  const codeType = codeProfile?.type && codeProfile.type !== 'unknown' ? codeProfile.type : 'unknown';
  const typeConflict = textType !== 'unknown' && codeType !== 'unknown' && textType !== codeType;
  const precipitationKind = typeConflict ? 'unknown' : textType !== 'unknown' ? textType
    : codeType !== 'unknown' ? codeType : amountType !== 'unknown' ? amountType : 'unknown';
  const textIntensity = precipitationIntensityFromText(text, precipitationKind);
  const codeIntensity = codeProfile?.intensity || 'unknown';
  const intensityConflict = textIntensity !== 'unknown' && codeIntensity !== 'unknown' && textIntensity !== codeIntensity;
  const precipitationIntensity = typeConflict || intensityConflict ? 'unknown'
    : textIntensity !== 'unknown' ? textIntensity : codeIntensity;
  const specialText = /雨夹雪|雨雪|雪.*雨|雨.*雪|\bsleet\b|\bwintry mix\b|\bmixed precipitation\b|阵雨|阵雪|毛毛雨|drizzle|shower|冻雨|冻毛毛雨|freezing|雷|thunder|冰雹|hail|雪粒|snow grains|blowing snow|ice pellets/i.test(text);
  const special = typeConflict || intensityConflict || precipitationKind === 'mixed' || specialText || Boolean(codeProfile?.special);
  const icon = precipitationKind === 'mixed' ? 'sleet'
    : !special && precipitationIntensity !== 'unknown' && precipitationKind === 'rain' ? `rainy-${precipitationIntensity}`
      : !special && precipitationIntensity !== 'unknown' && precipitationKind === 'snow' ? `snowy-${precipitationIntensity}`
        : null;
  return { precipitationKind, precipitationIntensity, icon };
}

function localClockParts(date, timezone) {
  try {
    return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map(part => [part.type, part.value]));
  } catch {
    const iso = date.toISOString();
    return { year: iso.slice(0, 4), month: iso.slice(5, 7), day: iso.slice(8, 10), hour: iso.slice(11, 13), minute: iso.slice(14, 16) };
  }
}

function forecastLocalDateTime(event, timezone) {
  const value = String(event?.dateTime || event?.datetime || '');
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  if (hasOffset) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return null;
    const parts = localClockParts(new Date(timestamp), timezone);
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  }
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)/);
  if (match) return { date: match[1], time: `${match[2]}:${match[3]}` };
  const date = String(event?.date || event?.localDate || '').match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
  const time = String(event?.time || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return date && time ? { date, time: `${time[1]}:${time[2]}` } : null;
}

function localDateTimeTimestamp(local, timezone) {
  if (!local?.date || !local?.time) return NaN;
  const [year, month, day] = local.date.split('-').map(Number);
  const [hour, minute] = local.time.split(':').map(Number);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  // Convert a provider's offset-free local timestamp to an instant in its IANA zone.
  // Iteration also handles half-hour and quarter-hour time zones.
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = localClockParts(new Date(guess), timezone);
    const observed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    const adjustment = wanted - observed;
    guess += adjustment;
    if (adjustment === 0) break;
  }
  return guess;
}

function forecastTimestamp(event, local, timezone) {
  const raw = String(event?.dateTime || event?.datetime || '');
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const timestamp = Date.parse(raw);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return localDateTimeTimestamp(local, timezone);
}

/** Return timestamped hourly forecast rows in the requested future window. */
export function precipitationForecastWindow(weather, now = new Date(), timezone = 'UTC', windowHours = 24) {
  const start = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(start)) return [];
  const end = start + Math.max(0, Number(windowHours) || 0) * 60 * 60 * 1000;
  const rows = Array.isArray(weather?.hourly24) ? weather.hourly24 : [];
  const seen = new Set();
  return rows.map(hour => {
    const local = forecastLocalDateTime(hour, timezone);
    const timestamp = forecastTimestamp(hour, local, timezone);
    return { hour, timestamp, date: local?.date || '', time: local?.time || '' };
  }).filter(row => {
    if (!Number.isFinite(row.timestamp) || row.timestamp <= start || row.timestamp > end || seen.has(row.timestamp)) return false;
    seen.add(row.timestamp);
    return true;
  }).sort((a, b) => a.timestamp - b.timestamp);
}

export function precipitationForecastWindowComplete(rows, now = new Date(), windowHours = 24, maxGapMinutes = 90) {
  const start = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(start) || !Array.isArray(rows) || !rows.length) return false;
  const end = start + Math.max(0, Number(windowHours) || 0) * 60 * 60 * 1000;
  const maxGap = maxGapMinutes * 60 * 1000;
  if (rows[0].timestamp - start > maxGap || end - rows.at(-1).timestamp > maxGap) return false;
  for (let index = 1; index < rows.length; index++) {
    if (rows[index].timestamp - rows[index - 1].timestamp > maxGap) return false;
  }
  return true;
}

function kindMatches(event, type) {
  const condition = String(event?.condition || '');
  const kind = String(event?.precipitationType || '').toLowerCase();
  const sleet = kind === 'sleet' || /雨夹雪|雨雪|雨.*雪|雪.*雨/.test(condition);
  if (type === 'snow') {
    return sleet || kind === 'snow' || /雪/.test(condition)
      || (numberOrNull(event?.snowAmount) ?? 0) > 0;
  }
  return sleet || kind === 'rain' || /雨|雷/.test(condition)
    || (numberOrNull(event?.rainAmount) ?? 0) > 0;
}

export function precipitationSummary(weather, type, now = new Date(), timezone = 'UTC') {
  const hours = precipitationForecastWindow(weather, now, timezone, 24);
  if (type !== 'snow') {
    return hours.find(({ hour }) => {
      const rainChance = probabilityOrNull(hour?.rainProbability);
      if (rainChance != null) return rainChance >= DEFAULT_RAIN_ALERT_THRESHOLD;

      const genericChance = probabilityOrNull(hour?.precipitationProbability ?? hour?.rain);
      return genericChance != null
        && genericChance >= DEFAULT_RAIN_ALERT_THRESHOLD
        && precipKind(hour, '') === 'rain';
    })?.hour || null;
  }

  // Keep the existing snow reminder threshold and type/amount triggers unchanged.
  return hours.find(({ hour }) => {
    const chance = numberOrNull(hour?.snowProbability);
    const amount = numberOrNull(hour?.snowAmount);
    return (chance != null && chance >= 40) || kindMatches(hour, 'snow') || (amount != null && amount > 0);
  })?.hour || null;
}

function precipKind(event, fallbackType) {
  const raw = String(event?.precipitationType || '').toLowerCase();
  if (raw === 'sleet') return 'sleet';
  if (raw === 'rain' || raw === 'snow') return raw;
  const condition = String(event?.condition || '');
  if (/雨夹雪|雨雪|雨.*雪|雪.*雨/.test(condition)) return 'sleet';
  if (/雪/.test(condition)) return 'snow';
  if (/雨|雷/.test(condition)) return 'rain';
  return fallbackType;
}

export function isSleetEvent(event) {
  return precipKind(event, '') === 'sleet';
}

function intensityBand(event, type) {
  const condition = String(event?.condition || '');
  if (/特大暴雨|大暴雨|暴雨|大雨|特大暴雪|大暴雪|暴雪|大雪|强降雨/.test(condition)) return 'heavy';
  if (/中雨|中雪/.test(condition)) return 'moderate';
  if (/小雨|小雪|毛毛雨|零星小雨/.test(condition)) return 'light';
  const amount = numberOrNull(type === 'snow' ? event?.snowAmount : event?.rainAmount);
  if (amount != null) return amount >= 10 ? 'heavy' : amount >= 2 ? 'moderate' : amount > 0 ? 'light' : 'none';
  const chance = numberOrNull(type === 'snow' ? event?.snowProbability : event?.rainProbability);
  if (chance != null) return chance >= 80 ? 'high-chance' : chance >= 60 ? 'medium-chance' : 'low-chance';
  return 'unspecified';
}

export function precipitationEventKey(type, event, timezone = 'UTC') {
  const local = forecastLocalDateTime(event, timezone);
  if (!local) return null;
  const hour = Number(local.time.slice(0, 2));
  const period = Math.floor(hour / 6);
  return `${type}:${local.date}:${period}:${precipKind(event, type)}:${intensityBand(event, type)}`;
}

export function shouldSendPrecipitationAlert(preferences, type, eventKey, now = Date.now()) {
  if (!eventKey) return false;
  const keyField = type === 'snow' ? 'lastSnowAlertKey' : 'lastRainAlertKey';
  const timeField = type === 'snow' ? 'lastSnowAlertAt' : 'lastRainAlertAt';
  if (preferences?.[keyField] === eventKey) return false;
  const failureField = type === 'snow' ? 'snowAlertDeliveryFailure' : 'rainAlertDeliveryFailure';
  const failure = preferences?.[failureField];
  if (failure?.eventKey === eventKey) {
    if (failure.exhausted) return false;
    if (Number(failure.nextAttemptAt) > now) return false;
  }
  // Old preference files only have a timestamp. Honor their existing cooldown once.
  if (!preferences?.[keyField] && Number(preferences?.[timeField]) > 0
    && now - Number(preferences[timeField]) < 8 * 60 * 60 * 1000) return false;
  return true;
}

export function precipitationDeliveryFailure(previous, eventKey, now = Date.now()) {
  const attempts = previous?.eventKey === eventKey ? Math.max(0, Number(previous.attempts) || 0) + 1 : 1;
  const exhausted = attempts >= 3;
  return {
    eventKey,
    attempts,
    nextAttemptAt: exhausted ? null : now + 5 * 60 * 1000 * (2 ** (attempts - 1)),
    exhausted,
    lastFailureAt: now,
  };
}
