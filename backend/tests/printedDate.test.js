'use strict';

// Run directly: node backend/tests/printedDate.test.js
//
// The corpus behind backend/utils/printedDate.js — every shape a real document
// has printed a date in, with the answer it must give.
//
// This file exists because a regex ate the "t" in "01Oct" and nothing caught it.
// The analyzer suite already had a Dates block, and every assertion in it used
// March, September, December or January — so a bug that only touched October was
// invisible to all of them, and stayed invisible until a real ticket lost its
// return journey.
//
// THE RULE: THE CALENDAR IS PART OF THE CORPUS. The twelve months below are not
// twelve variations on one case — they are the case. A parser that reads a date
// must be tested against every month there is, because a month name is data and
// any one of them can collide with a rule written for punctuation.

const assert = require('node:assert/strict');
const { readPrintedDate } = require('../utils/printedDate');

// A date with no year is written "MM-DD", a full one "YYYY-MM-DD", and something
// that is not a date at all is null. One notation for all three keeps the table
// readable at a glance, which is the only reason a table like this gets checked.
function asText(value) {
  const parts = readPrintedDate(value);
  if (!parts) return null;

  return parts.hasYear
    ? parts.iso
    : `${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function check(cases, description) {
  cases.forEach(([printed, expected]) => {
    assert.equal(asText(printed), expected,
      `${description}: ${JSON.stringify(printed)} should read as ${expected}`);
  });
}

// --- every month, with no year printed -----------------------------------------------
// The Garuda e-ticket that exposed this printed "07Sep", "08Sep", "01Oct",
// "01Oct". Two of the four were destroyed, the return journey lost its dates,
// could not chain, and came back as two "No date" journeys.
check([
  ['01Jan', '01-01'], ['01Feb', '02-01'], ['01Mar', '03-01'], ['01Apr', '04-01'],
  ['01May', '05-01'], ['01Jun', '06-01'], ['01Jul', '07-01'], ['01Aug', '08-01'],
  ['01Sep', '09-01'], ['01Oct', '10-01'], ['01Nov', '11-01'], ['01Dec', '12-01']
], 'every month reads with no year');

// --- and every month again with one, since the two take different code paths ----------
check([
  ['01Jan26', '2026-01-01'], ['01Feb26', '2026-02-01'], ['01Mar26', '2026-03-01'],
  ['01Apr26', '2026-04-01'], ['01May26', '2026-05-01'], ['01Jun26', '2026-06-01'],
  ['01Jul26', '2026-07-01'], ['01Aug26', '2026-08-01'], ['01Sep26', '2026-09-01'],
  ['01Oct26', '2026-10-01'], ['01Nov26', '2026-11-01'], ['01Dec26', '2026-12-01']
], 'every month reads with a glued year');

// --- case and spacing do not change a date --------------------------------------------
check([
  ['01OCT', '10-01'],
  ['01oct', '10-01'],
  ['1 Oct', '10-01'],
  ['  01Oct  ', '10-01'],
  ['01 OCT 2026', '2026-10-01']
], 'case and spacing');

// --- separators ------------------------------------------------------------------------
check([
  ['01-Oct-2026', '2026-10-01'],
  ['01.Oct.2026', '2026-10-01'],
  ['01/Oct/2026', '2026-10-01'],
  ['05/mar./2026', '2026-03-05'],
  ['2026-10-01', '2026-10-01'],
  ['2026/10/01', '2026-10-01'],
  ['01/10/2026', '2026-10-01']
], 'separator forms');

// --- month names that are not English ---------------------------------------------------
// "aout" ends in a "t" exactly as "Oct" does, so it went the same way.
check([
  ['01 aout', '08-01'],
  ['01 août', '08-01'],
  ['01 octobre', '10-01'],
  ['22 mars 2026', '2026-03-22'],
  ['22 septembre 2026', '2026-09-22'],
  ['01 décembre 2026', '2026-12-01']
], 'localised month names');

// --- a clock stuck to a date is never read as part of it -----------------------------------
// "IB 0550 A 05MAR20:40" once gave departureDate "05MAR20" -> the year 2020,
// which tore one connecting trip into two direct ones.
check([
  ['05MAR20:40', '03-05'],
  ['01Oct18:00', '10-01'],
  ['2026-03-05T20:40', '2026-03-05'],
  ['2026-10-01T00:15:00', '2026-10-01'],
  ['2026-10-01T00:15:00Z', '2026-10-01'],
  ['01 Oct 2026 22:00', '2026-10-01']
], 'a clock is not part of the date');

// --- two-digit years ------------------------------------------------------------------------
check([
  ['05MAR26', '2026-03-05'],
  ['22Jun26', '2026-06-22'],
  ['05MAR68', '2068-03-05'],
  ['05MAR69', '1969-03-05']
], 'two-digit years pivot at 68');

// --- and what is genuinely not a date -----------------------------------------------------------
// null means "no date in here". It must never be the answer for a string a
// document really printed a date in: Step 8b turns every null into a visible
// flag, and a false one would cry wolf on a leg that is perfectly fine.
check([
  ['', null],
  ['   ', null],
  [null, null],
  [undefined, null],
  ['Not Provided', null],
  ['n/a', null],
  ['XRMUK8', null],
  ['Terminal 3', null],
  ['32 Oct', null],
  ['01 Xyz', null]
], 'not a date');

console.log('printedDate: all assertions passed');
