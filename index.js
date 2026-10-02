import renderer from '../../lib/renderer/loader.js';
import { segment } from 'oicq';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWeather, localDateTime, resolveCity } from './lib/weather.js';
import { SubscriptionStore, subscriptionKey } from './lib/subscriptions.js';
import { WeatherSettingsStore } from './lib/settings.js';
import { ChatPreferencesStore } from './lib/preferences.js';
import { weatherView } from './lib/view.js';

const store = new SubscriptionStore();
const settingsStore = new WeatherSettingsStore();
const preferencesStore = new ChatPreferencesStore();
const root = fileURLToPath(new URL('./resources/', import.meta.url));
const chat = e => ({ botId: String(e.self_id), type: e.isGroup ? 'group' : 'private', targetId: String(e.isGroup ? e.group_id : e.user_id) });
const weatherSourceName = source => source === 'weatherapi' ? 'WeatherAPI.com' : source === 'bing' ? 'Bing 天气（MSN）' : 'Open-Meteo';

async function imageOfWeather(location, weatherSettings = null, theme = 'ocean', weatherData = null) {
  const selectedSettings = weatherSettings || await settingsStore.get();
  const data = weatherData || await getWeather(location, fetch, selectedSettings);
  const image = await renderer.render('yunzai-weather-plugin', {
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

async function imageOfInfo(title, lines) {
  const weatherSettings = await settingsStore.get();
  const image = await renderer.render('yunzai-weather-plugin', {
    saveId: 'info', tplFile: path.join(root, 'info.html'), title, lines,
    sourceNote: `Yunzai · 天气数据由 ${weatherSourceName(weatherSettings.source)} 提供`,
    imgType: 'png',
  });
  if (!image) throw new Error('图片渲染失败，请确认 Yunzai 的渲染器可用');
  return image;
}

async function sendInfo(e, title, lines) {
  try { return await e.reply(segment.image(await imageOfInfo(title, lines))); }
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

function naturalQueryParts(message) {
  const text = String(message || '').trim().replace(/[？?。！!，,、]+$/g, '');
  if (!/(天气|下雨|降雨|下雪|降雪|气温|温度|多少度|冷不冷|热不热)/.test(text)) return null;
  const dayOffset = text.includes('后天') ? 2 : text.includes('明天') ? 1 : 0;
  const type = /下雪|降雪|积雪/.test(text) ? 'snow' : /下雨|降雨/.test(text) ? 'rain' : /气温|温度|多少度|冷不冷|热不热/.test(text) ? 'temperature' : 'weather';
  let city = text.split(/下雨|降雨|下雪|降雪|积雪|天气|气温|温度|多少度|冷不冷|热不热/)[0];
  city = city
    .replace(/^(?:请问|麻烦|帮我(?:查一下|查查|查询)?|查询|查一下|查查|看一下|想知道)/, '')
    .replace(/今天|明天|后天|今晚|今早|明早/g, '')
    .replace(/(?:会不会|是否|会|有|将会).*$/g, '')
    .replace(/(?:怎么样|如何|吗|呢)$/g, '')
    .trim();
  return { city, dayOffset, type };
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
        { reg: '^#?(?:天气早报|设置天气早报|关闭天气早报)(?:\\s+.+)?$', fnc: 'morningReport' },
        { reg: '^#?(?:天气晚报|设置天气晚报|关闭天气晚报)(?:\\s+.+)?$', fnc: 'eveningReport' },
        { reg: '^#?(?:天气源|天气数据源|切换天气源|切换数据源)(?:\\s+.+)?$', fnc: 'source' },
        { reg: '^#?(?:取消天气订阅|退订天气)$', fnc: 'unsubscribe' },
        { reg: '^#?(?:订阅天气|天气订阅)(?:\\s+.+)?$', fnc: 'subscribe' },
        { reg: '^#?(?:天气|查询天气)(?:\\s+.+)?$', fnc: 'query' },
        { reg: '^(?!#).{1,80}(?:天气|下雨|降雨|下雪|降雪|气温|温度|多少度|冷不冷|热不热).{0,30}$', fnc: 'naturalQuery' },
      ],
      task: { name: '天气每日图片推送', cron: '0 * * * * *', fnc: () => WeatherPanel.pushDaily(), log: false },
    });
  }

  async help(e) {
    return sendInfo(e, '天气插件帮助', [
      '常用功能',
      '#天气 北京 / #查询天气 东京　查询城市或区县天气',
      '#天气 昌平区,北京 / #天气 渝中区,重庆　同名区县请补充所属城市',
      '#绑定城市 重庆 / #解绑城市　设置或解除默认城市',
      '#生活指数　查看出行、穿衣、防晒建议',
      '#24小时预报　查看未来逐小时天气',
      '#天气对比 重庆/北京/上海　对比多个城市',
      '#天气提醒 / #开启降雨提醒 / #开启降雪提醒　查询或开启天气提醒',
      '#订阅天气 北京 07:30 / #取消天气订阅　每日推送或取消',
      '自然语言示例：重庆明天会下雨吗',
      '其他设置',
      '#天气主题 ocean/sunset/night　切换卡片主题',
      '#天气设置帮助　查看数据源、早晚报和 API 设置',
    ]);
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

  async naturalQuery(e) {
    const parsed = naturalQueryParts(e.msg);
    if (!parsed) return false;
    const target = chat(e);
    try {
      const preferences = await preferencesStore.get(target);
      const location = parsed.city ? await resolveCity(parsed.city) : await locationForChat(target, preferences);
      if (!location) return sendInfo(e, '需要城市信息', ['请在问题中写上城市，或先发送 #绑定城市 重庆 设置默认城市。']);
      const weather = await getWeather(location, fetch, await settingsStore.get());
      const day = weather.days[parsed.dayOffset];
      if (!day) return sendInfo(e, '预报范围不足', ['当前数据源没有返回所询日期的天气预报。']);
      const dayLabel = parsed.dayOffset === 1 ? '明天' : parsed.dayOffset === 2 ? '后天' : '今天';
      const lines = [`天气：${day.condition} · ${day.low ?? '—'}°C 至 ${day.high ?? '—'}°C`];
      if (parsed.type === 'rain') {
        const probability = day.rainProbability;
        lines.push(`降雨概率：${probability == null ? '未提供' : `${probability}%`}`);
        lines.push(probability >= 50 || /雨|雷/.test(day.condition) ? '建议留意天气并携带雨具。' : '当前预报显示降雨可能较低。');
      } else if (parsed.type === 'snow') {
        const probability = day.snowProbability;
        lines.push(`降雪概率：${probability == null ? '未提供' : `${probability}%`}`);
        lines.push(probability >= 30 || /雪/.test(day.condition) ? '可能降雪，留意道路湿滑。' : '当前预报显示降雪可能较低。');
      } else if (parsed.type === 'temperature') {
        lines.push(`最高 ${day.high ?? '—'}°C，最低 ${day.low ?? '—'}°C。`);
      } else {
        lines.push(`降雨概率 ${day.rainProbability ?? '—'}% · 降雪概率 ${day.snowProbability ?? '—'}%`);
      }
      return sendInfo(e, `${location.name}${dayLabel}天气`, lines);
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

          if (!checkAlerts || (!preferences.rainAlerts && !preferences.snowAlerts)) continue;
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
        } catch (error) { logger.error(`[天气插件] 定时天气任务失败 ${target.type}:${target.targetId}`, error); }
      }
    } catch (error) { logger.error('[天气插件] 读取天气计划失败', error); }
    finally { WeatherPanel.pushing = false; }
  }
}
