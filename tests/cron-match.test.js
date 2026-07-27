const test = require('node:test');
const assert = require('node:assert');
const { compileCron, cronMatchesAt, cronFiredInWindow } = require('../shared/cron-match.js');

// Schedules are expressed in Asia/Dhaka (fixed UTC+6); epochs here are UTC.
const utc = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) / 1000;

test('daily 8am Dhaka fires at 02:00 UTC, not 08:00 UTC', () => {
  const c = compileCron('0 8 * * *');
  assert.equal(cronMatchesAt(c, utc(2026, 7, 20, 2, 0)), true);
  assert.equal(cronMatchesAt(c, utc(2026, 7, 20, 8, 0)), false);
});

test('step expressions match only on their ticks', () => {
  const c = compileCron('*/10 * * * *');
  assert.equal(cronMatchesAt(c, utc(2026, 7, 20, 2, 30)), true);
  assert.equal(cronMatchesAt(c, utc(2026, 7, 20, 2, 35)), false);
});

test('day-of-week is evaluated in Dhaka local time', () => {
  // 2026-07-20 is a Monday; 14:30 Dhaka == 08:30 UTC
  assert.equal(cronMatchesAt(compileCron('30 14 * * 1'), utc(2026, 7, 20, 8, 30)), true);
});

test('month boundary shifts with the offset', () => {
  // 1st of month 00:00 Dhaka == previous day 18:00 UTC
  assert.equal(cronMatchesAt(compileCron('0 0 1 * *'), utc(2026, 7, 31, 18, 0)), true);
});

// The poller only fires when a tick falls inside (last_run, now]. Getting the
// boundaries wrong means either missed runs or double-fires.
test('window is exclusive at the start, inclusive at the end', () => {
  assert.equal(cronFiredInWindow('*/10 * * * *', utc(2026, 7, 20, 2, 5), utc(2026, 7, 20, 2, 10)), true);
  assert.equal(cronFiredInWindow('*/10 * * * *', utc(2026, 7, 20, 2, 0), utc(2026, 7, 20, 2, 5)), false);
  assert.equal(cronFiredInWindow('*/10 * * * *', utc(2026, 7, 20, 2, 1), utc(2026, 7, 20, 2, 6)), false);
});

test('a tick missed while the machine was off still fires on the next poll', () => {
  // 8am Dhaka passed at 02:00 UTC; poller resumes at 03:00 UTC
  assert.equal(cronFiredInWindow('0 8 * * *', utc(2026, 7, 20, 1, 0), utc(2026, 7, 20, 3, 0)), true);
});

test('invalid expressions are rejected, not silently accepted', () => {
  for (const bad of ['61 * * * *', '* * * * * *', 'bad', '', '0 25 * * *', '*/0 * * * *']) {
    assert.equal(compileCron(bad), null, JSON.stringify(bad));
  }
});

test('lists and ranges compile', () => {
  const c = compileCron('0 9,17 * * 1-5');
  assert.equal(cronMatchesAt(c, utc(2026, 7, 20, 3, 0)), true);   // 09:00 Dhaka Mon
  assert.equal(cronMatchesAt(c, utc(2026, 7, 20, 11, 0)), true);  // 17:00 Dhaka Mon
  assert.equal(cronMatchesAt(c, utc(2026, 7, 20, 4, 0)), false);  // 10:00 Dhaka Mon
  assert.equal(cronMatchesAt(c, utc(2026, 7, 25, 3, 0)), false);  // Saturday
});
