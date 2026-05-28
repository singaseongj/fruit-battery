const fs = require('fs/promises');
const path = require('path');

const WEB_APP_URL = process.env.WEB_APP_URL;
const DATA_FILE = path.join(__dirname, '..', 'data.json');
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1_000;

if (!WEB_APP_URL) {
  throw new Error('Missing WEB_APP_URL environment variable');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

async function fetchWithRetry(url) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'cache-control': 'no-cache'
        }
      });

      if (response.ok) return response;

      const error = new Error(`HTTP ${response.status}`);
      if (!isRetryableStatus(response.status) || attempt === MAX_RETRIES) throw error;

      lastError = error;
      const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      await sleep(delayMs);
    } catch (error) {
      const handledError = error?.name === 'AbortError' ? new Error(`Timeout after ${REQUEST_TIMEOUT_MS}ms`) : error;
      if (attempt === MAX_RETRIES) throw handledError;
      lastError = handledError;
      const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      await sleep(delayMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('Unable to fetch data');
}

async function main() {
  const response = await fetchWithRetry(WEB_APP_URL);
  const payload = await response.json();
  const wrapped = {
    updatedAt: new Date().toISOString(),
    records: Array.isArray(payload) ? payload : []
  };

  await fs.writeFile(DATA_FILE, JSON.stringify(wrapped, null, 2) + '\n', 'utf8');
  console.log(`Updated data.json at ${wrapped.updatedAt} with ${wrapped.records.length} records.`);
}

main().catch((error) => {
  console.error('Failed to update data.json:', error.message);
  process.exit(1);
});
