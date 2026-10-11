import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionStore } from '../lib/subscriptions.js';
import { ChatPreferencesStore } from '../lib/preferences.js';
import { WeatherSettingsStore } from '../lib/settings.js';

test('subscription, reminder preferences and source selection survive fresh store instances', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'weather-stores-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const subscriptionFile = path.join(directory, 'subscriptions.json');
  const preferencesFile = path.join(directory, 'preferences.json');
  const settingsFile = path.join(directory, 'settings.json');
  const target = { botId: 'bot-1', type: 'group', targetId: 'group-2' };
  const location = { name: '重庆', latitude: 29.56, longitude: 106.55, timezone: 'Asia/Shanghai' };

  const subscriptions = new SubscriptionStore(subscriptionFile);
  await subscriptions.put({ ...target, location, time: '07:30', lastSentDate: null });
  const preferences = new ChatPreferencesStore(preferencesFile);
  await preferences.set(target, {
    chat: target, defaultLocation: location, rainAlerts: false, snowAlerts: true,
    lastSnowAlertKey: 'snow:2026-10-10:1:snow:moderate',
    snowAlertDeliveryFailure: null, morningTime: '07:00', lastMorningDate: '2026-10-10',
  });
  const settings = new WeatherSettingsStore(settingsFile);
  await settings.setSource('open-meteo');

  const restoredSubscription = await new SubscriptionStore(subscriptionFile).get('bot-1:group:group-2');
  const restoredPreferences = await new ChatPreferencesStore(preferencesFile).get(target);
  const restoredSettings = await new WeatherSettingsStore(settingsFile).get();
  assert.equal(restoredSubscription.time, '07:30');
  assert.deepEqual(restoredSubscription.location, location);
  assert.equal(restoredPreferences.rainAlerts, false);
  assert.equal(restoredPreferences.snowAlerts, true);
  assert.equal(restoredPreferences.lastSnowAlertKey, 'snow:2026-10-10:1:snow:moderate');
  assert.equal(restoredPreferences.lastMorningDate, '2026-10-10');
  assert.equal(restoredSettings.source, 'open-meteo');

  assert.equal(await new SubscriptionStore(subscriptionFile).remove('bot-1:group:group-2'), true);
  assert.equal(await new SubscriptionStore(subscriptionFile).get('bot-1:group:group-2'), null);
});
