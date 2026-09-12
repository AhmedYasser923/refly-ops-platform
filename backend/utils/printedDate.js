'use strict';

// =============================================================================
// READING A DATE OFF A DOCUMENT — THE ONE DOOR
// =============================================================================
//
// Every date string that comes off a ticket, a boarding pass or an airline
// notice becomes structured data HERE and nowhere else. That is the whole point
// of the file, and it exists because of a bug that cost a real case its
// timeline.
//
// A Garuda e-ticket printed "07Sep", "08Sep", "01Oct", "01Oct". The model read
// all four correctly. The server destroyed two of them, because the strip that
// removes an ISO "T" separator carried an /i flag:
//
//     .replace(/[T\s.,;:/-]+$/i, '')      "01Oct" -> "01Oc"
//
// A month name can end in a character a regex thinks is punctuation. Every
// partial October date in the tool was unreadable, and so was French "aout".
// The return journey lost its dates, could not chain, and came back torn into
// two "No date" journeys with the second one mislabelled.
//
// TWO RULES KEEP IT FROM HAPPENING AGAIN
//
//   1. ONE DOOR. Nothing else parses a printed date. Two private copies of this
//      logic had already drifted into two controllers, and the copy in the
//      passenger tool carried the identical bug. One door, one bug, one fix.
//
//   2. ONE ROW PER MONTH. backend/tests/printedDate.test.js asserts all twelve
//      months. Not one of the date assertions in the analyzer suite used an
//      October date, which is exactly why this survived for so long. A corpus
//      that covers the calendar cannot be month-blind.
//
// The month-name table itself lives in dateYearResolver.js, which the old ticket
// analyzer shares. It is read, never modified.
// =============================================================================

const { parseDateParts } = require('./dateYearResolver');

/**
 * WHAT IT DOES
 *   Inserts separators into a glued boarding-pass date and expands a two-digit
 *   year: "05MAR26" becomes "05 MAR 2026".
 *
 * WHY IT IS BUILT THIS WAY
 *   The shared date parser expects separators and cannot read the glued form.
 *   Loosening the string here rather than changing the parser keeps the ticket
 *   analyzer, which depends on that parser, untouched.
 */
function addSeparatorsToGluedDate(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  return trimmed
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(^|[^\d])(\d{2})$/, (match, before, twoDigitYear) =>
      before + (Number(twoDigitYear) <= 68 ? '20' : '19') + twoDigitYear);
}

/**
 * WHAT IT DOES
 *   Removes any clock time from a string that is supposed to be a date.
 *
 * WHY IT IS BUILT THIS WAY
 *   This is scar tissue. Boarding passes print the date and departure time as
 *   one run of characters — "IB 0550 A 05MAR20:40" — and the model sometimes
 *   carried part of the clock into a date field as "05MAR20". The two-digit
 *   year rule above then read the HOUR as a year: 05MAR20 became 2020 and
 *   06MAR11 became 2011. An arrival six years after its departure fails every
 *   connection test, so one connecting trip tore into two "direct" journeys.
 *
 *   Each of the three moves below is deliberately narrow, because the version
 *   that was not is what broke October:
 *
 *     - the ISO "T" is only ever a separator in ONE position, directly after
 *       YYYY-MM-DD, so that is the only place it is removed;
 *     - a clock is recognised by its colon, never by its position;
 *     - the trailing strip takes punctuation and whitespace ONLY. It must never
 *       be able to remove a letter, because the last letter of a partial date
 *       is the last letter of the month name.
 */
function removeClockTimeFromDate(value) {
  return String(value || '')
    .replace(/^(\d{4}-\d{2}-\d{2})T.*$/, '$1')
    .replace(/(\d{1,2})\s*:\s*(\d{2})(\s*:\s*\d{2})?/g, ' ')
    .replace(/[\s.,;:/-]+$/, '')
    .trim();
}

/**
 * WHAT IT DOES
 *   Reads whatever a document printed as a date. Returns
 *   `{ year, month, day, iso, hasYear }`, or null when the string holds no date.
 *
 * WHY IT IS BUILT THIS WAY
 *   null means "this is not a date", and each caller decides what that means for
 *   its own question. A partial — "05MAR", no year — comes back with
 *   `hasYear: false` and a null `iso`, never as null: a day and a month is real
 *   information, and throwing it away is what leaves a leg unorderable.
 *
 *   Two passes: the string as printed, then the same string with separators
 *   inserted. The second pass alone would mangle a date that already reads
 *   correctly, so it is a fallback rather than a normalisation.
 */
function readPrintedDate(value) {
  const withoutClock = removeClockTimeFromDate(value);
  return parseDateParts(withoutClock) || parseDateParts(addSeparatorsToGluedDate(withoutClock));
}

module.exports = { readPrintedDate };
