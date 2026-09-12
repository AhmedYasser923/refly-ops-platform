'use strict';

// =============================================================================
// WHERE TO LOOK ONE FLIGHT UP
// =============================================================================
//
// The three flight trackers a specialist checks a claim against - AirportInfo,
// FlightStats and Flightera - each want the flight number and the date in their
// own shape. This builds the three links for one flight.
//
// The URL shapes are the Flight Search tool's own (buildTrackerURLs in
// client/src/pages/TicketAnalyzer/ticketAnalyzerUtils.js), copied rather than
// imported: v2 is replacing that tool and must not stop working the day it is
// deleted. Copying is also what keeps the links on the server, where the
// airline list already is, so the browser needs no overrides of its own.
// =============================================================================

const { activeAirlinesForCode } = require('./airlineBookingRules');

// What a tracker will accept: a two-character IATA code or a three-letter one,
// then up to four digits. Deliberately the tool's own regex rather than
// carrierCodeOf, which knows only two-character IATA codes - the trackers also
// take a three-letter prefix.
const TRACKABLE_FLIGHT_NUMBER = /^([A-Z]{3}|[A-Z0-9]{2})\s*(\d{1,4})$/;

const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Flightera puts the month in its URL by name: ".../BA568/Aug-2026".
const TRACKER_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const TRACKER_KEYS = ['airportInfo', 'flightStats', 'flightera'];

/** No links, and the reason - which is what the screen shows instead. */
function noLinks(reason) {
  return { airportInfo: '', flightStats: '', flightera: '', unavailable: reason };
}

/**
 * An airline's usable `trackerSearchCodes`, or null when it has none. The file
 * carries empty objects as well as real ones, so the values are checked rather
 * than the key.
 */
function trackerCodesOf(airline) {
  const listed = airline && airline.trackerSearchCodes;
  if (!listed || typeof listed !== 'object') return null;

  const codes = {};
  for (const tracker of TRACKER_KEYS) {
    const code = String(listed[tracker] || '').trim();
    if (code) codes[tracker] = code;
  }

  return Object.keys(codes).length > 0 ? codes : null;
}

/**
 * What to search for a carrier whose IATA code does not resolve on a tracker.
 * Iberojet is "EVE" on all three, plus ultra is "PU*" on FlightStats only, and
 * 39 airlines in the file carry one of these.
 *
 * Only airlines STILL FLYING the code are considered, and the first with a
 * usable override wins. A code outlives the airline that held it - BF is French
 * bee's now and MarkAir's before - and the search codes of an airline that
 * stopped flying would send a live flight to the wrong page.
 */
function overrideCodesFor(carrierCode) {
  for (const airline of activeAirlinesForCode(carrierCode)) {
    const codes = trackerCodesOf(airline);
    if (codes) return codes;
  }

  return {};
}

/**
 * The three tracker links for one flight, or the reason there are none.
 *
 * Always the same four keys, so the screen can lay the same row of buttons out
 * either way. `unavailable` is '' when the links are there.
 *
 * @param {string} flightNumber As the leg carries it - already corrected, so a
 *   Norse Atlantic flight is searched as N0379 and not as the misread NO379.
 * @param {string} departureDate The leg's ISO date.
 */
function buildTrackerLinks(flightNumber, departureDate) {
  const flight = TRACKABLE_FLIGHT_NUMBER.exec(String(flightNumber || '').trim().toUpperCase());
  // "BA494/AA7041" is two flight numbers printed in one row, and an empty one
  // is a flight the document never named. Neither is a flight to look up.
  if (!flight) return noLinks('FLIGHT_NUMBER_UNCLEAR');

  const date = String(departureDate || '').trim();
  // A partial the engine kept alive ("05MAR") cannot be looked up either.
  if (!FULL_DATE.test(date)) return noLinks('NO_FULL_DATE');

  const [, carrierCode, printedNumber] = flight;
  // AirportInfo takes the number as printed ("ba0568"); the other two want the
  // leading zeros gone ("568").
  const number = String(Number.parseInt(printedNumber, 10));
  const [year, month, day] = date.split('-');

  const overrides = overrideCodesFor(carrierCode);
  const codeFor = (tracker) => overrides[tracker] || carrierCode;

  return {
    airportInfo: `https://airportinfo.live/flight/${(codeFor('airportInfo') + printedNumber).toLowerCase()}?d=${date}`,
    flightStats: `https://www.flightstats.com/v2/historical-flight/${codeFor('flightStats')}/${number}/${year}/${Number.parseInt(month, 10)}/${Number.parseInt(day, 10)}`,
    flightera: `https://www.flightera.net/en/flight/${codeFor('flightera')}${number}/${TRACKER_MONTHS[Number.parseInt(month, 10) - 1]}-${year}#flight_list`,
    unavailable: ''
  };
}

module.exports = {
  buildTrackerLinks,
  TRACKER_KEYS
};
