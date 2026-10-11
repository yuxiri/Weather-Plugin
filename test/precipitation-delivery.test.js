import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RAIN_ALERT_THRESHOLD,
  precipitationDeliveryFailure,
  precipitationEventKey,
  precipitationSummary,
  shouldSendPrecipitationAlert,
} from '../lib/precipitation.js';

const timezone = 'Asia/Shanghai';
const now = new Date('2026-10-10T08:30:00+08:00');

test('rain reminders require at least 70% rain probability from a valid rain signal', () => {
  assert.equal(DEFAULT_RAIN_ALERT_THRESHOLD, 70);
  const summarize = hour => precipitationSummary({ hourly24: [
    { dateTime: '2026-10-10T09:00', ...hour },
  ] }, 'rain', now, timezone);

  assert.equal(summarize({ condition: '小雨', rainProbability: 69 }), null);
  assert.deepEqual(summarize({ condition: '小雨', rainProbability: 70 }), { dateTime: '2026-10-10T09:00', condition: '小雨', rainProbability: 70 });
  assert.ok(summarize({ condition: '阵雨', rainProbability: 90 }));
  assert.equal(summarize({ condition: '小雨' }), null);
  for (const invalid of [NaN, 'NaN', -1, 101, '']) {
    assert.equal(summarize({ condition: '小雨', rainProbability: invalid }), null);
  }

  assert.equal(summarize({ condition: '天气状况未知', precipitationProbability: 90 }), null);
  assert.ok(summarize({ condition: '小雨', precipitationProbability: 70 }));
  assert.equal(summarize({ condition: '小雨', precipitationProbability: 69 }), null);
  assert.equal(summarize({ condition: '小雪', precipitationProbability: 90 }), null);
  assert.equal(summarize({ condition: '小雨', rainProbability: 69, precipitationProbability: 90 }), null);
  assert.equal(summarize({ condition: '小雨', rainAmount: 2 }), null);
});

test('rain and snow reminder selection uses only the matching type and never generic probability', () => {
  const weather = { hourly24: [
    { dateTime: '2026-10-10T08:00', condition: '小雨', precipitationProbability: 100 },
    { dateTime: '2026-10-10T09:00', condition: '天气状况未知', precipitationProbability: 100 },
    { dateTime: '2026-10-10T10:00', condition: '小雪', snowProbability: 55 },
  ] };
  assert.equal(precipitationSummary(weather, 'rain', now, timezone), null);
  assert.equal(precipitationSummary(weather, 'snow', now, timezone), weather.hourly24[2]);
  const genericOnly = { hourly24: [{ dateTime: '2026-10-10T12:00', condition: '天气状况未知', precipitationProbability: 90, precipitationAmount: 1 }] };
  assert.equal(precipitationSummary(genericOnly, 'rain', now, timezone), null);
  assert.equal(precipitationSummary(genericOnly, 'snow', now, timezone), null);
});

test('past forecast points are skipped and provider-offset times are compared in the city timezone', () => {
  const weather = { hourly24: [
    { dateTime: '2026-10-10T08:00', condition: '小雨' },
    { dateTime: '2026-10-09T06:00:00-07:00', condition: '小雨' },
    { dateTime: '2026-10-10T10:00:00+08:00', condition: '阵雨', rainProbability: 70 },
  ] };
  assert.equal(precipitationSummary(weather, 'rain', now, timezone), weather.hourly24[2]);
});

test('sleet matches each independent precipitation reminder, but event keys deduplicate the same forecast period', () => {
  const event = {
    dateTime: '2026-10-10T15:00', condition: '雨夹雪', precipitationType: 'sleet',
    rainProbability: 70, snowProbability: 60,
  };
  const weather = { hourly24: [event] };
  assert.equal(precipitationSummary(weather, 'rain', now, timezone), event);
  assert.equal(precipitationSummary(weather, 'snow', now, timezone), event);
  const rainKey = precipitationEventKey('rain', event, timezone);
  assert.equal(rainKey, precipitationEventKey('rain', { ...event, dateTime: '2026-10-10T16:00' }, timezone));
  assert.notEqual(rainKey, precipitationEventKey('snow', event, timezone));
  assert.notEqual(rainKey, precipitationEventKey('rain', { ...event, condition: '大雨' }, timezone));
});

test('delivery retries are finite, persisted event keys prevent repeats, and new events may notify', () => {
  const first = precipitationDeliveryFailure(null, 'rain:2026-10-10:1:rain:moderate', 1_000);
  assert.equal(first.attempts, 1);
  assert.equal(first.nextAttemptAt, 301_000);
  assert.equal(shouldSendPrecipitationAlert({ rainAlertDeliveryFailure: first }, 'rain', first.eventKey, 300_000), false);
  const second = precipitationDeliveryFailure(first, first.eventKey, first.nextAttemptAt);
  const third = precipitationDeliveryFailure(second, first.eventKey, second.nextAttemptAt);
  assert.equal(third.exhausted, true);
  assert.equal(shouldSendPrecipitationAlert({ rainAlertDeliveryFailure: third }, 'rain', first.eventKey, 10_000_000), false);
  assert.equal(shouldSendPrecipitationAlert({ lastRainAlertKey: first.eventKey }, 'rain', first.eventKey, 10_000_000), false);
  assert.equal(shouldSendPrecipitationAlert({ lastRainAlertKey: first.eventKey }, 'rain', 'rain:2026-10-10:3:rain:moderate', 10_000_000), true);
  assert.equal(shouldSendPrecipitationAlert({ lastRainAlertAt: 9_000_000 }, 'rain', 'new-event', 10_000_000), false);
});

test('a rain event is suppressed on repeated checks while a later independent event can notify', () => {
  const firstEvent = { dateTime: '2026-10-10T15:00', condition: '小雨', rainProbability: 90 };
  const sameEvent = { ...firstEvent, dateTime: '2026-10-10T16:00' };
  const laterEvent = { ...firstEvent, dateTime: '2026-10-10T21:00' };
  const firstKey = precipitationEventKey('rain', firstEvent, timezone);
  const sameKey = precipitationEventKey('rain', sameEvent, timezone);
  const laterKey = precipitationEventKey('rain', laterEvent, timezone);
  assert.equal(firstKey, sameKey);
  assert.notEqual(firstKey, laterKey);
  const saved = { lastRainAlertKey: firstKey, lastRainAlertAt: now.getTime() };
  assert.equal(shouldSendPrecipitationAlert(saved, 'rain', sameKey, now.getTime() + 60_000), false);
  assert.equal(shouldSendPrecipitationAlert(saved, 'rain', laterKey, now.getTime() + 60_000), true);
});
