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

function getEntryId(entry) {
  const id = Number(entry?.id);
  return Number.isFinite(id) ? id : -Infinity;
}

function sortEntriesById(entries) {
  return [...entries].sort((entryA, entryB) => getEntryId(entryB) - getEntryId(entryA));
}

function formatStatus(entry) {
  if (entry.status) return entry.status;
  return entry.death ? 'dead' : 'alive';
}

function getEntriesWithIds(entries) {
  return sortEntriesById(entries).map((entry, index) => ({
    ...entry,
    id: Number.isInteger(Number(entry.id)) ? Number(entry.id) : index + 1
  }));
}

function closeNoteTooltip() {
  document.querySelector('.note-tooltip')?.remove();
}

function positionNoteTooltip(tooltip, button) {
  const buttonRect = button.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const margin = 12;
  const top = Math.min(
    window.scrollY + buttonRect.bottom + 8,
    window.scrollY + window.innerHeight - tooltipRect.height - margin
  );
  const left = Math.min(
    Math.max(window.scrollX + buttonRect.left, window.scrollX + margin),
    window.scrollX + window.innerWidth - tooltipRect.width - margin
  );

  tooltip.style.top = `${Math.max(window.scrollY + margin, top)}px`;
  tooltip.style.left = `${left}px`;
}

function showNoteTooltip(note, button, entryId) {
  closeNoteTooltip();

  const tooltip = document.createElement('div');
  tooltip.className = 'note-tooltip';
  tooltip.setAttribute('role', 'dialog');
  tooltip.setAttribute('aria-label', 'Longevity note');
  tooltip.dataset.noteId = String(entryId);
  tooltip.textContent = note;
  document.body.appendChild(tooltip);
  positionNoteTooltip(tooltip, button);
}

function createNoteCell(entry) {
  const cell = document.createElement('td');
  if (!entry.note) return cell;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'note-indicator';
  button.textContent = '!';
  button.setAttribute('aria-label', `Show note for longevity ID ${entry.id}`);
  button.addEventListener('click', (event) => {
    event.stopPropagation();

    const currentTooltip = document.querySelector('.note-tooltip');
    if (currentTooltip?.dataset.noteId === String(entry.id)) {
      closeNoteTooltip();
      return;
    }

    showNoteTooltip(entry.note, button, entry.id);
  });
  cell.appendChild(button);

  return cell;
}

function getTimelineEvents(entry) {
  return Array.isArray(entry.timeline) ? entry.timeline : [];
}

function createTimelineDetailsCell(event) {
  const cell = document.createElement('td');
  cell.colSpan = 5;

  const wrapper = document.createElement('div');
  wrapper.className = 'timeline-details';

  const timestamp = document.createElement('span');
  timestamp.className = 'timeline-date';
  timestamp.textContent = formatDate(event.at || event.detectedAt);

  const note = document.createElement('span');
  note.className = 'timeline-note';
  note.textContent = event.note || 'Timeline event recorded.';

  wrapper.append(timestamp, note);
  cell.appendChild(wrapper);

  return cell;
}

function renderTimelineRows(tableBody, entry) {
  getTimelineEvents(entry).forEach((event) => {
    const row = document.createElement('tr');
    row.className = 'timeline-row';
    row.append(
      createCell(String(event.id || `${entry.id}-?`)),
      createTimelineDetailsCell(event)
    );
    tableBody.appendChild(row);
  });
}

function countTimelineEvents(entries) {
  return entries.reduce((count, entry) => count + getTimelineEvents(entry).length, 0);
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
      createNoteCell(entry)
    );
    tableBody.appendChild(row);
    renderTimelineRows(tableBody, entry);
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
    const entries = Array.isArray(payload) ? payload : (Array.isArray(payload.entries) ? payload.entries : []);

    renderTable(entries);
    const timelineCount = countTimelineEvents(entries);
    const timelineText = timelineCount === 0 ? '' : ` Includes ${timelineCount} timeline event${timelineCount === 1 ? '' : 's'}.`;
    summary.textContent = `Showing ${entries.length} longevity entr${entries.length === 1 ? 'y' : 'ies'}.${timelineText} Last updated: ${formatDate(payload.updatedAt)}.`;
  } catch (error) {
    console.error('Error loading longevity data:', error);
    renderTable([]);
    summary.textContent = 'Unable to load longevity data.';
  }
}

document.addEventListener('click', closeNoteTooltip);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeNoteTooltip();
});
document.addEventListener('DOMContentLoaded', loadLongevity);
