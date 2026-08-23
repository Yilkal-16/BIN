/**
 * Generates data/cartelas.csv: 600 unique, valid 75-ball Bingo cards.
 *
 * Column ranges (§6.1): B 1-15, I 16-30, N 31-45 (free center), G 46-60, O 61-75.
 * Each column draws 5 unique numbers from its 15-number range without
 * replacement — the standard construction for a 75-ball card — so every
 * generated card is internally valid by definition. Full-grid collisions
 * across all 600 cards are checked and are, in practice, astronomically
 * unlikely (each column alone has 15!/10! ≈ 360,360 orderings).
 */
const fs = require('fs');
const path = require('path');

const COLUMNS = [
  { letter: 'B', min: 1, max: 15 },
  { letter: 'I', min: 16, max: 30 },
  { letter: 'N', min: 31, max: 45 },
  { letter: 'G', min: 46, max: 60 },
  { letter: 'O', min: 61, max: 75 }
];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateCard() {
  const columns = COLUMNS.map(({ min, max }) => {
    const pool = Array.from({ length: max - min + 1 }, (_, i) => min + i);
    return shuffle(pool).slice(0, 5);
  });
  // columns[c][r] -> grid[r][c], with N-column's middle cell (r=2) as FREE.
  const grid = [];
  for (let r = 0; r < 5; r++) {
    const row = [];
    for (let c = 0; c < 5; c++) {
      row.push(r === 2 && c === 2 ? null : columns[c][r]);
    }
    grid.push(row);
  }
  return grid;
}

function gridSignature(grid) {
  return grid.map((row) => row.map((v) => (v === null ? '_' : v)).join(',')).join('|');
}

function main() {
  const count = 600;
  const seen = new Set();
  const cards = [];

  while (cards.length < count) {
    const grid = generateCard();
    const sig = gridSignature(grid);
    if (seen.has(sig)) continue; // practically never happens; guards anyway
    seen.add(sig);
    cards.push(grid);
  }

  const header = 'cartelaId,B1,B2,B3,B4,B5,I1,I2,I3,I4,I5,N1,N2,N3,N4,N5,G1,G2,G3,G4,G5,O1,O2,O3,O4,O5';
  const lines = [header];

  cards.forEach((grid, idx) => {
    // Columns in CSV order: B(col0) I(col1) N(col2) G(col3) O(col4), each top-to-bottom.
    const values = [];
    for (let c = 0; c < 5; c++) {
      for (let r = 0; r < 5; r++) {
        const v = grid[r][c];
        values.push(v === null ? '' : v);
      }
    }
    lines.push(`${idx + 1},${values.join(',')}`);
  });

  const outPath = path.join(__dirname, '..', 'data', 'cartelas.csv');
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`Wrote ${cards.length} cartelas to ${outPath}`);
}

main();
