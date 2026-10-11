import test from 'node:test';
import assert from 'node:assert/strict';
import { advancedHelpCards, helpGuideEntries, helpImageView, userHelpCards } from '../lib/help-content.js';
import { parseReportCommand, reportTimePatch } from '../lib/report-commands.js';

const commands = cards => cards.flatMap(card => card.rows.map(row => row.command));

test('ordinary help contains user features and excludes owner-only settings', () => {
  const view = helpImageView('usage');
  const rows = commands(view.cards);
  assert.equal(view.title, '天气插件 · 使用帮助');
  assert.match(view.subtitle, /天气查询、订阅与提醒管理/);
  for (const expected of [
    '#天气 北京', '#24小时天气 北京', '#生活指数 北京', '#天气对比 重庆/北京',
    '#天气预警 北京', '#天气', '#绑定城市 重庆', '#解绑城市',
    '#订阅天气 北京 07:30', '#取消天气订阅', '#天气提醒',
    '#开启降雨提醒 / #关闭降雨提醒', '#开启降雪提醒 / #关闭降雪提醒',
    '#开启预警提醒 / #关闭预警提醒', '#开启天气早报 07:00',
    '#开启天气晚报 20:00', '#关闭天气早报', '#关闭天气晚报', '#天气主题 ocean',
  ]) assert.ok(rows.includes(expected), `missing ordinary command: ${expected}`);
  assert.ok(!rows.some(command => /API|天气源|地点缓存/.test(command)));
  assert.equal(view.cards, userHelpCards);
  assert.deepEqual(view.helpGuide, helpGuideEntries);
  assert.deepEqual(view.helpGuide.map(entry => entry.command), ['#天气设置帮助']);
  assert.deepEqual(view.helpGuide.map(entry => entry.note), ['查看高级设置（机器人主人专用）']);
});

test('advanced help contains only owner management commands', () => {
  const view = helpImageView('settings');
  const rows = commands(view.cards);
  assert.equal(view.title, '天气插件 · 高级设置');
  assert.match(view.subtitle, /机器人主人专用/);
  assert.deepEqual(view.cards, advancedHelpCards);
  assert.deepEqual(view.helpGuide, []);
  assert.ok(rows.some(command => command === '#天气源'));
  assert.ok(rows.some(command => command === '#设置天气API <API Key>'));
  assert.ok(rows.some(command => command === '#刷新天气地点缓存 地区'));
  assert.ok(rows.some(command => command === '#清理天气地点缓存'));
  assert.ok(!rows.some(command => /订阅|绑定城市|天气主题|降雨提醒/.test(command)));
});

test('morning and evening primary commands and legacy aliases share the same parser', () => {
  assert.deepEqual(parseReportCommand('#开启天气早报 07:00', '早报'), { action: 'configure', arg: '07:00' });
  assert.deepEqual(parseReportCommand('#设置天气早报 07:00', '早报'), { action: 'configure', arg: '07:00' });
  assert.deepEqual(parseReportCommand('#开启天气晚报 20:00', '晚报'), { action: 'configure', arg: '20:00' });
  assert.deepEqual(parseReportCommand('#设置天气晚报 20:00', '晚报'), { action: 'configure', arg: '20:00' });
  assert.deepEqual(parseReportCommand('#天气早报', '早报'), { action: 'status' });
  assert.deepEqual(parseReportCommand('#开启天气早报', '早报'), { action: 'status' });
  assert.deepEqual(parseReportCommand('#关闭天气晚报', '晚报'), { action: 'disable' });
  assert.equal(parseReportCommand('#开启天气日报 07:00', '早报'), null);
});

test('repeating the same report time does not clear its sent marker', () => {
  assert.deepEqual(reportTimePatch({ morningTime: '07:00', lastMorningDate: '2026-10-11' }, 'morningTime', 'lastMorningDate', '07:00'), {
    morningTime: '07:00',
  });
  assert.deepEqual(reportTimePatch({ morningTime: null, lastMorningDate: null }, 'morningTime', 'lastMorningDate', '08:00'), {
    morningTime: '08:00', lastMorningDate: null,
  });
});
