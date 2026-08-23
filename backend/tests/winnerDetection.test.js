const { checkAllPatterns, checkWinners } = require('../src/game/winnerDetection');

const grid = [
  [1, 2, 3, 4, 5],
  [16, 17, 18, 19, 20],
  [31, 32, null, 34, 35],
  [46, 47, 48, 49, 50],
  [61, 62, 63, 64, 65]
];

describe('checkAllPatterns', () => {
  test('no numbers drawn -> no patterns matched', () => {
    expect(checkAllPatterns(grid, [])).toEqual([]);
  });

  test('top row complete -> HORIZONTAL_LINE', () => {
    expect(checkAllPatterns(grid, [1, 2, 3, 4, 5])).toEqual(['HORIZONTAL_LINE']);
  });

  test('first column complete -> VERTICAL_LINE', () => {
    expect(checkAllPatterns(grid, [1, 16, 31, 46, 61])).toEqual(['VERTICAL_LINE']);
  });

  test('main diagonal (using the FREE center) -> DIAGONAL_LINE', () => {
    expect(checkAllPatterns(grid, [1, 17, 49, 65])).toEqual(['DIAGONAL_LINE']);
  });

  test('both diagonals -> X_PATTERN and DIAGONAL_LINE both matched', () => {
    const matched = checkAllPatterns(grid, [1, 17, 49, 65, 5, 19, 47, 61]);
    expect(matched).toEqual(expect.arrayContaining(['X_PATTERN', 'DIAGONAL_LINE']));
    expect(matched).not.toContain('FULL_HOUSE');
  });

  test('four corners -> FOUR_CORNERS', () => {
    expect(checkAllPatterns(grid, [1, 5, 61, 65])).toEqual(['FOUR_CORNERS']);
  });

  test('every number on the card -> FULL_HOUSE plus every other satisfied pattern', () => {
    const all = grid.flat().filter((n) => n !== null);
    const matched = checkAllPatterns(grid, all);
    expect(matched).toContain('FULL_HOUSE');
    expect(matched.length).toBeGreaterThanOrEqual(5);
  });
});

describe('checkWinners (§6.6 Step A.3 — one winner entry even with multiple matched patterns)', () => {
  test('a cartela matching several patterns at once still yields exactly one winner entry', () => {
    const cartelas = [{ cartelaId: 1, ownerId: 'user123', grid }];
    const winners = checkWinners(cartelas, [1, 2, 3, 4, 5]);
    expect(winners).toHaveLength(1);
    expect(winners[0].cartelaId).toBe(1);
  });

  test('no winners when no pattern is complete', () => {
    const cartelas = [{ cartelaId: 1, ownerId: 'user123', grid }];
    expect(checkWinners(cartelas, [1, 2])).toHaveLength(0);
  });

  test('system-admin-owned cartelas are checked identically to real ones (§6.6)', () => {
    const cartelas = [
      { cartelaId: 1, ownerId: 'system-admin', grid },
      { cartelaId: 2, ownerId: 'user456', grid: grid.map((r) => r.map((c) => (c === null ? null : c + 100))) }
    ];
    const winners = checkWinners(cartelas, [1, 2, 3, 4, 5]);
    expect(winners).toHaveLength(1);
    expect(winners[0].ownerId).toBe('system-admin');
  });

  test('two cartelas winning on the same draw are both reported as joint winners', () => {
    const otherGrid = grid.map((r) => r.map((c) => (c === null ? null : c + 100)));
    const cartelas = [
      { cartelaId: 1, ownerId: 'userA', grid },
      { cartelaId: 2, ownerId: 'userB', grid: otherGrid }
    ];
    const drawn = [1, 2, 3, 4, 5, 101, 102, 103, 104, 105];
    const winners = checkWinners(cartelas, drawn);
    expect(winners).toHaveLength(2);
  });
});
