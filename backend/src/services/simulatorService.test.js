const { simulateTopThree } = require('./simulatorService');

function makeCartela(cartelaId, firstRow) {
  const grid = [
    firstRow,
    [16, 17, 18, 19, 20],
    [21, 22, null, 24, 25],
    [26, 27, 28, 29, 30],
    [31, 32, 33, 34, 35]
  ];
  return { cartelaId, grid };
}

test('returns the first three cartelas in deterministic draw order', () => {
  const cartelas = [
    makeCartela(1, [1, 2, 3, 4, 5]),
    makeCartela(2, [6, 7, 8, 9, 10]),
    makeCartela(3, [11, 12, 13, 14, 15])
  ];

  const sequence = [
    1, 2, 3, 4, 5,
    6, 7, 8, 9, 10,
    11, 12, 13, 14, 15,
    ...Array.from({ length: 60 }, (_, i) => i + 16)
  ];

  const winners = simulateTopThree(sequence, cartelas);

  expect(winners.map((w) => w.cartelaId)).toEqual([1, 2, 3]);
  expect(winners.map((w) => w.drawIndex)).toEqual([5, 10, 15]);
});

test('breaks same-draw ties by cartelaId', () => {
  const cartelas = [
    makeCartela(2, [1, 2, 3, 4, 5]),
    makeCartela(1, [1, 2, 3, 4, 5]),
    makeCartela(3, [1, 2, 3, 4, 5])
  ];

  const sequence = [
    1, 2, 3, 4, 5,
    ...Array.from({ length: 70 }, (_, i) => i + 6)
  ];

  const winners = simulateTopThree(sequence, cartelas);
  expect(winners.map((w) => w.cartelaId)).toEqual([1, 2, 3]);
});
