import renderer from '../../lib/renderer/loader.js';
import { segment } from 'oicq';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWeather, localDateTime, resolveCity } from './lib/weather.js';
import { SubscriptionStore, subscriptionKey } from './lib/subscriptions.js';
import { weatherView } from './lib/view.js';

const store = new SubscriptionStore();
const root = fileURLToPath(new URL('./resources/', import.meta.url));
const chat = e => ({ botId: String(e.self_id), type: e.isGroup ? 'group' : 'private', targetId: String(e.isGroup ? e.group_id : e.user_id) });

async function imageOfWeather(location) {
  const data = await getWeather(location);
  const image = await renderer.render('yunzai-weather-plugin', {
    saveId: 'weather', tplFile: path.join(root, 'weather.html'), ...weatherView(data), imgType: 'png',
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
  const image = await renderer.render('yunzai-weather-plugin', {
    saveId: 'info', tplFile: path.join(root, 'info.html'), title, lines, imgType: 'png',
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

export class WeatherPanel extends plugin {
  static pushing = false;

  constructor() {
    super({
      name: '天气图片', dsc: '天气查询、订阅与每日图片推送', event: 'message', priority: 5000,
      rule: [
        { reg: '^#?天气帮助$', fnc: 'help' },
        { reg: '^#?(?:取消天气订阅|退订天气)$', fnc: 'unsubscribe' },
        { reg: '^#?(?:订阅天气|天气订阅)(?:\\s+.+)?$', fnc: 'subscribe' },
        { reg: '^#?(?:天气|查询天气)(?:\\s+.+)?$', fnc: 'query' },
      ],
      task: { name: '天气每日图片推送', cron: '0 * * * * *', fnc: () => WeatherPanel.pushDaily(), log: false },
    });
  }

  async help(e) {
    return sendInfo(e, '天气插件帮助', [
      '#天气 北京　查询城市天气',
      '#查询天气 东京　也可查询任意城市',
      '#天气 东京,JP　可指定国家代码，避免同名城市',
      '#订阅天气 北京 07:30　每日按该城市当地时间推送',
      '#天气订阅　查看当前会话订阅',
      '#取消天气订阅　关闭当前会话推送',
      '不写时间默认 07:00；群订阅由管理员设置。',
    ]);
  }

  async query(e) {
    const arg = e.msg.replace(/^#?(?:天气|查询天气)/, '').trim();
    try {
      const location = arg ? await resolveCity(arg) : (await store.get(subscriptionKey(chat(e))))?.location;
      if (!location) return this.help(e);
      return await e.reply(segment.image(await imageOfWeather(location)));
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
      const cache = new Map();
      for (const sub of subs) {
        try {
          if (!Bot.bots?.[sub.botId]) continue;
          const local = localDateTime(sub.location.timezone);
          const currentMinutes = Number(local.time.slice(0, 2)) * 60 + Number(local.time.slice(3));
          const dueMinutes = Number(sub.time.slice(0, 2)) * 60 + Number(sub.time.slice(3));
          if (currentMinutes < dueMinutes || currentMinutes >= dueMinutes + 60 || sub.lastSentDate === local.date) continue;
          const locationKey = `${sub.location.latitude}:${sub.location.longitude}:${local.date}`;
          if (!cache.has(locationKey)) cache.set(locationKey, imageOfWeather(sub.location));
          const image = segment.image(await cache.get(locationKey));
          const result = sub.type === 'group'
            ? await Bot.sendGroupMsg(sub.botId, sub.targetId, image)
            : await Bot.sendFriendMsg(sub.botId, sub.targetId, image);
          if (result === false || result == null) throw new Error('发送接口没有确认成功');
          await store.markSent(subscriptionKey(sub), local.date);
        } catch (error) { logger.error(`[天气插件] 每日推送失败 ${sub.type}:${sub.targetId}`, error); }
      }
    } catch (error) { logger.error('[天气插件] 读取每日订阅失败', error); }
    finally { WeatherPanel.pushing = false; }
  }
}
