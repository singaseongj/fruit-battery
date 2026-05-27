const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxKldbtfwKoROrIaVHF13DBHeHDJF2LnpNdOhObn7cve0CsTYDvrK3zAJQcHbP6S-Bo_g/exec';
const UPDATE_INTERVAL_MS = 60 * 1000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(__dirname));

async function updateDataFile() {
  try {
    const response = await fetch(GOOGLE_SCRIPT_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const wrapped = {
      updatedAt: new Date().toISOString(),
      records: Array.isArray(payload) ? payload : []
    };

    await fs.writeFile(DATA_FILE, JSON.stringify(wrapped, null, 2));
    console.log(`[updater] data.json updated at ${wrapped.updatedAt} with ${wrapped.records.length} record(s)`);
  } catch (error) {
    console.error('[updater] Failed to refresh data.json:', error.message);
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  await updateDataFile();
  setInterval(updateDataFile, UPDATE_INTERVAL_MS);
});
