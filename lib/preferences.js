import fs from 'node:fs/promises';
import path from 'node:path';
import { subscriptionKey } from './subscriptions.js';

const defaults = {
  defaultLocation: null,
  rainAlerts: false,
  snowAlerts: false,
  severeAlerts: false,
  morningTime: null,
  eveningTime: null,
  theme: 'ocean',
  lastMorningDate: null,
  lastEveningDate: null,
  lastRainAlertAt: null,
  lastSnowAlertAt: null,
  lastSevereAlertKeys: [],
};

export class ChatPreferencesStore {
  constructor(file = path.resolve('data/weather-panel/preferences.json')) {
    this.file = file;
    this.queue = Promise.resolve();
  }

  async readFile() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  async get(chat) {
    await this.queue;
    const data = await this.readFile();
    const key = typeof chat === 'string' ? chat : subscriptionKey(chat);
    return { ...defaults, ...(data[key] || {}), key };
  }

  async all() {
    await this.queue;
    const data = await this.readFile();
    return Object.entries(data).map(([key, value]) => ({ ...defaults, ...value, key }));
  }

  async set(chat, patch) {
    const key = subscriptionKey(chat);
    const job = this.queue.then(async () => {
      const data = await this.readFile();
      const value = { ...defaults, ...(data[key] || {}), ...patch, chat, key };
      data[key] = value;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(temp, this.file);
      return value;
    });
    this.queue = job.catch(() => {});
    return job;
  }
}
