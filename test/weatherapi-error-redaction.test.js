import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { getWeatherApiAlertData } from '../lib/weather.js';

const testApiKey = 'weatherapi-test-secret-91f8349e';
const testLocation = { latitude: 39.9042, longitude: 116.4074 };

function requestUrl() {
  return `https://api.weatherapi.com/v1/alerts.json?key=${encodeURIComponent(testApiKey)}&q=${testLocation.latitude}%2C${testLocation.longitude}`;
}

async function captureFailure(fetcher) {
  try {
    await getWeatherApiAlertData(testLocation, fetcher, testApiKey);
  } catch (error) {
    return error;
  }
  assert.fail('expected WeatherAPI request to fail');
}

function assertNoKeyLeak(error) {
  const properties = Object.getOwnPropertyNames(error).map(name => {
    const value = error[name];
    return typeof value === 'string' ? value : inspect(value, { depth: 8 });
  });
  const serialized = [
    error.message,
    error.stack,
    String(error),
    JSON.stringify(error),
    inspect(error, { depth: 8 }),
    ...properties,
  ].join('\n');
  assert.equal(serialized.includes(testApiKey), false, 'API key must not appear in error fields or serialization');
  assert.equal(error.cause, undefined, 'raw underlying exceptions must not be retained as cause');
  assert.equal(error.endpoint, 'api.weatherapi.com/v1/alerts.json');
  assert.equal(new URL(error.url).searchParams.get('key'), '[REDACTED]');
}

test('WeatherAPI HTTP errors retain status and safe endpoint diagnostics', async () => {
  const error = await captureFailure(async () => new Response('unauthorized', { status: 401 }));
  assertNoKeyLeak(error);
  assert.equal(error.httpStatus, 401);
  assert.match(error.message, /HTTP 401/);
  assert.equal(error.stage, 'network');
});

test('WeatherAPI timeout errors omit the key from the underlying exception and stack', async () => {
  const url = requestUrl();
  const fetcher = async () => {
    const error = new Error(`request timed out at ${url}`, { cause: new Error(`socket ${url}`) });
    error.name = 'TimeoutError';
    error.requestUrl = url;
    throw error;
  };
  const error = await captureFailure(fetcher);
  assertNoKeyLeak(error);
  assert.equal(error.code, 'timeout');
  assert.equal(error.timedOut, true);
});

test('WeatherAPI network errors do not retain secret-bearing causes or properties', async () => {
  const url = requestUrl();
  const fetcher = async () => {
    const error = new TypeError(`fetch failed for ${url}`, { cause: new Error(`connection refused ${url}`) });
    error.requestUrl = url;
    throw error;
  };
  const error = await captureFailure(fetcher);
  assertNoKeyLeak(error);
  assert.equal(error.code, 'network-request-failed');
  assert.equal(error.stage, 'network');
});

test('WeatherAPI provider error summaries redact echoed credentials', async () => {
  const url = requestUrl();
  const fetcher = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ error: { code: 'invalid-key', message: `Invalid key ${testApiKey}; request ${url}` } }),
  });
  const error = await captureFailure(fetcher);
  assertNoKeyLeak(error);
  assert.equal(error.code, 'provider-error');
  assert.equal(error.stage, 'provider');
  assert.match(error.errorSummary, /Invalid key/);
});

test('WeatherAPI response parse failures redact credentials from parser errors', async () => {
  const url = requestUrl();
  const fetcher = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError(`invalid response at ${url}`); },
  });
  const error = await captureFailure(fetcher);
  assertNoKeyLeak(error);
  assert.equal(error.code, 'page-parse-failed');
  assert.equal(error.stage, 'parse');
});
