const fs = require('fs/promises');
const path = require('path');

const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxKldbtfwKoROrIaVHF13DBHeHDJF2LnpNdOhObn7cve0CsTYDvrK3zAJQcHbP6S-Bo_g/exec';
const DATA_FILE = path.join(__dirname, '..', 'data.json');

async function main() {
  const response = await fetch(GOOGLE_SCRIPT_URL);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

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
