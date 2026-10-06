import renderer from '../../lib/renderer/loader.js';
import { segment } from 'oicq';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshWeatherAlerts, getWeather, getWeatherAlerts, localDateTime, resolveCity } from './lib/weather.js';
import { SubscriptionStore, subscriptionKey } from './lib/subscriptions.js';
import { WeatherSettingsStore } from './lib/settings.js';
import { ChatPreferencesStore } from './lib/preferences.js';
import { weatherView } from './lib/view.js';

const store = new SubscriptionStore();
const settingsStore = new WeatherSettingsStore();
const preferencesStore = new ChatPreferencesStore();
const root = fileURLToPath(new URL('./resources/', import.meta.url));
const rendererNamespace = 'yunzai-weather-plugin';
const rendererFontPath = path.resolve('./temp/html', rendererNamespace, 'MiSansVF.ttf');
const chat = e => ({ botId: String(e.self_id), type: e.isGroup ? 'group' : 'private', targetId: String(e.isGroup ? e.group_id : e.user_id) });
const weatherSourceName = source => source === 'weatherapi' ? 'WeatherAPI.com' : source === 'bing' ? 'Bing 天气（MSN）' : 'Open-Meteo';
const weatherAlertSourceNote = '气象预警来源：Bing/MSN 页面预警数据，WeatherAPI 可备用';
const helpCards = [
  {
    tone: 'blue', icon: 'search', title: '查询天气', subtitle: '查询指定城市或区县的当前天气',
    rows: [
      { command: '#天气 北京', note: '查询北京天气' },
      { command: '#查询天气 东京', note: '也可直接查询任意城市' },
    ],
    examples: ['区县示例：#天气 渝中区,重庆'],
  },
  {
    tone: 'purple', icon: 'pin', title: '城市管理', subtitle: '设置或解除默认城市',
    rows: [
      { command: '#绑定城市 重庆', note: '设置默认城市' },
      { command: '#解绑城市', note: '解除默认城市' },
    ],
    examples: ['绑定后，不带城市的查询会使用默认城市'],
  },
  {
    tone: 'green', icon: 'leaf', title: '生活指数', subtitle: '查看出行、穿衣、防晒等生活建议',
    rows: [{ command: '#生活指数 北京', note: '城市可省略，使用默认城市' }],
    tags: ['穿衣', '出行', '防晒', '感冒', '洗车'],
  },
  {
    tone: 'orange', icon: 'clock', title: '24小时预报', subtitle: '查看未来逐小时天气变化',
    rows: [{ command: '#24小时预报 北京', note: '城市可省略，使用默认城市' }],
    examples: ['包含气温、天气状况及雨雪概率'],
  },
  {
    tone: 'pink', icon: 'calendar', title: '天气早报 / 晚报', subtitle: '按设定时间接收每日天气图片',
    rows: [
      { command: '#设置天气早报 07:00', note: '设置早报时间' },
      { command: '#设置天气晚报 20:00', note: '设置晚报时间' },
    ],
    examples: ['#关闭天气早报 / #关闭天气晚报'],
  },
  {
    tone: 'cyan', icon: 'chart', title: '城市天气对比', subtitle: '并排查看多个城市的天气',
    rows: [{ command: '#天气对比 重庆/北京/上海', note: '支持 2 至 4 个城市' }],
    examples: ['示例：#天气对比 北京/东京'],
  },
  {
    tone: 'violet', icon: 'bell', title: '天气提醒与预警', subtitle: '分别设置降水提醒和官方气象预警',
    rows: [
      { command: '#开启降雨提醒 / #开启降雪提醒', note: '按未来预报提醒' },
      { command: '#天气预警 重庆', note: '查询当前官方预警' },
      { command: '#开启预警提醒 / #关闭预警提醒', note: '新预警每条推送一次' },
      { command: '#天气提醒', note: '查看降水提醒状态' },
    ],
    examples: ['雷暴、暴雨、大雾、大风、台风等；MSN 数据可用时无需 API Key'],
  },
  {
    tone: 'rose', icon: 'send', title: '订阅天气', subtitle: '定时推送每日天气图片',
    rows: [
      { command: '#订阅天气 北京 07:30', note: '每天推送' },
      { command: '#取消天气订阅', note: '取消推送' },
    ],
    examples: ['不填时间时，默认每天 07:00 推送'],
  },
];

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
  await ensureRendererFont();
  const selectedSettings = weatherSettings || await settingsStore.get();
  const data = weatherData || await getWeather(location, fetch, selectedSettings);
  const image = await renderer.render(rendererNamespace, {
    saveId: 'weather', tplFile: path.join(root, 'weather.html'), ...weatherView(data, theme), imgType: 'png',
  });
  if (image) return image;
  logger.warn('[天气插件] 天气卡片渲染失败，尝试文字版天气图片');
  return imageOfInfo(`${location.name}天气`, [
    `${data.condition} · 当前 ${data.temperature}°C · 最高 ${data.high}°C / 最低 ${data.low}°C`,
    `风速 ${data.wind} 公里/小时 · 湿度 ${data.humidity}% · 降水概率 ${data.hourly[0]?.rain ?? '—'}%`,
    `能见度 ${data.visibility} 公里 · 空气质量 ${data.aqi}（${data.aqiNote}）`,
    `日出 ${data.sunrise} · 日落 ${data.sunset}`,
    data.updated,
  ]);
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

async function imageOfHelp() {
  await ensureRendererFont();
  const image = await renderer.render(rendererNamespace, {
    saveId: 'help', tplFile: path.join(root, 'help.html'), cards: helpCards, imgType: 'png',
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

function precipitationSummary(weather, type) {
  const probabilityKey = type === 'snow' ? 'snowProbability' : 'rainProbability';
  const conditionRe = type === 'snow' ? /雪/ : /雨|雷/;
  const threshold = type === 'snow' ? 40 : 60;
  return weather.hourly24?.find(hour => (hour[probabilityKey] ?? 0) >= threshold || conditionRe.test(hour.condition || '') || (type === 'snow' && (hour.snowAmount ?? 0) > 0));
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
    lines.push(`【${alert.kind} · ${alert.severity}】${alert.headline || alert.event}`);
    if (alert.areas) lines.push(`影响范围：${alert.areas}`);
    lines.push(`有效时间：${warningTime(alert.effective, location.timezone)} 至 ${warningTime(alert.expires, location.timezone)}`);
    const detail = String(alert.description || '').replace(/\s+/g, ' ').trim();
    if (detail) lines.push(`预警说明：${detail.length > 180 ? `${detail.slice(0, 180)}…` : detail}`);
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
        { reg: '^#?(?:24小时预报|逐小时天气)(?:\\s+.+)?$', fnc: 'hourlyForecast' },
        { reg: '^#?天气对比(?:\\s+.+)?$', fnc: 'compareCities' },
        { reg: '^#?天气主题(?:\\s+.+)?$', fnc: 'theme' },
        { reg: '^#?天气提醒$', fnc: 'precipitationAlerts' },
        { reg: '^#?(?:开启降雨提醒|关闭降雨提醒|开启降雪提醒|关闭降雪提醒)$', fnc: 'precipitationAlerts' },
        { reg: '^#?天气预警(?:\\s+.+)?$', fnc: 'weatherWarnings' },
        { reg: '^#?(?:开启预警提醒|关闭预警提醒)$', fnc: 'severeWeatherAlertToggle' },
        { reg: '^#?(?:天气早报|设置天气早报|关闭天气早报)(?:\\s+.+)?$', fnc: 'morningReport' },
        { reg: '^#?(?:天气晚报|设置天气晚报|关闭天气晚报)(?:\\s+.+)?$', fnc: 'eveningReport' },
        { reg: '^#?(?:天气源|天气数据源|切换天气源|切换数据源)(?:\\s+.+)?$', fnc: 'source' },
        { reg: '^#?(?:取消天气订阅|退订天气)$', fnc: 'unsubscribe' },
        { reg: '^#?(?:订阅天气|天气订阅)(?:\\s+.+)?$', fnc: 'subscribe' },
        { reg: '^#?(?:天气|查询天气)(?:\\s+.+)?$', fnc: 'query' },
      ],
      task: { name: '天气每日图片推送', cron: '0 * * * * *', fnc: () => WeatherPanel.pushDaily(), log: false },
    });
  }

  async help(e) {
    try { return await e.reply(segment.image(await imageOfHelp())); }
    catch (error) {
      logger.error('[天气插件] 帮助图片渲染失败', error);
      return e.reply('天气插件帮助\n#天气 北京 / #查询天气 东京　查询城市或区县天气\n#绑定城市 重庆 / #解绑城市　设置或解除默认城市\n#生活指数 北京　查看生活建议\n#24小时预报 北京　查看未来逐小时天气\n#天气对比 重庆/北京/上海　对比多个城市\n#开启降雨提醒 / #开启降雪提醒　开启天气提醒\n#天气预警 北京　查询当前生效的气象预警\n#开启预警提醒 / #关闭预警提醒　每条新预警推送一次\n#订阅天气 北京 07:30 / #取消天气订阅　每日推送或取消\n#天气主题 ocean　切换卡片主题\n#天气设置帮助　查看数据源、早晚报和 API 设置');
    }
  }

  async settingsHelp(e) {
    return sendInfo(e, '天气设置帮助', [
      '#天气源　查看当前天气数据源',
      '#切换天气源 open-meteo/bing/weatherapi　切换全局数据源（仅机器人主人）',
      '私聊 #设置天气API <API Key>　配置 WeatherAPI（仅机器人主人）',
      '#设置天气早报 07:00 / #设置天气晚报 20:00　设置每日简报时间',
      '#关闭天气早报 / #关闭天气晚报　关闭对应简报',
      '#天气提醒　查看降雨、降雪提醒状态',
      '#开启降雨提醒 / #开启降雪提醒　开启天气提醒',
      '#关闭降雨提醒 / #关闭降雪提醒　关闭对应天气提醒',
      '#天气预警 北京　查看当前生效的政府气象预警',
      '#开启预警提醒 / #关闭预警提醒　新预警每条推送一次',
      '优先读取 Bing/MSN 预警信息；可设置 WeatherAPI API Key 作为备用。',
      '群内修改默认城市、主题、简报和提醒需群管理员权限。',
    ]);
  }

  async query(e) {
    const arg = e.msg.replace(/^#?(?:天气|查询天气)/, '').trim();
    try {
      const target = chat(e);
      const preferences = await preferencesStore.get(target);
      const location = arg ? await resolveCity(arg) : await locationForChat(target, preferences);
      if (!location) return this.help(e);
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
    const arg = e.msg.replace(/^#?(?:24小时预报|逐小时天气)/, '').trim();
    const target = chat(e);
    try {
      const location = arg ? await resolveCity(arg) : await locationForChat(target);
      if (!location) return sendInfo(e, '尚未设置默认城市', ['发送 #绑定城市 重庆，或使用 #24小时预报 重庆 查询指定城市。']);
      const weather = await getWeather(location, fetch, await settingsStore.get());
      const lines = weather.hourly24.map(hour =>
        `${hour.time}　${hour.temp ?? '—'}°C ${hour.condition}　雨 ${hour.rainProbability ?? '—'}% / 雪 ${hour.snowProbability ?? '—'}%`);
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
        return `${location.name}：${weather.condition} ${weather.temperature}°C · 高 ${today.high}° / 低 ${today.low}° · 雨 ${today.rainProbability ?? '—'}% / 雪 ${today.snowProbability ?? '—'}%`;
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
    try {
      const preferences = await preferencesStore.get(target);
      const location = arg ? await resolveCity(arg) : await locationForChat(target, preferences);
      if (!location) return sendInfo(e, '需要城市信息', ['发送 #天气预警 北京 查询指定城市，或先发送 #绑定城市 重庆 设置默认城市。']);
      const weatherSettings = await settingsStore.get();
      const alerts = await getWeatherAlerts(location, fetch, weatherSettings);
      if (!alerts.length) return sendInfo(e, `${location.name}气象预警`, [
        '当前没有检测到生效中的政府气象预警。',
        '数据源覆盖地区内的雷暴、暴雨、大雾、大风、台风等预警会在此显示。',
      ], weatherAlertSourceNote);
      return sendInfo(e, `${location.name}气象预警`, weatherWarningLines(alerts, location), weatherAlertSourceNote);
    } catch (error) {
      logger.error('[天气插件] 气象预警查询失败', error);
      return sendInfo(e, '气象预警服务暂不可用', [error.message || String(error), '机器人主人可私聊发送 #设置天气API <API Key> 配置备用预警源。'], weatherAlertSourceNote);
    }
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
        return sendInfo(e, '气象预警提醒已关闭', ['本会话不会再收到新发布的气象预警推送。'], weatherAlertSourceNote);
      }

      const location = await locationForChat(target, preferences);
      if (!location) return sendInfo(e, '尚未设置默认城市', ['请先发送 #绑定城市 重庆，或订阅天气后再开启气象预警提醒。']);
      const weatherSettings = await settingsStore.get();
      const current = await getWeatherAlerts(location, fetch, weatherSettings);
      await preferencesStore.set(target, {
        severeAlerts: true,
        lastSevereAlertKeys: current.flatMap(alert => [alert.key, alert.contentKey]).slice(-100),
      });
      return sendInfo(e, '气象预警提醒已开启', [
        `城市：${location.name}`,
        `当前生效预警：${current.length} 条。已有预警已记为已读，后续新预警会推送。`,
        '系统约每 15 分钟检查一次；发送 #天气预警 可查看当前预警。',
      ], weatherAlertSourceNote);
    } catch (error) {
      logger.error('[天气插件] 气象预警提醒设置失败', error);
      return sendInfo(e, '气象预警提醒设置失败', [error.message || String(error), '可私聊机器人发送 #设置天气API <API Key> 配置备用预警源。'], weatherAlertSourceNote);
    }
  }

  async morningReport(e) { return this.configureReport(e, 'morning'); }
  async eveningReport(e) { return this.configureReport(e, 'evening'); }

  async configureReport(e, type) {
    const target = chat(e);
    const label = type === 'morning' ? '早报' : '晚报';
    const timeKey = type === 'morning' ? 'morningTime' : 'eveningTime';
    const dateKey = type === 'morning' ? 'lastMorningDate' : 'lastEveningDate';
    const command = e.msg.replace(/^#?/, '');
    try {
      const preferences = await preferencesStore.get(target);
      if (command === `关闭天气${label}`) {
        if (!canChangeGroup(e)) return sendInfo(e, '需要群管理权限', ['仅群主、管理员或机器人主人可修改本群天气简报。']);
        await preferencesStore.set(target, { [timeKey]: null, [dateKey]: null });
        return sendInfo(e, `天气${label}已关闭`, ['之后不会再发送此时段的每日天气简报。']);
      }
      const arg = e.msg.replace(new RegExp(`^#?(?:设置天气${label}|天气${label})`), '').trim();
      if (!arg) return sendInfo(e, `天气${label}设置`, [
        `当前状态：${preferences[timeKey] ? `每天 ${preferences[timeKey]}` : '未开启'}`,
        `发送 #设置天气${label} 07:00 设置时间，发送 #关闭天气${label} 停用。`,
      ]);
      if (!canChangeGroup(e)) return sendInfo(e, '需要群管理权限', ['仅群主、管理员或机器人主人可修改本群天气简报。']);
      const time = parseClock(arg);
      if (!time) return sendInfo(e, '时间格式无效', ['请使用 24 小时制 HH:mm，例如 07:30。']);
      if (!await locationForChat(target, preferences)) return sendInfo(e, '尚未设置默认城市', ['请先发送 #绑定城市 重庆，再设置天气早报或晚报。']);
      await preferencesStore.set(target, { [timeKey]: time, [dateKey]: null });
      return sendInfo(e, `天气${label}已设置`, [`每天 ${time} 按城市当地时间推送。`]);
    } catch (error) { return sendError(e, error); }
  }

  async source(e) {
    const arg = e.msg.replace(/^#?(?:切换天气源|切换数据源|天气数据源|天气源)/, '').trim();
    try {
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
      if (!e.isMaster) return sendInfo(e, '没有切换权限', ['天气数据源是全局设置，仅机器人主人可以切换。']);

      const key = arg.toLowerCase().replace(/[\s_]/g, '');
      const source = ['open-meteo', 'openmeteo', 'open-meteo.com', 'openmeteo.com'].includes(key)
        ? 'open-meteo'
        : ['weatherapi', 'weatherapi.com'].includes(key) ? 'weatherapi'
          : ['bing', 'bing天气', 'bingweather', 'msn', 'msn天气', 'msnweather'].includes(key) ? 'bing' : null;
      if (!source) return sendInfo(e, '数据源名称无效', ['请使用 #切换天气源 Open-Meteo、WeatherAPI 或 Bing。']);
      if (source === 'weatherapi' && !current.weatherApiKey) {
        return sendInfo(e, '尚未配置 WeatherAPI 密钥', [
          '先申请 WeatherAPI API Key：https://www.weatherapi.com/signup.aspx',
          '然后设置环境变量 WEATHERAPI_KEY，或在 Yunzai 根目录 data/weather-panel/settings.json 中填写 weatherApiKey。',
          '密钥配置后再发送 #切换天气源 WeatherAPI。',
        ]);
      }
      await settingsStore.setSource(source);
      const selectedName = weatherSourceName(source);
      return sendInfo(e, '天气数据源已切换', [`当前来源：${selectedName}`, '天气查询和每日推送都会使用该来源。']);
    } catch (error) { return sendError(e, error); }
  }

  async weatherApi(e) {
    if (e.isGroup) return sendInfo(e, '请私聊设置天气 API', [
      '为避免密钥出现在群聊，请私聊机器人发送 #设置天气API <API Key>。',
      '群聊中的设置命令不会保存密钥。',
    ]);
    if (!e.isMaster) return sendInfo(e, '没有设置权限', ['WeatherAPI 密钥属于全局配置，仅机器人主人可以设置。']);

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
        '密钥已写入 Yunzai 根目录 data/weather-panel/settings.json。',
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
              `降雨概率 ${day.rainProbability ?? '—'}% · 降雪概率 ${day.snowProbability ?? '—'}%`,
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
                if (!enabled || (Number(preferences[timeKey]) && now - Number(preferences[timeKey]) < 8 * 60 * 60 * 1000)) continue;
                const event = precipitationSummary(weather, type);
                if (!event) continue;
                const name = type === 'rain' ? '降雨' : '降雪';
                const probability = type === 'rain' ? event.rainProbability : event.snowProbability;
                const image = segment.image(await imageOfInfo(`${location.name}${name}提醒`, [
                  `未来24小时预报有${name}：${event.time} ${event.condition}。`,
                  `${name}概率：${probability == null ? '未提供' : `${probability}%`}`,
                  type === 'rain' ? '出行前留意降雨变化，建议携带雨具。' : '出行时留意降雪、结冰和道路湿滑。',
                ]));
                await sendToChat(target, image);
                preferences = await preferencesStore.set(target, { [timeKey]: now });
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
                const image = segment.image(await imageOfInfo(`${location.name}气象预警`, weatherWarningLines(fresh, location), weatherAlertSourceNote));
                await sendToChat(target, image);
                preferences = await preferencesStore.set(target, {
                  lastSevereAlertKeys: [...seen, ...fresh.flatMap(alert => [alert.key, alert.contentKey])].slice(-100),
                });
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
