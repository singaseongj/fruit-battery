const RAW_DATA_FILE_URL = './data.json';
const SEOUL_UTC_OFFSET_HOURS = 9;
const MAX_VISIBLE_RAW_ROWS = 5000;

function toNumber(value) {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : 0;
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

function compareRecordsByTimestamp(recordA, recordB) {
  const timeA = parseSeoulTimestamp(recordA?.timestamp)?.getTime();
  const timeB = parseSeoulTimestamp(recordB?.timestamp)?.getTime();

  if (Number.isFinite(timeA) && Number.isFinite(timeB)) return timeA - timeB;
  if (Number.isFinite(timeA)) return -1;
  if (Number.isFinite(timeB)) return 1;
  return 0;
}

function createCell(text) {
  const cell = document.createElement('td');
  cell.textContent = text;
  return cell;
}

function renderTable(records) {
  const tableBody = document.getElementById('rawDataTableBody');
  tableBody.textContent = '';

  if (records.length === 0) {
    const row = document.createElement('tr');
    const cell = createCell('No records found.');
    cell.colSpan = 4;
    row.appendChild(cell);
    tableBody.appendChild(row);
    return;
  }

  records.forEach((record) => {
    const row = document.createElement('tr');
    row.append(
      createCell(record.timestamp || ''),
      createCell(toNumber(record.voltage).toFixed(2)),
      createCell(toNumber(record.current).toFixed(2)),
      createCell(toNumber(record.power).toFixed(2))
    );
    tableBody.appendChild(row);
  });
}

async function loadRawData() {
  const summary = document.getElementById('rawDataSummary');

  try {
    const cacheBustedUrl = `${RAW_DATA_FILE_URL}?t=${Date.now()}`;
    const response = await fetch(cacheBustedUrl, {
      cache: 'reload',
      headers: { 'Cache-Control': 'no-cache' }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = await response.json();
    const records = Array.isArray(payload.records)
      ? [...payload.records].sort(compareRecordsByTimestamp)
      : [];

    const visibleRecords = records.slice(-MAX_VISIBLE_RAW_ROWS);

    renderTable(visibleRecords);
    summary.textContent =
      `Showing latest ${visibleRecords.length} of ${records.length} record(s), oldest to newest.`;
  } catch (error) {
    console.error('Error loading raw data:', error);
    renderTable([]);
    summary.textContent = 'Unable to load raw data.';
  }
}

document.addEventListener('DOMContentLoaded', loadRawData);
