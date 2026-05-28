const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const WEB_APP_URL = process.env.WEB_APP_URL;
const UPDATE_INTERVAL_MS = 60 * 1000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(__dirname));

async function fetchRealtimeRecords() {
  if (!WEB_APP_URL) {
    throw new Error('Missing WEB_APP_URL environment variable');
  }

  const response = await fetch(WEB_APP_URL, { headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

async function updateDataFile() {
  try {
    const records = await fetchRealtimeRecords();
    const wrapped = { updatedAt: new Date().toISOString(), records };
    await fs.writeFile(DATA_FILE, JSON.stringify(wrapped, null, 2));
    console.log(`[updater] data.json updated at ${wrapped.updatedAt} with ${wrapped.records.length} record(s)`);
  } catch (error) {
    console.error('[updater] Failed to refresh data.json:', error.message);
  }
}

app.get('/api/realtime', async (_req, res) => {
  try {
    const records = await fetchRealtimeRecords();
    res.json({ updatedAt: new Date().toISOString(), records });
  } catch (error) {
    res.status(500).json({ error: error.message, records: [] });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  await updateDataFile();
  setInterval(updateDataFile, UPDATE_INTERVAL_MS);
});
