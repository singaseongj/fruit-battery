const fs = require('fs/promises');
const path = require('path');

const WEB_APP_URL = process.env.WEB_APP_URL;
const DATA_FILE = path.join(__dirname, '..', 'data.json');
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RECORDS = 5_000;
const SEOUL_UTC_OFFSET_HOURS = 9;
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function parseSeoulTimestamp(timestamp) {
  if (!timestamp) return null;

  if (timestamp instanceof Date) {
    return Number.isNaN(timestamp.getTime()) ? null : timestamp;
  }

  const timestampText = String(timestamp).trim();
  const koreanDateMatch = timestampText.match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(오전|오후)\s*(\d{1,2}):(\d{2}):(\d{2})$/);

  if (koreanDateMatch) {
    const [, year, month, day, meridiem, hourText, minuteText, secondText] = koreanDateMatch;
    let hour = Number(hourText);

    if (meridiem === '오전' && hour === 12) hour = 0;
    if (meridiem === '오후' && hour < 12) hour += 12;

    const utcTime = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      hour - SEOUL_UTC_OFFSET_HOURS,
      Number(minuteText),
      Number(secondText)
    );

    return new Date(utcTime);
  }

  const parsed = new Date(timestampText);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getRecordTimestampMs(record) {
  const parsed = parseSeoulTimestamp(record?.timestamp);
  return parsed ? parsed.getTime() : null;
}

function selectMostRecentRecords(records, maxRecords = MAX_RECORDS) {
  return records
    .map((record, index) => ({ record, index, timestampMs: getRecordTimestampMs(record) }))
    .sort((recordA, recordB) => {
      const timeA = recordA.timestampMs;
      const timeB = recordB.timestampMs;

      if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeA - timeB;
      if (Number.isFinite(timeA) && !Number.isFinite(timeB)) return 1;
      if (!Number.isFinite(timeA) && Number.isFinite(timeB)) return -1;
      return recordA.index - recordB.index;
    })
    .slice(-maxRecords)
    .map(({ record }) => record);
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
  if (!WEB_APP_URL) {
    throw new Error('Missing WEB_APP_URL environment variable');
  }

  const response = await fetchWithRetry(WEB_APP_URL);
  const payload = await response.json();
  const records = Array.isArray(payload) ? selectMostRecentRecords(payload) : [];
  const wrapped = {
    updatedAt: new Date().toISOString(),
    records
  };

  await fs.writeFile(DATA_FILE, JSON.stringify(wrapped, null, 2) + '\n', 'utf8');
  console.log(`Updated data.json at ${wrapped.updatedAt} with ${wrapped.records.length} of ${Array.isArray(payload) ? payload.length : 0} records.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Failed to update data.json:', error.message);
    process.exit(1);
  });
}

module.exports = {
  MAX_RECORDS,
  parseSeoulTimestamp,
  selectMostRecentRecords
};
