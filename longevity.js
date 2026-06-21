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

function createCell(text) {
  const cell = document.createElement('td');
  cell.textContent = text;
  return cell;
}

function renderTable(entries) {
  const tableBody = document.getElementById('longevityTableBody');
  tableBody.textContent = '';

  if (entries.length === 0) {
    const row = document.createElement('tr');
    const cell = createCell('No longevity entries found.');
    cell.colSpan = 5;
    row.appendChild(cell);
    tableBody.appendChild(row);
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement('tr');
    row.append(
      createCell(formatDate(entry.birth)),
      createCell(formatDate(entry.death)),
      createCell(formatDays(entry.longevityDays)),
      createCell(entry.status || (entry.death ? 'dead' : 'alive')),
      createCell(formatDate(entry.detectedAt))
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
    const entries = Array.isArray(payload.entries) ? [...payload.entries].reverse() : [];

    renderTable(entries);
    summary.textContent = `Showing ${entries.length} longevity entr${entries.length === 1 ? 'y' : 'ies'}. Last workflow update: ${formatDate(payload.updatedAt)}.`;
  } catch (error) {
    console.error('Error loading longevity data:', error);
    renderTable([]);
    summary.textContent = 'Unable to load longevity data.';
  }
}

document.addEventListener('DOMContentLoaded', loadLongevity);
