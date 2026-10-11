import test from 'node:test';
import assert from 'node:assert/strict';
import { precipitationReminderView, weatherView } from '../lib/view.js';

const now = new Date('2026-10-10T08:00:00.000Z');
const location = { name: '重庆', timezone: 'Asia/Shanghai' };

function hourlyRows(startLocal, count, build = () => ({ condition: '晴', precipitationProbability: 0 })) {
  const start = Date.parse(`${startLocal}:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const local = new Date(start + index * 60 * 60 * 1000).toISOString().slice(0, 16);
    return { dateTime: local, time: local.slice(11, 16), ...build(index, local) };
  });
}

function nearText(rows, now = new Date('2026-10-10T00:00:00.000Z'), timezone = 'Asia/Shanghai', condition = '晴') {
  return weatherView({
    city: '测试城市', updated: '', timezone, condition,
    hourly24: rows, hourly: [], days: [], sourceNote: '',
  }, 'ocean', null, now).nearPrecipitationText;
}

const knownDryForecast = hourlyRows('2026-10-10T17:00', 24, () => ({
  condition: '晴', precipitationProbability: 0, rainProbability: null, snowProbability: null,
}));

test('rain reminder uses a local forecast date, matching rain label and probability', () => {
  const view = precipitationReminderView(location, {}, {
    dateTime: '2026-10-10T18:00', time: '18:00', condition: '阵雨', rainProbability: 41,
  }, 'bing', now);
  assert.equal(view.title, '重庆 · 降雨提醒');
  assert.equal(view.subtitle, '未来24小时降水预测');
  assert.equal(view.timeLabel, '预计降雨时间');
  assert.equal(view.time, '18:00');
  assert.equal(view.timePeriod, '今天晚上');
  assert.equal(view.probabilityLabel, '降雨概率');
  assert.equal(view.probability, '41%');
  assert.match(view.iconHtml, /viewBox/);
  assert.equal(view.sourceNote, '数据来源：MSN 天气 · 天气预报仅供参考。');
});

test('tomorrow and offset timestamps are formatted in the queried location timezone', () => {
  const view = precipitationReminderView(location, {}, {
    dateTime: '2026-10-10T22:00:00Z', time: '22:00', condition: '小雨', rainProbability: 35,
  }, 'weatherapi', now);
  assert.equal(view.time, '06:00');
  assert.equal(view.timePeriod, '明天上午');
  assert.equal(view.sourceNote, '数据来源：WeatherAPI · 天气预报仅供参考。');
});

test('snow and sleet use distinct labels, icons, advice and probability fields', () => {
  const snow = precipitationReminderView({ name: '哈尔滨', timezone: 'Asia/Shanghai' }, {}, {
    dateTime: '2026-10-11T09:00', time: '09:00', condition: '小雪', snowProbability: 58,
  }, 'bing', now);
  assert.equal(snow.title, '哈尔滨 · 降雪提醒');
  assert.equal(snow.timeLabel, '预计降雪时间');
  assert.equal(snow.probabilityLabel, '降雪概率');
  assert.equal(snow.probability, '58%');
  assert.match(snow.advice, /道路湿滑/);

  const sleet = precipitationReminderView({ name: '长春', timezone: 'Asia/Shanghai' }, {}, {
    dateTime: '2026-10-11T15:00', time: '15:00', condition: '雨夹雪', precipitationType: 'sleet',
    precipitationProbability: 41, rainProbability: 90, snowProbability: 95,
  }, 'bing', now);
  assert.equal(sleet.title, '长春 · 雨雪提醒');
  assert.equal(sleet.timeLabel, '预计雨雪时间');
  assert.equal(sleet.probabilityLabel, '降水概率');
  assert.equal(sleet.probability, '41%');
  assert.match(sleet.iconHtml, /viewBox/);
  assert.match(sleet.advice, /雨夹雪/);
});

test('generic probability is not relabeled as a rain or snow probability', () => {
  const view = precipitationReminderView(location, {}, {
    dateTime: '2026-10-10T15:00', time: '15:00', precipitationProbability: 73,
  }, 'bing', now);
  assert.equal(view.title, '重庆 · 降水预报');
  assert.equal(view.probabilityLabel, '降水概率');
  assert.equal(view.probability, '73%');

  const rainWithoutSpecificProbability = precipitationReminderView(location, {}, {
    dateTime: '2026-10-10T15:00', time: '15:00', condition: '小雨', precipitationProbability: 73,
  }, 'bing', now);
  assert.equal(rainWithoutSpecificProbability.probabilityLabel, '降水概率');
  assert.equal(rainWithoutSpecificProbability.probability, '73%');

  const independentTypeChances = precipitationReminderView(location, {}, {
    dateTime: '2026-10-10T15:00', time: '15:00', rainProbability: 55, snowProbability: 46,
  }, 'weatherapi', now);
  assert.equal(independentTypeChances.title, '重庆 · 降水预报');
  assert.equal(independentTypeChances.probabilityLabel, '分类型概率');
  assert.equal(independentTypeChances.probability, '降雨 55% · 降雪 46%');
});

test('missing time and probability stay explicit; no forecast is distinct from missing forecast data', () => {
  const missing = precipitationReminderView(location, {}, { condition: '小雨' }, 'bing', now);
  assert.equal(missing.time, '暂无数据');
  assert.equal(missing.timePeriod, '预报时间未提供');
  assert.equal(missing.probability, '暂无数据');

  const dry = precipitationReminderView(location, { hourly24: knownDryForecast }, null, 'bing', now);
  assert.equal(dry.hasEvent, false);
  assert.equal(dry.emptyMessage, '未来24小时暂无明确降水预报');

  const genericPossible = knownDryForecast.map(hour => ({ ...hour }));
  genericPossible[4].precipitationProbability = 18;
  const unknownType = precipitationReminderView(location, { hourly24: genericPossible }, null, 'bing', now);
  assert.equal(unknownType.title, '重庆 · 降水预报');
  assert.equal(unknownType.time, genericPossible[4].time);
  assert.equal(unknownType.probability, '18%');
  assert.equal(unknownType.typeLabel, '类型暂不明确');
  assert.equal(unknownType.emptyMessage, '');

  const unavailable = precipitationReminderView(location, { hourly24: Array(24).fill({ condition: '天气状况未知' }) }, null, 'bing', now);
  assert.equal(unavailable.emptyMessage, '未来24小时降水预报数据不足，暂无法判断。');

  const textOnly = precipitationReminderView(location, {
    hourly24: [], days: [{ date: '2026-10-10', condition: '小雨' }],
  }, null, 'bing', now);
  assert.equal(textOnly.emptyMessage, '未来24小时存在降水可能，具体时间及类型暂不明确。');
});

test('long city names remain intact and source attribution follows the configured provider', () => {
  const city = '加利福尼亚州洛杉矶市圣费尔南多谷地区';
  const view = precipitationReminderView({ name: city, timezone: 'America/Los_Angeles' }, {}, {
    dateTime: '2026-10-10T15:00', time: '15:00', condition: '雨夹雪', precipitationProbability: 32,
  }, 'open-meteo', now);
  assert.ok(view.title.startsWith(`${city} · 雨雪提醒`));
  assert.equal(view.sourceNote, '数据来源：Open-Meteo · 天气预报仅供参考。');
});

test('generic MSN-style probability creates a timed precipitation forecast without inventing its type', () => {
  const hourly24 = hourlyRows('2026-10-10T17:00', 24, (index, local) => ({
    condition: '多云', precipitationProbability: local === '2026-10-11T02:00' ? 16 : 0,
  }));
  const view = precipitationReminderView(
    { name: '北京', timezone: 'Asia/Shanghai' }, { hourly24 }, null, 'bing', new Date('2026-10-10T15:09:00.000Z'),
  );
  assert.equal(view.title, '北京 · 降水预报');
  assert.equal(view.hasEvent, true);
  assert.equal(view.time, '02:00');
  assert.equal(view.timePeriod, '明天夜间');
  assert.equal(view.probabilityLabel, '降水概率');
  assert.equal(view.probability, '16%');
  assert.equal(view.typeLabel, '类型暂不明确');
});

test('a known precipitation period from incomplete hourly data is shown with a coverage note', () => {
  const view = precipitationReminderView({ name: '北京', timezone: 'Asia/Shanghai' }, {
    hourly24: [{ dateTime: '2026-10-10T20:00', condition: '多云', precipitationProbability: 16 }],
  }, null, 'bing', now);
  assert.equal(view.time, '20:00');
  assert.equal(view.probability, '16%');
  assert.match(view.coverageNote, /数据不完整/);
});

test('independent forecast lists multiple hourly periods in time order with their own probabilities', () => {
  const hourly24 = hourlyRows('2026-10-10T17:00', 24, (index, local) => ({
    condition: '多云', precipitationProbability: ({
      '2026-10-10T20:00': 12,
      '2026-10-11T02:00': 16,
      '2026-10-11T04:00': 33,
    })[local] ?? 0,
  }));
  const view = precipitationReminderView(
    { name: '北京', timezone: 'Asia/Shanghai' }, { hourly24 }, null, 'bing', now,
  );
  assert.equal(view.time, '20:00');
  assert.equal(view.probability, '12%');
  assert.match(view.additionalPeriodsHtml, /02:00 · 降水概率16%/);
  assert.match(view.additionalPeriodsHtml, /04:00 · 降水概率33%/);
  assert.ok(view.additionalPeriodsHtml.indexOf('02:00') < view.additionalPeriodsHtml.indexOf('04:00'));
});

test('specific rain and snow chances retain their labels; generic chance stays generic for known type', () => {
  const rain = precipitationReminderView(location, {}, {
    dateTime: '2026-10-10T18:00', condition: '小雨', precipitationProbability: 41,
  }, 'bing', now);
  assert.equal(rain.probabilityLabel, '降水概率');
  assert.equal(rain.probability, '41%');

  const snow = precipitationReminderView(location, {}, {
    dateTime: '2026-10-10T18:00', condition: '小雪', snowProbability: 58,
  }, 'weatherapi', now);
  assert.equal(snow.probabilityLabel, '降雪概率');
  assert.equal(snow.probability, '58%');

  const sleet = precipitationReminderView(location, {}, {
    dateTime: '2026-10-10T18:00', condition: '雨夹雪', precipitationType: 'sleet',
    precipitationProbability: 31, rainProbability: 85, snowProbability: 92,
  }, 'weatherapi', now);
  assert.equal(sleet.probabilityLabel, '降水概率');
  assert.equal(sleet.probability, '31%');
});

test('near-two-hour trend excludes past samples and the 02:00 point outside a 23:09 window', () => {
  const nowAt2309 = new Date('2026-10-10T15:09:00.000Z');
  const rows = [
    { dateTime: '2026-10-10T23:00', condition: '多云', precipitationProbability: 88 },
    { dateTime: '2026-10-11T00:00', condition: '晴', precipitationProbability: 0 },
    { dateTime: '2026-10-11T01:00', condition: '晴', precipitationProbability: 0 },
    { dateTime: '2026-10-11T02:00', condition: '多云', precipitationProbability: 16 },
  ];
  const view = weatherView({
    city: '北京', updated: '', timezone: 'Asia/Shanghai', condition: '晴', hourly24: rows,
    hourly: [], days: [], sourceNote: '',
  }, 'ocean', null, nowAt2309);
  assert.equal(view.nearPrecipitationText, '降水概率极低\n最高 0% · 明天 00:00');
  assert.doesNotMatch(view.nearPrecipitationText, /02:00|16%|88%/);
});

test('near-two-hour trend reports missing coverage instead of claiming dry when no future sample exists', () => {
  const nowAt2309 = new Date('2026-10-10T15:09:00.000Z');
  const view = weatherView({
    city: '北京', updated: '', timezone: 'Asia/Shanghai', condition: '晴',
    hourly24: [{ dateTime: '2026-10-11T02:00', condition: '多云', precipitationProbability: 16 }],
    hourly: [], days: [], sourceNote: '',
  }, 'ocean', null, nowAt2309);
  assert.equal(view.nearPrecipitationText, '暂无近两小时降水数据');
});

test('a small nonzero hourly probability is summarized as very low, not imminent precipitation', () => {
  const nowAt2309 = new Date('2026-10-10T15:09:00.000Z');
  const view = weatherView({
    city: '北京', updated: '', timezone: 'Asia/Shanghai', condition: '晴',
    hourly24: [
      { dateTime: '2026-10-11T00:00', condition: '多云', precipitationProbability: 1 },
      { dateTime: '2026-10-11T01:00', condition: '晴', precipitationProbability: 0 },
    ],
    hourly: [], days: [], sourceNote: '',
  }, 'ocean', null, nowAt2309);
  assert.match(view.nearPrecipitationText, /^降水概率极低/);
  assert.match(view.nearPrecipitationText, /明天 00:00/);
  assert.match(view.nearPrecipitationText, /1%/);
  assert.doesNotMatch(view.nearPrecipitationText, /将降水|开始降水/);
});

test('near-two-hour probability bands include zero and use the requested boundaries', () => {
  const cases = [
    [0, '降水概率极低'], [3, '降水概率极低'], [5, '降水概率极低'], [9, '降水概率极低'],
    [10, '降水可能性较低'], [29, '降水可能性较低'],
    [30, '有一定降水可能'], [49, '有一定降水可能'],
    [50, '降水可能性较高'], [69, '降水可能性较高'],
    [70, '降水概率高'], [100, '降水概率高'],
  ];
  for (const [chance, phrase] of cases) {
    const actual = nearText([
      { dateTime: '2026-10-10T09:00', condition: '多云', precipitationProbability: chance },
      { dateTime: '2026-10-10T10:00', condition: '多云', precipitationProbability: 0 },
    ]);
    assert.equal(actual.split('\n')[0], phrase, `probability ${chance}%`);
    assert.match(actual, new RegExp(`最高 ${chance}% · 09:00`));
  }
});

test('unknown precipitation type keeps general probability wording', () => {
  const actual = nearText([
    { dateTime: '2026-10-10T09:00', condition: '多云', precipitationProbability: 60 },
    { dateTime: '2026-10-10T10:00', condition: '多云', precipitationProbability: 25 },
  ]);
  assert.equal(actual, '降水可能性较高\n最高 60% · 09:00');
  assert.doesNotMatch(actual, /降雨|降雪|雨夹雪/);
});

test('partial probability data is labeled as known periods and invalid values are not treated as zero', () => {
  const partial = nearText([
    { dateTime: '2026-10-10T09:00', condition: '多云', precipitationProbability: 35 },
    { dateTime: '2026-10-10T10:00', condition: '多云', precipitationProbability: null },
  ]);
  assert.equal(partial, '已知时段：有一定降水可能\n最高 35% · 09:00');
  const missing = nearText([
    { dateTime: '2026-10-10T09:00', condition: '多云', precipitationProbability: 'NaN' },
    { dateTime: '2026-10-10T10:00', condition: '多云', precipitationProbability: 101 },
  ]);
  assert.equal(missing, '暂无近两小时降水数据');
});

test('explicit low-probability precipitation descriptions remain visible', () => {
  const actual = nearText([
    { dateTime: '2026-10-10T09:00', condition: '小雨', precipitationProbability: 5 },
    { dateTime: '2026-10-10T10:00', condition: '多云', precipitationProbability: 3 },
  ]);
  assert.equal(actual, '预报有降雨 · 降水概率极低\n最高 5% · 09:00');
});

test('near-two-hour window uses the selected timezone across midnight and excludes later samples', () => {
  const nowAtLocal2330 = new Date('2026-10-11T06:30:00.000Z'); // 23:30 in Los Angeles
  const actual = nearText([
    { dateTime: '2026-10-11T00:00', condition: '多云', precipitationProbability: 29 },
    { dateTime: '2026-10-11T01:00', condition: '多云', precipitationProbability: 10 },
    { dateTime: '2026-10-11T02:00', condition: '大雨', precipitationProbability: 100 },
  ], nowAtLocal2330, 'America/Los_Angeles');
  assert.equal(actual, '降水可能性较低\n最高 29% · 明天 00:00');
  assert.doesNotMatch(actual, /02:00|100%|降雨/);
});

test('short trend text stays compact even when provider condition text is long', () => {
  const actual = nearText([
    { dateTime: '2026-10-10T09:00', condition: '局地短时强雷阵雨并伴有强风天气状况', precipitationProbability: 70 },
    { dateTime: '2026-10-10T10:00', condition: '多云转阴有零星阵雨', precipitationProbability: 55 },
  ]);
  const lines = actual.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines.every(line => line.length <= 22), `unexpectedly long card lines: ${lines.map(line => line.length).join(',')}`);
  assert.equal(actual, '预报有降雨 · 降水概率高\n最高 70% · 09:00');
});
