import fs from 'node:fs/promises';
import path from 'node:path';

export const subscriptionKey = ({ botId, type, targetId }) => `${botId}:${type}:${targetId}`;

export class SubscriptionStore {
  constructor(file = path.resolve('data/weather-panel/subscriptions.json')) {
    this.file = file;
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async change(fn) {
    const job = this.queue.then(async () => {
      const list = await this.read();
      const result = await fn(list);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify(list, null, 2), 'utf8');
      await fs.rename(temp, this.file);
      return result;
    });
    this.queue = job.catch(() => {});
    return job;
  }

  async get(key) {
    await this.queue;
    return (await this.read()).find(s => subscriptionKey(s) === key) || null;
  }

  async all() {
    await this.queue;
    return this.read();
  }

  async put(subscription) {
    return this.change(list => {
      const index = list.findIndex(s => subscriptionKey(s) === subscriptionKey(subscription));
      if (index < 0) list.push(subscription);
      else list[index] = subscription;
      return subscription;
    });
  }

  async remove(key) {
    return this.change(list => {
      const index = list.findIndex(s => subscriptionKey(s) === key);
      if (index < 0) return false;
      list.splice(index, 1);
      return true;
    });
  }

  async markSent(key, date) {
    return this.change(list => {
      const item = list.find(s => subscriptionKey(s) === key);
      if (!item) return false;
      item.lastSentDate = date;
      return true;
    });
  }
}
