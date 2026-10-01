import fs from 'node:fs/promises';
import path from 'node:path';

const VALID_SOURCES = new Set(['open-meteo', 'weatherapi', 'bing']);

export class WeatherSettingsStore {
  constructor(file = path.resolve('data/weather-panel/settings.json')) {
    this.file = file;
    this.queue = Promise.resolve();
  }

  async readFile() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  async get() {
    await this.queue;
    const data = await this.readFile();
    return {
      source: VALID_SOURCES.has(data.source) ? data.source : 'bing',
      weatherApiKey: String(data.weatherApiKey || process.env.WEATHERAPI_KEY || '').trim(),
    };
  }

  async setSource(source) {
    if (!VALID_SOURCES.has(source)) throw new Error('不支持的数据源');
    const job = this.queue.then(async () => {
      const data = await this.readFile();
      const next = { ...data, source };
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify(next, null, 2), 'utf8');
      await fs.rename(temp, this.file);
      return {
        source,
        weatherApiKey: String(next.weatherApiKey || process.env.WEATHERAPI_KEY || '').trim(),
      };
    });
    this.queue = job.catch(() => {});
    return job;
  }
}

