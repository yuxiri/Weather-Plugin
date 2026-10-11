import renderer from '../../lib/renderer/loader.js';
import { segment } from 'oicq';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  clearWeatherAlertPlaceMappings,
  freshWeatherAlerts,
  getWeatherAlertCoverageSnapshot,
  getWeatherAlertSnapshot,
  getWeatherAlerts,
  initializeWeatherAlertBackgroundRefresh,
  refreshWeatherAlertPlaceMapping,
} from './lib/alerts.js';
import { getWeather, localDateTime, resolveCity } from './lib/weather.js';
import { SubscriptionStore, subscriptionKey } from './lib/subscriptions.js';
import { WeatherSettingsStore } from './lib/settings.js';
import { ChatPreferencesStore } from './lib/preferences.js';
import {
  isSleetEvent,
  precipitationDeliveryFailure,
  precipitationEventKey,
  precipitationSummary,
  shouldSendPrecipitationAlert,
} from './lib/precipitation.js';
import { precipitationReminderView, weatherView, weatherWarningsView } from './lib/view.js';
import { initializeAdministrativeDivisionUpdates } from './lib/admin-divisions.js';
import { helpImageView } from './lib/help-content.js';
import { parseReportCommand, reportTimePatch } from './lib/report-commands.js';

const store = new SubscriptionStore();
const settingsStore = new WeatherSettingsStore();
const preferencesStore = new ChatPreferencesStore();
const root = fileURLToPath(new URL('./resources/', import.meta.url));
const rendererNamespace = 'weather-plugin';
const rendererFontPath = path.resolve('./temp/html', rendererNamespace, 'MiSansVF.ttf');
const WEATHER_CARD_ALERT_TIMEOUT = 3000;
const WEATHER_IMAGE_CACHE_TTL = 3 * 60 * 1000;
const WEATHER_IMAGE_CACHE_MAX_ITEMS = 40;
const WEATHER_IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const weatherImageCache = new Map();
let weatherImageCacheBytes = 0;
const WARNING_IMAGE_CACHE_TTL = 5 * 60 * 1000;
const WARNING_IMAGE_CACHE_MAX_ITEMS = 40;
const WARNING_IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const warningImageCache = new Map();
let warningImageCacheBytes = 0;
const chat = e => ({ botId: String(e.self_id), type: e.isGroup ? 'group' : 'private', targetId: String(e.isGroup ? e.group_id : e.user_id) });
const weatherSourceName = source => source === 'weatherapi' ? 'WeatherAPI.com' : source === 'bing' ? 'Bing 天气（MSN）' : 'Open-Meteo';
const weatherAlertSourceNote = snapshotOrAlerts => {
  const alerts = Array.isArray(snapshotOrAlerts) ? snapshotOrAlerts
    : Array.isArray(snapshotOrAlerts?.alerts) ? snapshotOrAlerts.alerts : [];
  const candidates = [
    ...(Array.isArray(snapshotOrAlerts?.sources) ? snapshotOrAlerts.sources : []),
    snapshotOrAlerts?.source, snapshotOrAlerts?.sourceLabel,
    ...alerts.flatMap(alert => [alert?.source, alert?.sourceLabel]),
  ];
  const sources = [...new Set(candidates.map(candidate => {
    const value = String(candidate || '').toLocaleLowerCase();
    if (/weatherapi/.test(value)) return 'WeatherAPI';
    if (/msn|bing/.test(value)) return 'MSN 天气';
    return '';
  }).filter(Boolean))];
  return `数据来源：${sources.length ? sources.join('、') : '未获取到'} · 气象预警请以官方发布为准。`;
};
const formatPercent = value => {
  if (value == null || value === '' || value === '—') return '—';
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(Math.min(100, Math.max(0, number)))}%` : '—';
};
const precipitationForecastText = forecast => {
  const rain = forecast?.rainProbability;
  const snow = forecast?.snowProbability;
  if (rain != null || snow != null) return `降雨 ${formatPercent(rain)} / 降雪 ${formatPercent(snow)}`;
  const generic = forecast?.precipitationProbability ?? forecast?.rain;
  if (generic != null) return `降水 ${formatPercent(generic)}`;
  return '降水概率 —';
};
let rendererFontCopy;
async function ensureRendererFont() {
  if (rendererFontCopy) return rendererFontCopy;
  rendererFontCopy = (async () => {
    const source = path.join(root, 'MiSansVF.ttf');
    const sourceStat = await fs.stat(source);
    await fs.mkdir(path.dirname(rendererFontPath), { recursive: true });
    try {
      const targetStat = await fs.stat(rendererFontPath);
      if (targetStat.size === sourceStat.size) return;
    } catch {}
    await fs.copyFile(source, rendererFontPath);
  })();
  try { await rendererFontCopy; }
  finally { rendererFontCopy = null; }
}

async function imageOfWeather(location, weatherSettings = null, theme = 'ocean', weatherData = null) {
  const selectedSettings = weatherSettings || await settingsStore.get();
  let alertTimeout;
  const alertRequest = getWeatherAlertSnapshot(location, fetch, selectedSettings).catch(error => {
    logger.warn(`[天气插件] 天气卡片预警查询失败 ${location.name}`, error);
    return { status: error.code || 'unavailable', alerts: [], fetchedAt: new Date().toISOString() };
  });
  const [data, alertSnapshot] = await Promise.all([
    weatherData ? Promise.resolve(weatherData) : getWeather(location, fetch, selectedSettings),
    Promise.race([
      alertRequest,
      new Promise(resolve => {
        alertTimeout = setTimeout(() => resolve({ status: 'timeout', alerts: [], fetchedAt: new Date().toISOString() }), WEATHER_CARD_ALERT_TIMEOUT);
      }),
    ]).finally(() => clearTimeout(alertTimeout)),
  ]);
  const view = weatherView(data, theme, alertSnapshot);
  const imageKey = createHash('sha256').update(JSON.stringify({ template: 'weather-v1', theme, view })).digest('hex');
  const cachedImage = getCachedWeatherImage(imageKey);
  if (cachedImage) return cachedImage;
  await ensureRendererFont();
  const image = await renderer.render(rendererNamespace, {
    saveId: 'weather', tplFile: path.join(root, 'weather.html'), ...view, imgType: 'png',
  });
  if (image) {
    cacheWeatherImage(imageKey, image);
    return image;
  }
  logger.warn('[天气插件] 天气卡片渲染失败，尝试文字版天气图片');
  return imageOfInfo(`${location.name}天气`, [
    ...weatherWarningLines(alertSnapshot.alerts, location, 1),
    `${data.condition} · 当前 ${data.temperature}°C · 最高 ${data.high}°C / 最低 ${data.low}°C`,
    `风速 ${data.wind} 公里/小时 · 湿度 ${data.humidity}% · ${precipitationForecastText(data.hourly[0])}`,
    `能见度 ${data.visibility} 公里 · 空气质量 ${data.aqi}（${data.aqiNote}）`,
    `日出 ${data.sunrise} · 日落 ${data.sunset}`,
    data.updated,
  ]);
}

function warningImageCacheKey(location, snapshot, scopeNote) {
  const coverage = snapshot?.coverage || {};
  const identity = {
    template: 'warnings-v2', location: location?.name, timezone: location?.timezone,
    fetchedAt: snapshot?.fetchedAt, historical: Boolean(snapshot?.historical), status: snapshot?.status,
    scopeNote, source: snapshot?.source, sources: snapshot?.sources, sourceLabel: snapshot?.sourceLabel,
    coverage: {
      kind: coverage.kind, total: coverage.total, successful: coverage.successful,
      failed: coverage.failed, unqueried: coverage.unqueried, complete: coverage.complete,
    },
    alerts: snapshot?.alerts || [],
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function warningImageSize(image) {
  if (Buffer.isBuffer(image)) return image.length;
  if (typeof image === 'string') return Buffer.byteLength(image);
  if (image && typeof image === 'object') {
    if (Buffer.isBuffer(image.data)) return image.data.length;
    if (typeof image.data === 'string') return Buffer.byteLength(image.data);
  }
  return 0;
}

function getCachedWeatherImage(key) {
  const entry = weatherImageCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    weatherImageCache.delete(key);
    weatherImageCacheBytes -= entry.size;
    return null;
  }
  weatherImageCache.delete(key);
  weatherImageCache.set(key, entry);
  return entry.image;
}

function cacheWeatherImage(key, image) {
  const size = warningImageSize(image);
  if (!size || size > WEATHER_IMAGE_CACHE_MAX_BYTES) return;
  const previous = weatherImageCache.get(key);
  if (previous) weatherImageCacheBytes -= previous.size;
  weatherImageCache.delete(key);
  weatherImageCache.set(key, { image, size, expiresAt: Date.now() + WEATHER_IMAGE_CACHE_TTL });
  weatherImageCacheBytes += size;
  for (const [cacheKey, entry] of weatherImageCache) {
    if (entry.expiresAt <= Date.now()) {
      weatherImageCache.delete(cacheKey);
      weatherImageCacheBytes -= entry.size;
    }
  }
  while (weatherImageCache.size > WEATHER_IMAGE_CACHE_MAX_ITEMS || weatherImageCacheBytes > WEATHER_IMAGE_CACHE_MAX_BYTES) {
    const oldest = weatherImageCache.keys().next().value;
    if (oldest == null) break;
    weatherImageCacheBytes -= weatherImageCache.get(oldest)?.size || 0;
    weatherImageCache.delete(oldest);
  }
}

function getCachedWarningImage(key) {
  const entry = warningImageCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    warningImageCache.delete(key);
    warningImageCacheBytes -= entry.size;
    return null;
  }
  warningImageCache.delete(key);
  warningImageCache.set(key, entry);
  return entry.image;
}

function cacheWarningImage(key, image) {
  const size = warningImageSize(image);
  if (!size || size > WARNING_IMAGE_CACHE_MAX_BYTES) return;
  const previous = warningImageCache.get(key);
  if (previous) warningImageCacheBytes -= previous.size;
  warningImageCache.delete(key);
  warningImageCache.set(key, { image, size, expiresAt: Date.now() + WARNING_IMAGE_CACHE_TTL });
  warningImageCacheBytes += size;
  for (const [cacheKey, entry] of warningImageCache) {
    if (entry.expiresAt <= Date.now()) {
      warningImageCache.delete(cacheKey);
      warningImageCacheBytes -= entry.size;
    }
  }
  while (warningImageCache.size > WARNING_IMAGE_CACHE_MAX_ITEMS || warningImageCacheBytes > WARNING_IMAGE_CACHE_MAX_BYTES) {
    const oldest = warningImageCache.keys().next().value;
    if (oldest == null) break;
    warningImageCacheBytes -= warningImageCache.get(oldest)?.size || 0;
    warningImageCache.delete(oldest);
  }
}

async function imageOfWarnings(location, snapshot, scopeNote = '') {
  const cacheKey = warningImageCacheKey(location, snapshot, scopeNote);
  const cached = getCachedWarningImage(cacheKey);
  if (cached) return { image: cached, cacheHit: true, renderMs: 0 };
  await ensureRendererFont();
  const renderStarted = performance.now();
  const image = await renderer.render(rendererNamespace, {
    saveId: 'warnings', tplFile: path.join(root, 'warnings.html'),
    ...weatherWarningsView(location, snapshot, scopeNote), imgType: 'png',
  });
  if (!image) throw new Error('气象预警图片渲染失败，请确认图片渲染器可用');
  cacheWarningImage(cacheKey, image);
  return { image, cacheHit: false, renderMs: performance.now() - renderStarted };
}

async function imageOfInfo(title, lines, sourceNote = null) {
  await ensureRendererFont();
  const weatherSettings = await settingsStore.get();
  const image = await renderer.render(rendererNamespace, {
    saveId: 'info', tplFile: path.join(root, 'info.html'), title, lines,
    sourceNote: sourceNote || `天气数据由 ${weatherSourceName(weatherSettings.source)} 提供`,
    imgType: 'png',
  });
  if (!image) throw new Error('图片渲染失败，请确认机器人的图片渲染器可用');
  return image;
}

async function imageOfPrecipitationReminder(location, weather, event, weatherSettings) {
  await ensureRendererFont();
  const image = await renderer.render(rendererNamespace, {
    saveId: 'precipitation-reminder', tplFile: path.join(root, 'precipitation.html'),
    ...precipitationReminderView(location, weather, event, weatherSettings.source), imgType: 'png',
  });
  if (!image) throw new Error('降水提醒图片渲染失败，请确认图片渲染器可用');
  return image;
}

async function imageOfHelp(type = 'usage', isMaster = false) {
  await ensureRendererFont();
  const isSettings = type === 'settings';
  if (isSettings && !isMaster) throw new Error('高级设置帮助仅机器人主人可查看');
  const view = helpImageView(type);
  const image = await renderer.render(rendererNamespace, {
    saveId: view.saveId,
    tplFile: path.join(root, 'help.html'),
    title: view.title,
    subtitle: view.subtitle,
    footer: view.footer,
    cards: view.cards,
    helpGuide: view.helpGuide,
    showHelpGuide: view.helpGuide.length > 0,
    imgType: 'png',
  });
  if (!image) throw new Error('帮助图片渲染失败');
  return image;
}

async function sendInfo(e, title, lines, sourceNote = null) {
  try { return await e.reply(segment.image(await imageOfInfo(title, lines, sourceNote))); }
  catch (error) { logger.error('[天气插件] 信息卡渲染失败', error); return e.reply(`${title}\n${lines.join('\n')}`); }
}

async function sendError(e, error) {
  logger.error('[天气插件]', error);
  return sendInfo(e, '天气服务暂不可用', [error.message || String(error), '请稍后重试，或发送 #天气帮助 查看用法。']);
}

function canChangeGroup(e) {
  return !e.isGroup || e.isMaster || e.member?.is_owner || e.member?.is_admin;
}

function parseSubscribeArg(arg) {
  const parts = arg.trim().split(/\s+/);
  let time = '07:00';
  if (parts.at(-1)?.includes(':')) {
    const value = parts.pop();
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('推送时间格式应为 HH:mm，例如 07:30');
    const [h, m] = value.split(':');
    time = `${h.padStart(2, '0')}:${m}`;
  }
  const city = parts.join(' ').trim();
  if (!city) throw new Error('请提供城市，例如 #订阅天气 北京 07:30');
  return { city, time };
}

function parseClock(value) {
  const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : null;
}

async function locationForChat(target, preferences = null) {
  const current = preferences || await preferencesStore.get(target);
  if (current.defaultLocation) return current.defaultLocation;
  return (await store.get(subscriptionKey(target)))?.location || null;
}

async function sendToChat(target, message) {
  const result = target.type === 'group'
    ? await Bot.sendGroupMsg(target.botId, target.targetId, message)
    : await Bot.sendFriendMsg(target.botId, target.targetId, message);
  if (result === false || result == null) throw new Error('发送接口没有确认成功');
}

function warningTime(value, timezone) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return value || '未提供';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(timestamp));
  } catch { return value; }
}

function weatherWarningLines(alerts, location, limit = 4) {
  const lines = [];
  for (const alert of alerts.slice(0, limit)) {
    const severity = alert.severity || alert.level || '等级未提供';
    lines.push(`【${alert.kind} · ${severity}】${alert.event || alert.headline}`);
    if (alert.areas) lines.push(`影响范围：${alert.areas}`);
    lines.push(alert.expires
      ? `有效时间：${alert.effective ? warningTime(alert.effective, location.timezone) : '生效时间未提供'} 至 ${warningTime(alert.expires, location.timezone)}`
      : '有效期未提供');
    if (alert.sourceAgency) lines.push(`发布机构：${alert.sourceAgency}`);
    for (const [label, raw] of [['预警说明', alert.description], ['发布机构提示', alert.sourceInstruction], ['防御指南', alert.defenseGuide], ['预警摘要', alert.summary]]) {
      const detail = String(raw || '').replace(/\s+/g, ' ').trim();
      if (detail) {
        lines.push(`${label}：${detail.length > 180 ? `${detail.slice(0, 180)}…` : detail}`);
        break;
      }
    }
  }
  if (alerts.length > limit) lines.push(`另有 ${alerts.length - limit} 条生效预警，发送 #天气预警 查看。`);
  return lines;
}

export class WeatherPanel extends plugin {
  static pushing = false;
  static lastAlertCheck = 0;

  constructor() {
    super({
      name: '天气图片', dsc: '天气查询、订阅与每日图片推送', event: 'message', priority: 5000,
      rule: [
        { reg: '^#?天气帮助$', fnc: 'help' },
        { reg: '^#?天气设置帮助$', fnc: 'settingsHelp' },
        { reg: '^#?(?:设置天气API|添加天气API)(?:\\s+.+)?$', fnc: 'weatherApi' },
        { reg: '^#?(?:绑定城市|默认城市)(?:\\s+.+)?$', fnc: 'bindCity' },
        { reg: '^#?解绑城市$', fnc: 'unbindCity' },
        { reg: '^#?生活指数(?:\\s+.+)?$', fnc: 'lifeIndex' },
        { reg: '^#?(?:24小时天气|24小时预报|逐小时天气)(?:\\s+.+)?$', fnc: 'hourlyForecast' },
        { reg: '^#?天气对比(?:\\s+.+)?$', fnc: 'compareCities' },
        { reg: '^#?天气主题(?:\\s+.+)?$', fnc: 'theme' },
        { reg: '^#?天气提醒$', fnc: 'precipitationAlerts' },
        { reg: '^#?(?:开启降雨提醒|关闭降雨提醒|开启降雪提醒|关闭降雪提醒)$', fnc: 'precipitationAlerts' },
        { reg: '^#?天气预警(?:\\s+.+)?$', fnc: 'weatherWarnings' },
        { reg: '^#?清理天气地点缓存$', fnc: 'clearWeatherPlaceCache' },
        { reg: '^#?刷新天气地点缓存\\s+.+$', fnc: 'refreshWeatherPlaceCache' },
        { reg: '^#?(?:开启预警提醒|关闭预警提醒)$', fnc: 'severeWeatherAlertToggle' },
        { reg: '^#?(?:开启天气早报|设置天气早报|天气早报|关闭天气早报)(?:\\s+.+)?$', fnc: 'morningReport' },
        { reg: '^#?(?:开启天气晚报|设置天气晚报|天气晚报|关闭天气晚报)(?:\\s+.+)?$', fnc: 'eveningReport' },
        { reg: '^#?(?:天气源|天气数据源|切换天气源|切换数据源)(?:\\s+.+)?$', fnc: 'source' },
        { reg: '^#?(?:取消天气订阅|退订天气)$', fnc: 'unsubscribe' },
        { reg: '^#?(?:订阅天气|天气订阅)(?:\\s+.+)?$', fnc: 'subscribe' },
        { reg: '^#?(?:国内天气|国外天气|天气国内|天气国外)(?:\\s+.+)?$', fnc: 'regionalQuery' },
        { reg: '^#?(?:天气|查询天气)(?:\\s+.+)?$', fnc: 'query' },
      ],
      task: { name: '天气每日图片推送', cron: '0 * * * * *', fnc: () => WeatherPanel.pushDaily(), log: false },
    });
    void initializeAdministrativeDivisionUpdates().catch(error => {
      console.warn(`[天气插件] 行政区划初始化失败，查询将继续使用内置数据：${error?.message || error}`);
    });
    void initializeWeatherAlertBackgroundRefresh(fetch, () => settingsStore.get(), {
      onCountyDiagnostic: diagnostic => logger.info(`[天气插件预警地区] ${JSON.stringify(diagnostic)}`),
      onBackgroundRetryError: (error, attempt) => logger.warn(`[天气插件预警后台刷新] 第${attempt}次失败：${error.message || error}`),
      onBackgroundRefreshResult: result => logger.info(`[天气插件预警后台刷新] ${JSON.stringify(result)}`),
    }).then(restored => {
      if (restored) logger.info(`[天气插件] 已恢复 ${restored} 个近期活跃预警地区的后台刷新计划`);
    }).catch(error => logger.warn(`[天气插件] 预警缓存初始化失败：${error?.message || error}`));
  }

  async help(e) {
    try { return await e.reply(segment.image(await imageOfHelp())); }
    catch (error) {
      logger.error('[天气插件] 帮助图片渲染失败', error);
      return e.reply([
        '天气插件 · 使用帮助',
        '#天气 北京 / #24小时天气 北京',
        '#生活指数 北京 / #天气对比 重庆/北京',
        '#天气预警 北京 / #开启预警提醒 / #关闭预警提醒',
        '#天气（使用默认城市）',
        '#绑定城市 重庆 / #解绑城市',
        '#订阅天气 北京 07:30 / #取消天气订阅',
        '#天气提醒 / #开启降雨提醒 / #关闭降雨提醒 / #开启降雪提醒 / #关闭降雪提醒',
        '#开启天气早报 07:00 / #开启天气晚报 20:00',
        '#关闭天气早报 / #关闭天气晚报',
        '#天气主题 ocean',
        '早晚报旧指令 #设置天气早报 / #设置天气晚报 仍兼容。',
      ].join('\n'));
    }
  }

  async settingsHelp(e) {
    if (!e.isMaster) return e.reply('仅机器人主人可查看天气高级设置。');
    try { return await e.reply(segment.image(await imageOfHelp('settings', true))); }
    catch (error) {
      logger.error('[天气插件] 设置帮助图片渲染失败', error);
      const lines = [
        '#天气源 / #切换天气源 bing（支持 bing、open-meteo、weatherapi）',
        '#设置天气API <API Key>',
        '#刷新天气地点缓存 地区 / #清理天气地点缓存',
        'API Key 属于敏感信息，请勿公开。',
      ];
      return e.reply(`天气插件 · 高级设置\n机器人主人专用管理功能\n${lines.join('\n')}`);
    }
  }

  async query(e) {
    const arg = e.msg.replace(/^#?(?:天气|查询天气)/, '').trim();
    const nestedScope = arg.match(/^(国内|国外)\s+(.+)$/);
    const city = nestedScope ? nestedScope[2].trim() : arg;
    const scope = nestedScope?.[1] === '国内' ? 'domestic' : nestedScope?.[1] === '国外' ? 'foreign' : 'any';
    try {
      const target = chat(e);
      const preferences = await preferencesStore.get(target);
      const location = city ? await resolveCity(city, fetch, { scope }) : await locationForChat(target, preferences);
      if (!location) return e.reply('还没有可用的默认城市。发送 #天气 北京 查询，或先发送 #绑定城市 重庆；发送 #天气帮助 查看用法。');
      return await e.reply(segment.image(await imageOfWeather(location, null, preferences.theme)));
    } catch (error) { return sendError(e, error); }
  }

  async regionalQuery(e) {
    const isDomestic = /^#?(?:国内天气|天气国内)/.test(e.msg);
    const city = e.msg.replace(/^#?(?:国内天气|国外天气|天气国内|天气国外)/, '').trim();
    if (!city) return sendInfo(e, '国内 / 国外天气查询', [
      '#国内天气 重庆市铜梁区　支持国内省、市和区县',
      '#国外天气 东京　只查中国境外地点',
      '也可发送 #天气 国内 重庆 / #天气 国外 东京。',
    ]);
    try {
      const target = chat(e);
      const preferences = await preferencesStore.get(target);
      const location = await resolveCity(city, fetch, { scope: isDomestic ? 'domestic' : 'foreign' });
      return await e.reply(segment.image(await imageOfWeather(location, null, preferences.theme)));
    } catch (error) { return sendError(e, error); }
  }

  async bindCity(e) {
    const target = chat(e);
    const arg = e.msg.replace(/^#?(?:绑定城市|默认城市)/, '').trim();
    try {
      const preferences = await preferencesStore.get(target);
      if (!arg) {
        const location = preferences.defaultLocation || (await store.get(subscriptionKey(target)))?.location;
        return sendInfo(e, '默认城市', [
          `当前城市：${location?.name || '未绑定'}`,
          preferences.defaultLocation ? '天气查询、早晚报和预警使用此城市。' : '可发送 #绑定城市 重庆 设置默认城市。',
        ]);
      }
      if (!canChangeGroup(e)) return sendInfo(e, '需要群管理权限', ['仅群主、管理员或机器人主人可设置本群默认城市。']);
      const location = await resolveCity(arg);
      await preferencesStore.set(target, { defaultLocation: location });
      return sendInfo(e, '默认城市已绑定', [`城市：${location.name}（${location.country}）`, '未填写城市的天气查询、早晚报和预警将使用此城市。']);
    } catch (error) { return sendError(e, error); }
  }

  async unbindCity(e) {
    const target = chat(e);
    try {
      if (!canChangeGroup(e)) return sendInfo(e, '需要群管理权限', ['仅群主、管理员或机器人主人可修改本群默认城市。']);
      await preferencesStore.set(target, { defaultLocation: null });
      return sendInfo(e, '默认城市已解除', ['未填写城市时将继续使用天气订阅城市；没有订阅时请在查询指令中填写城市。']);
    } catch (error) { return sendError(e, error); }
  }

  async lifeIndex(e) {
    const arg = e.msg.replace(/^#?生活指数/, '').trim();
    const target = chat(e);
    try {
      const location = arg ? await resolveCity(arg) : await locationForChat(target);
      if (!location) return sendInfo(e, '尚未设置默认城市', ['发送 #绑定城市 重庆，或使用 #生活指数 重庆 查询指定城市。']);
      const weather = await getWeather(location, fetch, await settingsStore.get());
      const lines = [
        `${weather.city} · ${weather.condition} · ${weather.temperature}°C`,
        ...weather.lifeIndices.map(item => `${item.name}：${item.detail}`),
      ];
      return sendInfo(e, `${location.name}生活指数`, lines);
    } catch (error) { return sendError(e, error); }
  }

  async hourlyForecast(e) {
    const arg = e.msg.replace(/^#?(?:24小时天气|24小时预报|逐小时天气)/, '').trim();
    const target = chat(e);
    try {
      const location = arg ? await resolveCity(arg) : await locationForChat(target);
      if (!location) return sendInfo(e, '尚未设置默认城市', ['发送 #绑定城市 重庆，或使用 #24小时天气 重庆 查询指定城市。']);
      const weather = await getWeather(location, fetch, await settingsStore.get());
      const lines = weather.hourly24.map(hour =>
        `${hour.time}　${hour.temp ?? '—'}°C ${hour.condition}　${precipitationForecastText(hour)}`);
      return sendInfo(e, `${location.name}未来24小时`, lines);
    } catch (error) { return sendError(e, error); }
  }

  async compareCities(e) {
    const arg = e.msg.replace(/^#?天气对比/, '').trim();
    const separator = /[\/|、，]/.test(arg)
      ? /[\/|、，]/
      : /,\s*[A-Za-z]{2}$/.test(arg) ? null : /[,\s]+/;
    const cities = separator ? arg.split(separator).map(value => value.trim()).filter(Boolean) : [arg];
    if (cities.length < 2 || cities.length > 4) return sendInfo(e, '城市天气对比', ['请提供 2 至 4 个城市，例如 #天气对比 重庆/北京/上海。']);
    try {
      const weatherSettings = await settingsStore.get();
      const results = await Promise.all(cities.map(async city => {
        const location = await resolveCity(city);
        return { location, weather: await getWeather(location, fetch, weatherSettings) };
      }));
      const lines = results.map(({ location, weather }) => {
        const today = weather.days[0];
        return `${location.name}：${weather.condition} ${weather.temperature}°C · 高 ${today.high}° / 低 ${today.low}° · ${precipitationForecastText(today)}`;
      });
      return sendInfo(e, '城市天气对比', lines);
    } catch (error) { return sendError(e, error); }
  }

  async theme(e) {
    const target = chat(e);
    const arg = e.msg.replace(/^#?天气主题/, '').trim().toLowerCase();
    const themes = new Map([['ocean', ['ocean', '海蓝', '默认']], ['sunset', ['sunset', '暖阳', '日落']], ['night', ['night', '夜间', '暗夜']]]);
    try {
      const preferences = await preferencesStore.get(target);
      if (!arg) return sendInfo(e, '天气卡片主题', [`当前主题：${preferences.theme}`, '可选主题：ocean（海蓝）、sunset（暖阳）、night（夜间）', '发送 #天气主题 sunset 切换主题。']);
      if (!canChangeGroup(e)) return sendInfo(e, '需要群管理权限', ['仅群主、管理员或机器人主人可修改本群天气主题。']);
      const theme = [...themes].find(([, aliases]) => aliases.includes(arg))?.[0];
      if (!theme) return sendInfo(e, '主题名称无效', ['可选 ocean、sunset 或 night。']);
      await preferencesStore.set(target, { theme });
      return sendInfo(e, '天气卡片主题已更新', [`当前主题：${theme}`, '之后的天气查询和订阅图片将使用此主题。']);
    } catch (error) { return sendError(e, error); }
  }

  async precipitationAlerts(e) {
    const target = chat(e);
    const command = e.msg.replace(/^#?/, '');
    try {
      const preferences = await preferencesStore.get(target);
      if (command === '天气提醒') return sendInfo(e, '天气提醒设置', [
        `降雨提醒：${preferences.rainAlerts ? '开启' : '关闭'}`,
        `降雪提醒：${preferences.snowAlerts ? '开启' : '关闭'}`,
        '使用 #开启降雨提醒、#开启降雪提醒 开启；关闭时使用对应的 #关闭 指令。',
      ]);
      if (!canChangeGroup(e)) return sendInfo(e, '需要群管理权限', ['仅群主、管理员或机器人主人可修改本群天气提醒。']);
      const match = command.match(/^(开启|关闭)(降雨|降雪)提醒$/);
      if (!match) return false;
      if (!await locationForChat(target, preferences)) return sendInfo(e, '尚未设置默认城市', ['请先发送 #绑定城市 重庆，再开启降水提醒。']);
      const key = match[2] === '降雨' ? 'rainAlerts' : 'snowAlerts';
      const enabled = match[1] === '开启';
      await preferencesStore.set(target, { [key]: enabled });
      return sendInfo(e, enabled ? `${match[2]}提醒已开启` : `${match[2]}提醒已关闭`, [
        enabled ? '将检查未来24小时预报，并在预报显示可能降水时发送天气提醒。' : '之后不会再发送此类天气提醒。',
      ]);
    } catch (error) { return sendError(e, error); }
  }

  async weatherWarnings(e) {
    const arg = e.msg.replace(/^#?天气预警/, '').trim();
    const target = chat(e);
    const requestStarted = performance.now();
    let locationResolveMs = 0;
    try {
      const preferences = await preferencesStore.get(target);
      const locationStarted = performance.now();
      const location = arg ? await resolveCity(arg) : await locationForChat(target, preferences);
      locationResolveMs = performance.now() - locationStarted;
      if (!location) return sendInfo(e, '需要城市信息', ['发送 #天气预警 北京 查询指定城市，或先发送 #绑定城市 重庆 设置默认城市。']);
      const weatherSettings = await settingsStore.get();
      const snapshot = await getWeatherAlertCoverageSnapshot(arg || location.name, location, fetch, weatherSettings, {
        onCountyDiagnostic: diagnostic => logger.info(`[天气插件预警地区] ${JSON.stringify(diagnostic)}`),
        onBackgroundRetryError: (error, attempt) => logger.warn(`[天气插件预警后台重试] 第${attempt}次失败：${error.message || error}`),
        onBackgroundRefreshResult: result => logger.info(`[天气插件预警后台刷新] ${JSON.stringify(result)}`),
        settingsProvider: () => settingsStore.get(),
      });
      const renderStarted = performance.now();
      const rendered = await imageOfWarnings(location, snapshot, snapshot.scopeNote || '');
      const renderMs = rendered.renderMs ?? performance.now() - renderStarted;
      const actualRequests = snapshot.cacheHit || snapshot.coalesced
        ? { msnPlaceSearch: 0, msnWeatherPage: 0, weatherApi: 0, other: 0 }
        : snapshot.coverage?.requests || { msnPlaceSearch: 0, msnWeatherPage: 0, weatherApi: 0, other: 0 };
      logger.info(`[天气插件性能] 气象预警 ${location.name} ${JSON.stringify({
        cacheHit: Boolean(snapshot.cacheHit), coalesced: Boolean(snapshot.coalesced),
        historical: Boolean(snapshot.historical), imageCacheHit: rendered.cacheHit,
        cacheAgeMs: snapshot.cacheAgeMs || 0,
        coverage: snapshot.coverage ? {
          kind: snapshot.coverage.kind, total: snapshot.coverage.total,
          successful: snapshot.coverage.successful, failed: snapshot.coverage.failed,
          unqueried: snapshot.coverage.unqueried, complete: snapshot.coverage.complete,
          resultCounts: snapshot.coverage.resultCounts,
          requests: actualRequests, realRequests: Object.values(actualRequests).reduce((sum, count) => sum + count, 0),
          failureCounts: snapshot.coverage.failureCounts,
        } : null,
        timings: { ...(snapshot.timings || {}), placeResolveMs: locationResolveMs, renderMs,
          requestTotalMs: Math.round(performance.now() - requestStarted) },
      })}`);
      return await e.reply(segment.image(rendered.image));
    } catch (error) {
      logger.error('[天气插件] 气象预警查询失败', error);
      const unsupported = error.code === 'unsupported';
      return sendInfo(e, unsupported ? '当前地区暂不支持预警查询' : '气象预警服务暂不可用', [
        error.message || String(error),
        '机器人主人可私聊发送 #设置天气API <API Key> 配置备用预警源。',
      ], weatherAlertSourceNote());
    }
  }

  async clearWeatherPlaceCache(e) {
    if (!e.isMaster) return sendInfo(e, '没有清理权限', ['天气地点缓存仅机器人主人可以清理。']);
    try {
      const removed = await clearWeatherAlertPlaceMappings();
      return sendInfo(e, '天气地点缓存已清理', [`已清理 ${removed} 条地点映射、未命中记录和地名解析缓存。`, '该操作不会清理天气预警数据缓存。']);
    } catch (error) { return sendError(e, error); }
  }

  async refreshWeatherPlaceCache(e) {
    if (!e.isMaster) return sendInfo(e, '没有刷新权限', ['强制解析天气地点仅机器人主人可以执行。']);
    const input = e.msg.replace(/^#?刷新天气地点缓存/, '').trim();
    try {
      const result = await refreshWeatherAlertPlaceMapping(input, fetch);
      const coordinates = `${Number(result.latitude).toFixed(5)}, ${Number(result.longitude).toFixed(5)}`;
      return sendInfo(e, '天气地点已强制重新解析', [
        `${result.name}（${result.adminCode}）`,
        `MSN 地点 ID：${result.placeId || '未提供'}`,
        `坐标：${coordinates}`,
        `本次地点搜索请求：${result.requests.length} 次`,
      ]);
    } catch (error) { return sendError(e, error); }
  }

  async severeWeatherAlertToggle(e) {
    const target = chat(e);
    const command = e.msg.replace(/^#?/, '');
    const enabled = command === '开启预警提醒';
    try {
      if (!canChangeGroup(e)) return sendInfo(e, '需要群管理权限', ['仅群主、管理员或机器人主人可修改本群气象预警提醒。']);
      const preferences = await preferencesStore.get(target);
      if (!enabled) {
        await preferencesStore.set(target, { severeAlerts: false });
        return sendInfo(e, '气象预警提醒已关闭', ['本会话不会再收到新发布的气象预警推送。'], weatherAlertSourceNote());
      }

      const location = await locationForChat(target, preferences);
      if (!location) return sendInfo(e, '尚未设置默认城市', ['请先发送 #绑定城市 重庆，或订阅天气后再开启气象预警提醒。']);
      const weatherSettings = await settingsStore.get();
      const currentSnapshot = await getWeatherAlertSnapshot(location, fetch, weatherSettings);
      const current = currentSnapshot.alerts;
      await preferencesStore.set(target, {
        severeAlerts: true,
        lastSevereAlertKeys: current.flatMap(alert => [alert.key, alert.contentKey]).slice(-100),
      });
      return sendInfo(e, '气象预警提醒已开启', [
        `城市：${location.name}`,
        `当前生效预警：${current.length} 条。已有预警已记为已读，后续新预警会推送。`,
        '系统约每 15 分钟检查一次；发送 #天气预警 可查看当前预警。',
      ], weatherAlertSourceNote(currentSnapshot));
    } catch (error) {
      logger.error('[天气插件] 气象预警提醒设置失败', error);
      return sendInfo(e, '气象预警提醒设置失败', [error.message || String(error), '可私聊机器人发送 #设置天气API <API Key> 配置备用预警源。'], weatherAlertSourceNote());
    }
  }

  async morningReport(e) { return this.configureReport(e, 'morning'); }
  async eveningReport(e) { return this.configureReport(e, 'evening'); }

  async configureReport(e, type) {
    const target = chat(e);
    const label = type === 'morning' ? '早报' : '晚报';
    const timeKey = type === 'morning' ? 'morningTime' : 'eveningTime';
    const dateKey = type === 'morning' ? 'lastMorningDate' : 'lastEveningDate';
    const request = parseReportCommand(e.msg, label);
    try {
      const preferences = await preferencesStore.get(target);
      if (request?.action === 'disable') {
        if (!canChangeGroup(e)) return sendInfo(e, '需要群管理权限', ['仅群主、管理员或机器人主人可修改本群天气简报。']);
        await preferencesStore.set(target, { [timeKey]: null, [dateKey]: null });
        return sendInfo(e, `天气${label}已关闭`, ['之后不会再发送此时段的每日天气简报。']);
      }
      if (request?.action === 'status') return sendInfo(e, `天气${label}设置`, [
        `当前状态：${preferences[timeKey] ? `每天 ${preferences[timeKey]}` : '未开启'}`,
        `发送 #开启天气${label} 07:00 设置时间（旧指令 #设置天气${label} 仍可用），发送 #关闭天气${label} 停用。`,
      ]);
      if (request?.action !== 'configure') return false;
      if (!canChangeGroup(e)) return sendInfo(e, '需要群管理权限', ['仅群主、管理员或机器人主人可修改本群天气简报。']);
      const time = parseClock(request.arg);
      if (!time) return sendInfo(e, '时间格式无效', ['请使用 24 小时制 HH:mm，例如 07:30。']);
      if (!await locationForChat(target, preferences)) return sendInfo(e, '尚未设置默认城市', ['请先发送 #绑定城市 重庆，再设置天气早报或晚报。']);
      await preferencesStore.set(target, reportTimePatch(preferences, timeKey, dateKey, time));
      return sendInfo(e, `天气${label}已设置`, [`每天 ${time} 按城市当地时间推送。`]);
    } catch (error) { return sendError(e, error); }
  }

  async source(e) {
    const arg = e.msg.replace(/^#?(?:切换天气源|切换数据源|天气数据源|天气源)/, '').trim();
    try {
      if (!e.isMaster) return sendInfo(e, '没有查看权限', ['天气数据源管理仅机器人主人可用。']);
      const current = await settingsStore.get();
      const currentName = weatherSourceName(current.source);
      if (!arg) {
        return sendInfo(e, '天气数据源', [
          `当前来源：${currentName}`,
          `WeatherAPI 密钥：${current.weatherApiKey ? '已配置' : '未配置'}`,
          '可选来源：Open-Meteo、WeatherAPI、Bing 天气（MSN）',
          '可选值：open-meteo / bing / weatherapi；例如 #切换天气源 bing',
          '全局来源只允许机器人主人修改。',
        ]);
      }
      const key = arg.toLowerCase().replace(/[\s_]/g, '');
      const source = ['open-meteo', 'openmeteo', 'open-meteo.com', 'openmeteo.com'].includes(key)
        ? 'open-meteo'
        : ['weatherapi', 'weatherapi.com'].includes(key) ? 'weatherapi'
          : ['bing', 'bing天气', 'bingweather', 'msn', 'msn天气', 'msnweather'].includes(key) ? 'bing' : null;
      if (!source) return sendInfo(e, '数据源名称无效', ['请使用 #切换天气源 Open-Meteo、WeatherAPI 或 Bing。']);
      if (source === 'weatherapi' && !current.weatherApiKey) {
        return sendInfo(e, '尚未配置 WeatherAPI 密钥', [
          '先申请 WeatherAPI API Key：https://www.weatherapi.com/signup.aspx',
          '然后设置环境变量 WEATHERAPI_KEY，或在机器人框架根目录 data/weather-panel/settings.json 中填写 weatherApiKey。',
          '密钥配置后再发送 #切换天气源 WeatherAPI。',
        ]);
      }
      await settingsStore.setSource(source);
      const selectedName = weatherSourceName(source);
      return sendInfo(e, '天气数据源已切换', [`当前来源：${selectedName}`, '天气查询和每日推送都会使用该来源。']);
    } catch (error) { return sendError(e, error); }
  }

  async weatherApi(e) {
    if (!e.isMaster) return sendInfo(e, '没有设置权限', ['WeatherAPI 密钥属于全局配置，仅机器人主人可以设置。']);
    if (e.isGroup) return sendInfo(e, '请私聊设置天气 API', [
      '为避免密钥出现在群聊，请私聊机器人发送 #设置天气API <API Key>。',
      '群聊中的设置命令不会保存密钥。',
    ]);

    const apiKey = e.msg.replace(/^#?(?:设置天气API|添加天气API)/, '').trim();
    if (!apiKey) {
      const current = await settingsStore.get();
      return sendInfo(e, 'WeatherAPI 密钥设置', [
        `当前状态：${current.weatherApiKey ? '已配置' : '未配置'}`,
        '私聊发送 #设置天气API <API Key> 保存密钥。',
        '保存后发送 #切换天气源 WeatherAPI 使用该来源。',
      ]);
    }

    try {
      await settingsStore.setWeatherApiKey(apiKey);
      return sendInfo(e, 'WeatherAPI 密钥已保存', [
        '密钥已写入机器人框架根目录 data/weather-panel/settings.json。',
        '为保护密钥，回执不会显示密钥内容。',
        '发送 #切换天气源 WeatherAPI 即可使用。',
      ]);
    } catch (error) { return sendError(e, error); }
  }

  async subscribe(e) {
    const arg = e.msg.replace(/^#?(?:订阅天气|天气订阅)/, '').trim();
    const target = chat(e), key = subscriptionKey(target);
    try {
      if (!arg) {
        const sub = await store.get(key);
        return sub
          ? sendInfo(e, '天气订阅', [`城市：${sub.location.name}（${sub.location.country}）`, `每日 ${sub.time} 推送`, `时区：${sub.location.timezone}`, '发送 #取消天气订阅 可关闭推送。'])
          : sendInfo(e, '尚未订阅天气', ['发送 #订阅天气 北京 07:30 开启每日图片推送。']);
      }
      if (!canChangeGroup(e)) return sendInfo(e, '需要群管理权限', ['仅群主、管理员或机器人主人可修改本群天气订阅。']);
      const { city, time } = parseSubscribeArg(arg);
      const location = await resolveCity(city);
      await store.put({ ...target, location, time, lastSentDate: null });
      return sendInfo(e, '天气订阅成功', [`城市：${location.name}（${location.country}）`, `每天 ${time} 按 ${location.timezone} 当地时间推送天气图片。`, '发送 #天气 可立即查看。']);
    } catch (error) { return sendError(e, error); }
  }

  async unsubscribe(e) {
    try {
      if (!canChangeGroup(e)) return sendInfo(e, '需要群管理权限', ['仅群主、管理员或机器人主人可取消本群天气订阅。']);
      const removed = await store.remove(subscriptionKey(chat(e)));
      return sendInfo(e, removed ? '已取消天气订阅' : '尚未订阅天气', [removed ? '当前会话将不再收到每日天气推送。' : '当前会话没有可取消的订阅。']);
    } catch (error) { return sendError(e, error); }
  }

  static async pushDaily() {
    if (WeatherPanel.pushing) return;
    WeatherPanel.pushing = true;
    try {
      const subs = await store.all();
      const preferenceRows = await preferencesStore.all();
      const rows = new Map();
      for (const sub of subs) {
        const target = { botId: String(sub.botId), type: sub.type, targetId: String(sub.targetId) };
        rows.set(subscriptionKey(target), { target, sub, preferences: null });
      }
      for (const preferences of preferenceRows) {
        if (!preferences.chat) continue;
        const target = { botId: String(preferences.chat.botId), type: preferences.chat.type, targetId: String(preferences.chat.targetId) };
        const key = subscriptionKey(target);
        const row = rows.get(key) || { target, sub: null, preferences: null };
        row.preferences = preferences;
        rows.set(key, row);
      }

      const weatherSettings = await settingsStore.get();
      const weatherCache = new Map();
      const weatherFor = location => {
        const key = `${weatherSettings.source}:${location.latitude}:${location.longitude}`;
        if (!weatherCache.has(key)) weatherCache.set(key, getWeather(location, fetch, weatherSettings));
        return weatherCache.get(key);
      };
      const warningCache = new Map();
      const warningsFor = location => {
        const key = `${location.latitude}:${location.longitude}`;
        if (!warningCache.has(key)) warningCache.set(key, getWeatherAlerts(location, fetch, weatherSettings));
        return warningCache.get(key);
      };
      const now = Date.now();
      const checkAlerts = now - WeatherPanel.lastAlertCheck >= 15 * 60 * 1000;
      if (checkAlerts) WeatherPanel.lastAlertCheck = now;

      for (const { target, sub, preferences: savedPreferences } of rows.values()) {
        try {
          if (!Bot.bots?.[target.botId]) continue;
          let preferences = savedPreferences || await preferencesStore.get(target);

          if (sub) {
            const local = localDateTime(sub.location.timezone);
            const currentMinutes = Number(local.time.slice(0, 2)) * 60 + Number(local.time.slice(3));
            const dueMinutes = Number(sub.time.slice(0, 2)) * 60 + Number(sub.time.slice(3));
            if (currentMinutes >= dueMinutes && currentMinutes < dueMinutes + 60 && sub.lastSentDate !== local.date) {
              const weather = await weatherFor(sub.location);
              const image = segment.image(await imageOfWeather(sub.location, weatherSettings, preferences.theme, weather));
              await sendToChat(target, image);
              await store.markSent(subscriptionKey(sub), local.date);
            }
          }

          const location = preferences.defaultLocation || sub?.location;
          if (!location) continue;
          const local = localDateTime(location.timezone);
          const currentMinutes = Number(local.time.slice(0, 2)) * 60 + Number(local.time.slice(3));
          for (const kind of ['morning', 'evening']) {
            const timeKey = kind === 'morning' ? 'morningTime' : 'eveningTime';
            const dateKey = kind === 'morning' ? 'lastMorningDate' : 'lastEveningDate';
            if (!preferences[timeKey] || preferences[dateKey] === local.date) continue;
            const dueMinutes = Number(preferences[timeKey].slice(0, 2)) * 60 + Number(preferences[timeKey].slice(3));
            if (currentMinutes < dueMinutes || currentMinutes >= dueMinutes + 5) continue;
            const weather = await weatherFor(location);
            const day = kind === 'evening' ? weather.days[1] || weather.days[0] : weather.days[0];
            const label = kind === 'evening' ? '明天' : '今天';
            const title = kind === 'evening' ? '天气晚报' : '天气早报';
            const image = segment.image(await imageOfInfo(`${location.name}${title}`, [
              `${label}：${day.condition} · ${day.low ?? '—'}°C 至 ${day.high ?? '—'}°C`,
              precipitationForecastText(day),
              `风速 ${weather.wind} 公里/小时 · 紫外线 ${day.uv ?? weather.uv}`, `日出 ${weather.sunrise} · 日落 ${weather.sunset}`,
            ]));
            await sendToChat(target, image);
            preferences = await preferencesStore.set(target, { [dateKey]: local.date });
          }

          if (!checkAlerts) continue;
          if (preferences.rainAlerts || preferences.snowAlerts) {
            try {
              const weather = await weatherFor(location);
              for (const type of ['rain', 'snow']) {
                const enabled = type === 'rain' ? preferences.rainAlerts : preferences.snowAlerts;
                const timeKey = type === 'rain' ? 'lastRainAlertAt' : 'lastSnowAlertAt';
                const keyField = type === 'rain' ? 'lastRainAlertKey' : 'lastSnowAlertKey';
                const failureField = type === 'rain' ? 'rainAlertDeliveryFailure' : 'snowAlertDeliveryFailure';
                if (!enabled) continue;
                const timezone = weather.timezone || location.timezone;
                const event = precipitationSummary(weather, type, new Date(now), timezone);
                if (!event) continue;
                const sharedSleet = preferences.rainAlerts && preferences.snowAlerts && isSleetEvent(event);
                const eventKey = precipitationEventKey(type, event, timezone);
                if (!shouldSendPrecipitationAlert(preferences, type, eventKey, now)) continue;
                try {
                  const image = segment.image(await imageOfPrecipitationReminder(location, weather, event, weatherSettings));
                  await sendToChat(target, image);
                  const success = { [timeKey]: now, [keyField]: eventKey, [failureField]: null };
                  if (sharedSleet) {
                    const otherType = type === 'rain' ? 'snow' : 'rain';
                    success[otherType === 'snow' ? 'lastSnowAlertAt' : 'lastRainAlertAt'] = now;
                    success[otherType === 'snow' ? 'lastSnowAlertKey' : 'lastRainAlertKey']
                      = precipitationEventKey(otherType, event, timezone);
                    success[otherType === 'snow' ? 'snowAlertDeliveryFailure' : 'rainAlertDeliveryFailure'] = null;
                  }
                  preferences = await preferencesStore.set(target, success);
                } catch (error) {
                  const failure = precipitationDeliveryFailure(preferences[failureField], eventKey, now);
                  const failurePatch = { [failureField]: failure };
                  if (sharedSleet) {
                    const otherType = type === 'rain' ? 'snow' : 'rain';
                    const otherFailureField = otherType === 'snow' ? 'snowAlertDeliveryFailure' : 'rainAlertDeliveryFailure';
                    const otherKey = precipitationEventKey(otherType, event, timezone);
                    failurePatch[otherFailureField] = precipitationDeliveryFailure(preferences[otherFailureField], otherKey, now);
                  }
                  preferences = await preferencesStore.set(target, failurePatch).catch(() => preferences);
                  logger.error(`[天气插件] 降水提醒发送失败 ${type} ${target.type}:${target.targetId}，${failure.attempts}/3 次`, error);
                }
              }
            } catch (error) {
              logger.error(`[天气插件] 降水提醒查询失败 ${target.type}:${target.targetId}`, error);
            }
          }

          if (preferences.severeAlerts) {
            try {
              const alerts = await warningsFor(location);
              const seen = new Set(Array.isArray(preferences.lastSevereAlertKeys) ? preferences.lastSevereAlertKeys : []);
              const fresh = freshWeatherAlerts(alerts, seen);
              if (fresh.length) {
                const image = segment.image(await imageOfInfo(`${location.name}气象预警`, weatherWarningLines(fresh, location), weatherAlertSourceNote(fresh)));
                await sendToChat(target, image);
              }
              const nextSeen = new Set(seen);
              for (const alert of alerts) {
                if (alert.storedLegacyKey) nextSeen.delete(alert.storedLegacyKey);
                nextSeen.add(alert.key);
                nextSeen.add(alert.contentKey);
              }
              const nextKeys = [...nextSeen].slice(-100);
              const previousKeys = Array.isArray(preferences.lastSevereAlertKeys) ? preferences.lastSevereAlertKeys : [];
              if (fresh.length || nextKeys.length !== previousKeys.length || nextKeys.some((key, index) => key !== previousKeys[index])) {
                preferences = await preferencesStore.set(target, { lastSevereAlertKeys: nextKeys });
              }
            } catch (error) {
              logger.error(`[天气插件] 气象预警推送失败 ${target.type}:${target.targetId}`, error);
            }
          }
        } catch (error) { logger.error(`[天气插件] 定时天气任务失败 ${target.type}:${target.targetId}`, error); }
      }
    } catch (error) { logger.error('[天气插件] 读取天气计划失败', error); }
    finally { WeatherPanel.pushing = false; }
  }
}
