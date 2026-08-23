require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Cartela = require('../backend/src/models/Cartela');

function parseCsv(text) {
  const [headerLine, ...lines] = text.trim().split('\n');
  const headers = headerLine.split(',');
  return lines.map((line) => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

function rowToGrid(row) {
  const cols = ['B', 'I', 'N', 'G', 'O'];
  const grid = [[], [], [], [], []]; // grid[row][col]
  cols.forEach((letter, c) => {
    for (let r = 0; r < 5; r++) {
      const raw = row[`${letter}${r + 1}`];
      grid[r][c] = raw === '' || raw === undefined ? null : Number(raw);
    }
  });
  return grid;
}

async function main() {
  const csvPath = process.argv[2] || path.join(__dirname, '..', 'data', 'cartelas.csv');
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV not found at ${csvPath}. Run "node scripts/generateCartelaCsv.js" first, or pass a path.`);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB_NAME || 'bingo_db' });
  console.log('Connected to MongoDB');

  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  console.log(`Parsed ${rows.length} cartelas from CSV`);

  let created = 0;
  let updated = 0;
  for (const row of rows) {
    const cartelaId = Number(row.cartelaId);
    const grid = rowToGrid(row);
    const result = await Cartela.findOneAndUpdate(
      { cartelaId },
      { $setOnInsert: { cartelaId, grid, isReserved: false } },
      { upsert: true, new: false }
    );
    if (result) updated += 1;
    else created += 1;
  }

  console.log(`Import complete: ${created} created, ${updated} already existed (left untouched).`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
