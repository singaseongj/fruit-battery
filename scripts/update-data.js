const fs = require('fs/promises');
const path = require('path');

const WEB_APP_URL = process.env.WEB_APP_URL;
const DATA_FILE = path.join(__dirname, '..', 'data.json');
const LONGEVITY_FILE = path.join(__dirname, '..', 'longevity.json');
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RECORDS = 20_000;
const SEOUL_UTC_OFFSET_HOURS = 9;
const MAX_RETRIES = 4;
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

async function fetchWithRetry(url) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const attemptStartedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    console.log(`[update-data] Fetch attempt ${attempt}/${MAX_RETRIES} started with ${REQUEST_TIMEOUT_MS}ms timeout.`);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'cache-control': 'no-cache'
        }
      });

      console.log(`[update-data] Fetch attempt ${attempt}/${MAX_RETRIES} received HTTP ${response.status} in ${formatDurationMs(attemptStartedAt)}.`);

      if (response.ok) return response;

      const error = new Error(`HTTP ${response.status}`);
      if (!isRetryableStatus(response.status) || attempt === MAX_RETRIES) throw error;

      lastError = error;
      const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.log(`[update-data] Fetch attempt ${attempt}/${MAX_RETRIES} retrying after ${delayMs}ms due to ${error.message}.`);
      await sleep(delayMs);
    } catch (error) {
      const handledError = error?.name === 'AbortError' ? new Error(`Timeout after ${REQUEST_TIMEOUT_MS}ms`) : error;
      console.error(`[update-data] Fetch attempt ${attempt}/${MAX_RETRIES} failed after ${formatDurationMs(attemptStartedAt)}: ${handledError.message}`);
      if (attempt === MAX_RETRIES) throw handledError;
      lastError = handledError;
      const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.log(`[update-data] Fetch attempt ${attempt}/${MAX_RETRIES} retrying after ${delayMs}ms.`);
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
  const response = await measureStep('fetching remote data', () => fetchWithRetry(WEB_APP_URL));
  const payload = await measureStep('parsing remote JSON response', () => response.json());
  const { fetchedRecords, hasNewData, records, wrapped } = await measureStep('preparing data.json payload', async () => {
    const fetchedRecords = Array.isArray(payload) ? selectMostRecentRecords(payload) : [];
    const hasNewData = hasNewerRecords(fetchedRecords, currentData.records);
    const records = hasNewData ? fetchedRecords : currentData.records;
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

  const fetchedCount = Array.isArray(payload) ? payload.length : 0;
  console.log(`[update-data] Prepared ${fetchedRecords.length} selected record(s); writing ${records.length} record(s).`);
  if (hasNewData) {
    console.log(`Updated data.json at ${wrapped.updatedAt} with ${wrapped.records.length} of ${fetchedCount} records.`);
  } else {
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
  MAX_RECORDS,
  NO_NEWER_DATA_REASON,
  CONNECTION_LOSS_DEAD_THRESHOLD_MS,
  CONNECTION_LOSS_IGNORE_THRESHOLD_MS,
  calculateLongevityDays,
  getConnectionLossDetails,
  getCurrentConnectionStartedAt,
  getLatestTimestampMs,
  hasNewerRecords,
  parseSeoulTimestamp,
  selectMostRecentRecords,
  updateLongevityLog
};
