const fs = require('fs/promises');
const path = require('path');

const WEB_APP_URL = process.env.WEB_APP_URL;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data.json');
const LONGEVITY_FILE = process.env.LONGEVITY_FILE || path.join(__dirname, '..', 'longevity.json');
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_RECORDS = 5_000;
const SEOUL_UTC_OFFSET_HOURS = 9;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const NO_NEWER_DATA_REASON = 'no-newer-data';
const CONNECTION_LOSS_IGNORE_THRESHOLD_MS = 2 * 60 * 1000;
const CONNECTION_LOSS_DEAD_THRESHOLD_MS = 60 * 60 * 1000;
const CONNECTION_GAP_THRESHOLD_MS = CONNECTION_LOSS_DEAD_THRESHOLD_MS;
const DAY_MS = 24 * 60 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDurationMs(startedAt) {
  return `${Date.now() - startedAt}ms`;
}

async function measureStep(label, operation) {
  const startedAt = Date.now();
  console.log(`[update-data] Starting ${label}...`);

  try {
    const result = await operation();
    console.log(`[update-data] Finished ${label} in ${formatDurationMs(startedAt)}.`);
    return result;
  } catch (error) {
    console.error(`[update-data] Failed ${label} after ${formatDurationMs(startedAt)}: ${error.message}`);
    throw error;
  }
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function sanitizeBodyPrefix(body, maxLength = 160) {
  return body.slice(0, maxLength).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function validatePayload(payload) {
  if (!Array.isArray(payload)) throw new Error('Unexpected payload: expected an array of records');

  const invalidIndex = payload.findIndex((record) => !isValidRecord(record));
  if (invalidIndex !== -1) throw new Error(`Unexpected payload: invalid record at index ${invalidIndex}`);
  return payload;
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

function isValidRecord(record) {
  return Boolean(record)
    && typeof record === 'object'
    && !Array.isArray(record)
    && Number.isFinite(getRecordTimestampMs(record));
}

function sortRecordsByTimestamp(records) {
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
    .map(({ record }) => record);
}

function selectMostRecentRecords(records, maxRecords = MAX_RECORDS) {
  return sortRecordsByTimestamp(records).slice(-maxRecords);
}

function mergeRecentRecords(currentRecords, fetchedRecords, maxRecords = MAX_RECORDS) {
  const recordsByIdentity = new Map();
  for (const record of [...currentRecords, ...fetchedRecords]) {
    const timestampMs = getRecordTimestampMs(record);
    const identity = Number.isFinite(timestampMs) ? `timestamp:${timestampMs}` : `record:${JSON.stringify(record)}`;
    recordsByIdentity.set(identity, record);
  }
  return selectMostRecentRecords([...recordsByIdentity.values()], maxRecords);
}

function migrateDataPayload(payload, maxRecords = MAX_RECORDS) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid data.json payload');
  }

  const records = Array.isArray(payload.records) ? payload.records.filter(isValidRecord) : [];
  return { ...payload, records: selectMostRecentRecords(records, maxRecords) };
}

function getLatestTimestampMs(records) {
  if (!Array.isArray(records) || records.length === 0) return null;

  return records.reduce((latestTimestampMs, record) => {
    const timestampMs = getRecordTimestampMs(record);

    if (!Number.isFinite(timestampMs)) return latestTimestampMs;
    if (!Number.isFinite(latestTimestampMs) || timestampMs > latestTimestampMs) return timestampMs;

    return latestTimestampMs;
  }, null);
}

function hasNewerRecords(fetchedRecords, currentRecords) {
  if (!Array.isArray(fetchedRecords) || fetchedRecords.length === 0) return false;
  if (!Array.isArray(currentRecords) || currentRecords.length === 0) return true;

  const fetchedLatestTimestampMs = getLatestTimestampMs(fetchedRecords);
  const currentLatestTimestampMs = getLatestTimestampMs(currentRecords);

  if (!Number.isFinite(fetchedLatestTimestampMs)) return false;
  if (!Number.isFinite(currentLatestTimestampMs)) return true;

  return fetchedLatestTimestampMs > currentLatestTimestampMs;
}

async function readCurrentData() {
  try {
    const currentDataText = await fs.readFile(DATA_FILE, 'utf8');
    const currentData = JSON.parse(currentDataText);

    return {
      updatedAt: currentData?.updatedAt || null,
      records: Array.isArray(currentData?.records) ? currentData.records : []
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { updatedAt: null, records: [] };
    throw error;
  }
}


function toIsoString(timestampMs) {
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null;
}

function calculateLongevityDays(birthMs, deathMs) {
  if (!Number.isFinite(birthMs) || !Number.isFinite(deathMs)) return null;
  return Number(((Math.max(0, deathMs - birthMs)) / DAY_MS).toFixed(3));
}

function getCurrentConnectionStartedAt(records) {
  const timestamps = sortRecordsByTimestamp(records)
    .map(getRecordTimestampMs)
    .filter(Number.isFinite);

  if (timestamps.length === 0) return null;

  let startedAt = timestamps[0];
  for (let index = 1; index < timestamps.length; index += 1) {
    if (timestamps[index] - timestamps[index - 1] > CONNECTION_GAP_THRESHOLD_MS) {
      startedAt = timestamps[index];
    }
  }

  return startedAt;
}

function sortEntriesByBirth(entries) {
  return [...entries].sort((entryA, entryB) => {
    const birthA = Date.parse(entryA.birth);
    const birthB = Date.parse(entryB.birth);

    if (Number.isFinite(birthA) && Number.isFinite(birthB) && birthA !== birthB) return birthA - birthB;
    if (Number.isFinite(birthA) && !Number.isFinite(birthB)) return -1;
    if (!Number.isFinite(birthA) && Number.isFinite(birthB)) return 1;
    return 0;
  });
}

function getEntriesWithStableIds(entries) {
  let nextId = entries.reduce((maxId, entry) => {
    const id = Number(entry?.id);
    return Number.isInteger(id) && id > maxId ? id : maxId;
  }, 0) + 1;

  return sortEntriesByBirth(entries).map((entry) => {
    const id = Number(entry?.id);
    if (Number.isInteger(id) && id > 0) return { ...entry, id };

    const entryWithId = { ...entry, id: nextId };
    nextId += 1;
    return entryWithId;
  });
}

function getOpenPrimaryEntry(entries) {
  return entries.find((entry) => !entry.death && String(entry.status || 'alive').toLowerCase() !== 'dead');
}

function getNextTimelineId(entry) {
  const parentId = Number.isInteger(Number(entry?.id)) ? Number(entry.id) : 1;
  const timeline = Array.isArray(entry?.timeline) ? entry.timeline : [];
  const maxChildNumber = timeline.reduce((maxChild, event) => {
    const match = String(event?.id || '').match(new RegExp(`^${parentId}-(\\d+)$`));
    const childNumber = match ? Number(match[1]) : 0;
    return Number.isInteger(childNumber) && childNumber > maxChild ? childNumber : maxChild;
  }, 0);

  return `${parentId}-${maxChildNumber + 1}`;
}

function addTimelineEvent(entry, event) {
  const timeline = Array.isArray(entry.timeline) ? entry.timeline : [];
  const eventAt = event.at || event.death || event.detectedAt;
  const duplicate = timeline.some((existingEvent) => (
    existingEvent.note === event.note
    && (existingEvent.at || existingEvent.death || existingEvent.detectedAt) === eventAt
  ));

  if (duplicate) return entry;

  return {
    ...entry,
    timeline: [
      ...timeline,
      {
        id: getNextTimelineId(entry),
        ...event,
        at: eventAt
      }
    ]
  };
}

async function readCurrentLongevity() {
  try {
    const longevityText = await fs.readFile(LONGEVITY_FILE, 'utf8');
    const longevity = JSON.parse(longevityText);
    return {
      updatedAt: longevity?.updatedAt || null,
      entries: Array.isArray(longevity?.entries) ? getEntriesWithStableIds(longevity.entries) : []
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { updatedAt: null, entries: [] };
    throw error;
  }
}


function getConnectionLossDetails(latestTimestampMs, updatedAt) {
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(latestTimestampMs) || !Number.isFinite(updatedAtMs)) {
    return { missingMs: 0, note: null, status: 'alive' };
  }

  const missingMs = Math.max(0, updatedAtMs - latestTimestampMs);
  if (missingMs < CONNECTION_LOSS_IGNORE_THRESHOLD_MS) {
    return { missingMs, note: null, status: 'alive' };
  }

  if (missingMs < CONNECTION_LOSS_DEAD_THRESHOLD_MS) {
    const missingMinutes = Math.floor(missingMs / (60 * 1000));
    return {
      missingMs,
      note: `connection loss for ${missingMinutes} minutes`,
      status: 'alive'
    };
  }

  return {
    missingMs,
    note: 'connection loss for more than 60 minutes',
    status: 'dead'
  };
}

function withOptionalNote(entry, note) {
  if (note) return { ...entry, note };
  if (entry.note) return entry;

  const { note: _note, ...entryWithoutNote } = entry;
  return entryWithoutNote;
}

function updateAliveLongevityEntries(entries, detectedAt) {
  const nowMs = Date.parse(detectedAt);
  const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();

  return entries.map((entry) => {
    if (entry.death || String(entry.status || '').toLowerCase() === 'dead') return entry;

    const birthMs = Date.parse(entry.birth);
    if (!Number.isFinite(birthMs)) return { ...entry, detectedAt, status: 'alive' };

    return {
      ...entry,
      death: null,
      status: 'alive',
      detectedAt,
      longevityDays: calculateLongevityDays(birthMs, effectiveNowMs)
    };
  });
}

function updateLongevityLog(currentLongevity, records, connected, updatedAt) {
  let entries = updateAliveLongevityEntries([...currentLongevity.entries], updatedAt);
  const latestTimestampMs = getLatestTimestampMs(records);
  const birthMs = getCurrentConnectionStartedAt(records);
  const detectedAt = updatedAt;

  if (!Number.isFinite(birthMs)) {
    return { updatedAt, entries: getEntriesWithStableIds(entries) };
  }

  const birth = toIsoString(birthMs);
  const lastEntry = entries[entries.length - 1];
  const hasOpenEntries = entries.some((entry) => !entry.death && String(entry.status || 'alive').toLowerCase() !== 'dead');

  const connectionLoss = connected
    ? { note: null, status: 'alive' }
    : getConnectionLossDetails(latestTimestampMs, updatedAt);

  if (connectionLoss.note) {
    console.log(`[update-data] Longevity note: ${connectionLoss.note}.`);
  }

  const primaryOpenEntry = getOpenPrimaryEntry(entries);

  if (connectionLoss.note && primaryOpenEntry) {
    entries = entries.map((entry) => (entry === primaryOpenEntry ? addTimelineEvent(entry, {
      at: Number.isFinite(latestTimestampMs) ? toIsoString(latestTimestampMs) : detectedAt,
      detectedAt,
      note: connectionLoss.note
    }) : entry));
  }

  if (connected || connectionLoss.status === 'alive') {
    if (!hasOpenEntries) {
      const nowMs = Date.parse(updatedAt);
      entries.push(withOptionalNote({
        birth,
        death: null,
        status: 'alive',
        detectedAt,
        longevityDays: calculateLongevityDays(birthMs, Number.isFinite(nowMs) ? nowMs : Date.now())
      }, connectionLoss.note));
    }

    return { updatedAt, entries: getEntriesWithStableIds(entries) };
  }

  const deathMs = Number.isFinite(latestTimestampMs) ? latestTimestampMs : Date.parse(updatedAt);
  const death = toIsoString(deathMs);
  const deadEntry = withOptionalNote({
    ...(lastEntry?.birth === birth ? lastEntry : {}),
    birth,
    death,
    status: 'dead',
    detectedAt,
    longevityDays: calculateLongevityDays(birthMs, deathMs)
  }, connectionLoss.note);

  if (lastEntry?.birth === birth) entries[entries.length - 1] = deadEntry;
  else if (primaryOpenEntry) {
    entries = entries.map((entry) => (entry === primaryOpenEntry ? withOptionalNote({
      ...entry,
      death,
      status: 'dead',
      detectedAt,
      longevityDays: calculateLongevityDays(Date.parse(entry.birth), deathMs)
    }, connectionLoss.note) : entry));
  } else entries.push(deadEntry);

  return { updatedAt, entries: getEntriesWithStableIds(entries) };
}

async function fetchWithRetry(url, options = {}) {
  const fetchImplementation = options.fetchImplementation || fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const attemptStartedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    console.log(`[update-data] Fetch attempt ${attempt}/${maxRetries} started with ${timeoutMs}ms timeout.`);

    try {
      const response = await fetchImplementation(url, {
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'cache-control': 'no-cache'
        }
      });

      const contentType = response.headers.get('content-type') || '(missing)';
      const body = await response.text();
      console.log(`[update-data] Fetch attempt ${attempt}/${maxRetries} received HTTP ${response.status} in ${formatDurationMs(attemptStartedAt)}.`);

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.retryable = isRetryableStatus(response.status);
        throw error;
      }

      try {
        const payload = JSON.parse(body);
        validatePayload(payload);
        console.log(`[update-data] Remote fetch succeeded: HTTP ${response.status}, ${body.length} byte(s), ${payload.length} record(s).`);
        return payload;
      } catch (error) {
        console.error(`[update-data] Invalid response: HTTP ${response.status}; Content-Type ${contentType}; body length ${body.length}; prefix=${JSON.stringify(sanitizeBodyPrefix(body))}`);
        error.retryable = true;
        throw error;
      }
    } catch (error) {
      const handledError = error?.name === 'AbortError' ? new Error(`Timeout after ${timeoutMs}ms`) : error;
      console.error(`[update-data] Fetch attempt ${attempt}/${maxRetries} failed after ${formatDurationMs(attemptStartedAt)}: ${handledError.message}`);
      if (handledError.retryable === false || attempt === maxRetries) throw handledError;
      lastError = handledError;
      const delayMs = retryBaseDelayMs * 2 ** (attempt - 1);
      console.log(`[update-data] Fetch attempt ${attempt}/${maxRetries} retrying after ${delayMs}ms.`);
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

  const currentData = await measureStep('reading current data.json', readCurrentData);
  const currentLongevity = await measureStep('reading current longevity.json', readCurrentLongevity);
  const requestUrl = WEB_APP_URL;
  console.log(`[update-data] Remote fetch started at ${new Date().toISOString()} (URL hidden; using configured WEB_APP_URL).`);
  const payload = await measureStep('fetching, parsing, and validating remote data', () => fetchWithRetry(requestUrl));
  const { fetchedRecords, hasNewData, records, wrapped } = await measureStep('preparing data.json payload', async () => {
    const fetchedRecords = selectMostRecentRecords(payload);
    const hasNewData = hasNewerRecords(fetchedRecords, currentData.records);
    const records = hasNewData
      ? mergeRecentRecords(currentData.records, fetchedRecords)
      : selectMostRecentRecords(currentData.records);
    const wrapped = {
      updatedAt: new Date().toISOString(),
      connected: hasNewData,
      hasNewData,
      disconnectedReason: hasNewData ? null : NO_NEWER_DATA_REASON,
      records
    };

    return { fetchedRecords, hasNewData, records, wrapped };
  });

  await measureStep('writing data.json', () => fs.writeFile(DATA_FILE, JSON.stringify(wrapped, null, 2) + '\n', 'utf8'));

  const longevity = await measureStep('preparing longevity.json payload', () =>
    Promise.resolve(updateLongevityLog(currentLongevity, records, hasNewData, wrapped.updatedAt))
  );
  await measureStep('writing longevity.json', () => fs.writeFile(LONGEVITY_FILE, JSON.stringify(longevity, null, 2) + '\n', 'utf8'));

  const fetchedCount = payload.length;
  console.log(`[update-data] Prepared ${fetchedRecords.length} selected record(s); writing ${records.length} record(s).`);
  if (hasNewData) {
    console.log(`[update-data] Data changed at ${wrapped.updatedAt}.`);
    console.log(`Updated data.json at ${wrapped.updatedAt} with ${wrapped.records.length} of ${fetchedCount} records.`);
  } else {
    console.log(`[update-data] No newer data at ${wrapped.updatedAt}.`);
    console.log(`No newer data fetched at ${wrapped.updatedAt}; kept ${wrapped.records.length} current record(s) and marked disconnected.`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Failed to update data.json:', error.message);
    process.exit(1);
  });
}

module.exports = {
  REQUEST_TIMEOUT_MS,
  MAX_RETRIES,
  MAX_RECORDS,
  NO_NEWER_DATA_REASON,
  CONNECTION_LOSS_DEAD_THRESHOLD_MS,
  CONNECTION_LOSS_IGNORE_THRESHOLD_MS,
  calculateLongevityDays,
  fetchWithRetry,
  getConnectionLossDetails,
  getCurrentConnectionStartedAt,
  getLatestTimestampMs,
  hasNewerRecords,
  isValidRecord,
  mergeRecentRecords,
  migrateDataPayload,
  parseSeoulTimestamp,
  selectMostRecentRecords,
  validatePayload,
  updateLongevityLog
};
