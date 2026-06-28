const LONGEVITY_FILE_URL = './longevity.json';

function formatDate(timestamp) {
  if (!timestamp) return 'Still alive';
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? String(timestamp) : parsed.toLocaleString();
}

function formatDays(days) {
  const numericDays = Number(days);
  return Number.isFinite(numericDays) ? numericDays.toFixed(3) : '--';
}

function createCell(text, title = '') {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (title) cell.title = title;
  return cell;
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

function formatStatus(entry) {
  if (entry.status) return entry.status;
  return entry.death ? 'dead' : 'alive';
}

function getEntriesWithIds(entries) {
  return sortEntriesByBirth(entries).map((entry, index) => ({
    ...entry,
    id: Number.isInteger(Number(entry.id)) ? Number(entry.id) : index + 1
  }));
}

function formatNoteIndicator(entry) {
  return entry.note ? '!' : '';
}

function renderTable(entries) {
  const tableBody = document.getElementById('longevityTableBody');
  tableBody.textContent = '';

  if (entries.length === 0) {
    const row = document.createElement('tr');
    const cell = createCell('No longevity entries found.');
    cell.colSpan = 6;
    row.appendChild(cell);
    tableBody.appendChild(row);
    return;
  }

  getEntriesWithIds(entries).forEach((entry) => {
    const row = document.createElement('tr');
    row.append(
      createCell(String(entry.id)),
      createCell(formatDate(entry.birth)),
      createCell(formatDate(entry.death)),
      createCell(formatDays(entry.longevityDays)),
      createCell(formatStatus(entry)),
      createCell(formatNoteIndicator(entry), entry.note || '')
    );
    tableBody.appendChild(row);
  });
}

async function loadLongevity() {
  const summary = document.getElementById('longevitySummary');

  try {
    const response = await fetch(`${LONGEVITY_FILE_URL}?t=${Date.now()}`, {
      cache: 'reload',
      headers: { 'Cache-Control': 'no-cache' }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = await response.json();
    const entries = Array.isArray(payload.entries) ? payload.entries : [];

    renderTable(entries);
    summary.textContent = `Showing ${entries.length} longevity entr${entries.length === 1 ? 'y' : 'ies'}. Last updated: ${formatDate(payload.updatedAt)}.`;
  } catch (error) {
    console.error('Error loading longevity data:', error);
    renderTable([]);
    summary.textContent = 'Unable to load longevity data.';
  }
}

document.addEventListener('DOMContentLoaded', loadLongevity);
