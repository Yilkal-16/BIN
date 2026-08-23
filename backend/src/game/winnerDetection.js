/**
 * Grid convention: 5x5 array of arrays, grid[row][col], row 0..4 col 0..4.
 * Columns map to B,I,N,G,O left-to-right. Center cell (row2,col2) is the
 * permanent FREE space and is represented as `null` and always "marked".
 */

function isMarked(value, drawnSet) {
  return value === null || drawnSet.has(value);
}

function checkFullHouse(grid, drawnSet) {
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if (!isMarked(grid[r][c], drawnSet)) return false;
    }
  }
  return true;
}

function checkFourCorners(grid, drawnSet) {
  const corners = [grid[0][0], grid[0][4], grid[4][0], grid[4][4]];
  return corners.every((v) => isMarked(v, drawnSet));
}

function checkDiagonals(grid, drawnSet) {
  const main = [0, 1, 2, 3, 4].every((i) => isMarked(grid[i][i], drawnSet));
  const anti = [0, 1, 2, 3, 4].every((i) => isMarked(grid[i][4 - i], drawnSet));
  return main || anti;
}

function checkVerticalLines(grid, drawnSet) {
  for (let c = 0; c < 5; c++) {
    let complete = true;
    for (let r = 0; r < 5; r++) {
      if (!isMarked(grid[r][c], drawnSet)) {
        complete = false;
        break;
      }
    }
    if (complete) return true;
  }
  return false;
}

function checkHorizontalLines(grid, drawnSet) {
  for (let r = 0; r < 5; r++) {
    let complete = true;
    for (let c = 0; c < 5; c++) {
      if (!isMarked(grid[r][c], drawnSet)) {
        complete = false;
        break;
      }
    }
    if (complete) return true;
  }
  return false;
}

function checkXPattern(grid, drawnSet) {
  const main = [0, 1, 2, 3, 4].every((i) => isMarked(grid[i][i], drawnSet));
  const anti = [0, 1, 2, 3, 4].every((i) => isMarked(grid[i][4 - i], drawnSet));
  return main && anti;
}

/**
 * Checks all six equal-weight patterns (§6.6/§7.5) against a single grid.
 * Returns the array of matched pattern names (possibly empty).
 */
function checkAllPatterns(grid, drawnNumbers) {
  const drawnSet = drawnNumbers instanceof Set ? drawnNumbers : new Set(drawnNumbers);
  const matched = [];
  if (checkFullHouse(grid, drawnSet)) matched.push('FULL_HOUSE');
  if (checkXPattern(grid, drawnSet)) matched.push('X_PATTERN');
  if (checkFourCorners(grid, drawnSet)) matched.push('FOUR_CORNERS');
  if (checkDiagonals(grid, drawnSet)) matched.push('DIAGONAL_LINE');
  if (checkVerticalLines(grid, drawnSet)) matched.push('VERTICAL_LINE');
  if (checkHorizontalLines(grid, drawnSet)) matched.push('HORIZONTAL_LINE');
  return matched;
}

/**
 * Evaluates every GameCartela (real players AND system-admin alike — §6.6)
 * against the numbers drawn so far. A cartela satisfying one or more
 * patterns becomes exactly one winner entry, regardless of how many
 * patterns it matched (patterns are recorded for display only).
 *
 * @param {Array<{cartelaId:number, ownerId:string, grid:number[][]}>} cartelasWithGrids
 * @param {number[]} drawnNumbers
 * @returns {Array<{cartelaId:number, ownerId:string, patterns:string[]}>}
 */
function checkWinners(cartelasWithGrids, drawnNumbers) {
  const drawnSet = new Set(drawnNumbers);
  const winners = [];
  for (const cartela of cartelasWithGrids) {
    const matched = checkAllPatterns(cartela.grid, drawnSet);
    if (matched.length > 0) {
      winners.push({ cartelaId: cartela.cartelaId, ownerId: cartela.ownerId, patterns: matched });
    }
  }
  return winners;
}

module.exports = { checkAllPatterns, checkWinners };
