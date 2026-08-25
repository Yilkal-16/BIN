const SELECTION_TIME = Number(process.env.CARTELA_SELECTION_TIME || 45);
const TICK_INTERVAL = 5; // seconds — "checks total sold every 5 seconds" (§6.3)

module.exports = { SELECTION_TIME, TICK_INTERVAL };
