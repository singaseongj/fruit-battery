const fs = require('fs/promises');
const path = require('path');
const { MAX_RECORDS, migrateDataPayload } = require('./update-data');

async function main() {
  const dataFile = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data.json'));
  const originalText = await fs.readFile(dataFile, 'utf8');
  const original = JSON.parse(originalText);
  const originalCount = Array.isArray(original.records) ? original.records.length : 0;
  const migrated = migrateDataPayload(original);

  await fs.writeFile(dataFile, `${JSON.stringify(migrated, null, 2)}\n`, 'utf8');
  console.log(`Migrated ${dataFile}: ${originalCount} -> ${migrated.records.length} records (limit ${MAX_RECORDS}).`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Failed to migrate data.json: ${error.message}`);
    process.exit(1);
  });
}
