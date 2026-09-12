'use strict';

// =============================================================================
// AIRLINE-SPECIFIC RULES FOR BOOKING REFERENCES AND FLIGHT NUMBERS
// =============================================================================
//
// Hard-won knowledge, carried over from backend/prompts/ticketAnalysisPrompt.js
// where it lived as instructions to the model. It is implemented here instead
// because a prompt rule is a REQUEST - when the model does not comply, the bad
// value reaches the screen - while this is a guarantee.
//
// The model is still told about these cases, because a well-briefed model makes
// fewer mistakes to catch. But nothing here depends on it listening.
// =============================================================================

const { airlinesCodesData } = require('./dataLoader');

// The usual record locator: 5 to 7 characters, letters and digits, at least one
// letter. Six is by far the most common.
const STANDARD_BOOKING_CODE = /^(?=.*[A-Z])[A-Z0-9]{5,7}$/;

// Airlines whose locators genuinely do not follow that shape. Without these,
// a real reference from one of these carriers is thrown away as malformed.
//
// `iata` is checked first because it is unambiguous; `names` is a substring
// match on the airline name, for documents that print a name and no code.
const BOOKING_CODE_EXCEPTIONS = [
  {
    // easyJet runs 7, and operates under several AOCs.
    iata: ['U2', 'EC', 'DS'],
    names: ['easyjet'],
    pattern: /^[A-Z0-9]{5,7}$/
  },
  {
    iata: ['3O'],
    names: ['air arabia maroc'],
    pattern: /^\d{8}$/
  },
  {
    iata: ['IZ'],
    names: ['arkia'],
    pattern: /^\d{8}$/
  },
  {
    iata: ['DE'],
    names: ['condor'],
    pattern: /^\d{8}$/
  },
  {
    // Not in airlines_codes.json, so name-only.
    names: ['electra'],
    pattern: /^\d{8}$/
  },
  {
    // TUI runs long numeric references, up to twelve digits.
    iata: ['BY', 'TB', 'X3', 'OR'],
    names: ['tui'],
    pattern: /^\d{6,12}$/
  },
  {
    iata: ['9P'],
    names: ['fly jinnah'],
    pattern: /^\d{9}$/
  },
  {
    iata: ['CD'],
    names: ['corendon dutch'],
    pattern: /^[A-Z0-9]{7}$/
  },
  {
    // Purely numerical references.
    iata: ['NO'],
    names: ['neos'],
    pattern: /^\d{5,12}$/
  },
  {
    names: ['heston'],
    pattern: /^\d{5,12}$/
  },
  {
    iata: ['DK'],
    names: ['sunclass'],
    pattern: /^\d{5,12}$/
  }
];

/**
 * The exception rule that applies to a leg, if any.
 *
 * @param {string[]} iataCodes  Carrier codes seen on the leg.
 * @param {string[]} airlineNames  Airline names seen on the leg.
 */
function bookingCodeExceptionFor(iataCodes = [], airlineNames = []) {
  const codes = iataCodes.filter(Boolean).map((code) => code.toUpperCase());
  const names = airlineNames.filter(Boolean).map((name) => name.toLowerCase());

  return BOOKING_CODE_EXCEPTIONS.find((exception) => {
    if ((exception.iata || []).some((code) => codes.includes(code))) return true;
    return (exception.names || []).some(
      (fragment) => names.some((name) => name.includes(fragment))
    );
  }) || null;
}

// Carrier code + IATA ticketing prefix + locator, printed as one run:
// "LH220HABMTTA4" is LH + 220 + HABMTT + a two-character tail.
const EMBEDDED_BOOKING_CODE = /^([A-Z]{2})(\d{3})([A-Z0-9]{6})([A-Z0-9]{0,2})$/;

const ticketPrefixByIata = (() => {
  const map = new Map();
  for (const airline of airlinesCodesData) {
    const iata = String(airline.iata || '').trim().toUpperCase();
    const prefix = String(airline.ticketPrefix || '').trim();
    if (iata && /^\d{3}$/.test(prefix)) map.set(iata, prefix);
  }
  return map;
})();

/**
 * Pulls a locator out of a pseudo e-ticket string.
 *
 * "LH220HABMTTA4" -> "HABMTT", but ONLY when LH and 220 really are a carrier and
 * that carrier's own ticketing prefix. That pairing is what makes this safe to
 * do deterministically: a string that merely looks like the pattern but whose
 * prefix does not belong to its carrier is left alone rather than chopped.
 */
function extractEmbeddedBookingCode(value) {
  const match = EMBEDDED_BOOKING_CODE.exec(value);
  if (!match) return '';

  const [, carrier, ticketPrefix, locator] = match;
  return ticketPrefixByIata.get(carrier) === ticketPrefix ? locator : '';
}

/**
 * Is this a real booking reference for this leg's airlines?
 *
 * Returns the accepted code, or '' when it is not one. Rejecting is the point:
 * the Swiss passes print "7464F99C" and "LXC6A4E3" in the corner, and both are
 * internal document ids rather than locators. Eight generic alphanumerics is
 * the signature of an internal id, so unless one of the exceptions above says
 * otherwise, it is thrown away instead of displayed as a record locator.
 */
function normaliseBookingCode(rawValue, { iataCodes = [], airlineNames = [] } = {}) {
  const value = String(rawValue || '').toUpperCase().replace(/[^A-Z0-9/]/g, '');
  if (!value) return '';

  // "BA/7IQHOL" -> "7IQHOL"
  const withoutCarrierPrefix = value.replace(/^[A-Z0-9]{2,3}\//, '');
  if (!withoutCarrierPrefix) return '';

  const exception = bookingCodeExceptionFor(iataCodes, airlineNames);
  if (exception && exception.pattern.test(withoutCarrierPrefix)) {
    return withoutCarrierPrefix;
  }

  if (STANDARD_BOOKING_CODE.test(withoutCarrierPrefix)) return withoutCarrierPrefix;

  return extractEmbeddedBookingCode(withoutCarrierPrefix);
}

// -----------------------------------------------------------------------------
// Flight-number IATA prefix correction
// -----------------------------------------------------------------------------

// Character pairs OCR routinely confuses. The airline NAME is ground truth; the
// glyph is not. Norse Atlantic Airways is "N0…" with a zero, and a scan that
// reads "NO379" is wrong in a way we can prove and fix.
const CONFUSABLE_CHARACTERS = new Map([
  ['0', 'O'], ['O', '0'],
  ['1', 'I'], ['I', '1'],
  ['L', '1'],
  ['5', 'S'], ['S', '5'],
  ['8', 'B'], ['B', '8'],
  ['2', 'Z'], ['Z', '2']
]);

const airlinesByNormalisedName = (() => {
  const map = new Map();
  for (const airline of airlinesCodesData) {
    const name = String(airline.name || '').trim().toLowerCase();
    const iata = String(airline.iata || '').trim().toUpperCase();
    if (!name || !/^[A-Z0-9]{2}$/.test(iata) || iata === 'NA') continue;
    if (!map.has(name)) map.set(name, iata);
  }
  return map;
})();

function canonicalIataForAirline(airlineName) {
  const name = String(airlineName || '').trim().toLowerCase();
  return name ? (airlinesByNormalisedName.get(name) || '') : '';
}

/** Do two codes differ only by characters OCR is known to confuse? */
function differsOnlyByConfusableGlyphs(printed, canonical) {
  if (printed.length !== canonical.length) return false;
  if (printed === canonical) return false;

  return [...printed].every((character, index) => {
    const expected = canonical[index];
    return character === expected || CONFUSABLE_CHARACTERS.get(character) === expected;
  });
}

/**
 * Corrects a flight number's carrier prefix against the airline's canonical
 * IATA code. "NO379" on a document that names Norse Atlantic Airways becomes
 * "N0379".
 *
 * Deliberately conservative. It corrects ONLY when the airline name resolves to
 * exactly one canonical code AND every differing character is a known confusable
 * pair. An airline we cannot name, or a prefix that differs in some other way,
 * is left exactly as printed - inventing a code would be worse than a misread.
 */
function correctFlightNumberPrefix(flightNumber, airlineNames = []) {
  // Only the first two characters are ever touched. The rest is returned
  // exactly as given, separators included: "BA494/AA7041" carries two flight
  // numbers in one printed row, and stripping the slash here would silently
  // disarm the ambiguity check downstream.
  const printed = String(flightNumber || '').toUpperCase();
  const printedPrefix = printed.slice(0, 2);
  if (!/^[A-Z0-9]{2}$/.test(printedPrefix)) return printed;

  for (const airlineName of airlineNames.filter(Boolean)) {
    const canonical = canonicalIataForAirline(airlineName);
    if (!canonical) continue;
    if (printedPrefix === canonical) return printed;

    if (differsOnlyByConfusableGlyphs(printedPrefix, canonical)) {
      return canonical + printed.slice(2);
    }
  }

  return printed;
}

// -----------------------------------------------------------------------------
// Which airline flew a flight
// -----------------------------------------------------------------------------

/** Accents, case, spaces and punctuation stripped, so "Delta Air Lines" and
 *  "Delta AirLines" are one airline. The comparison dataLoader's
 *  findAirlineDocByContext uses. */
function collapseAirlineName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Every airline in the file under its IATA code. One code can list several,
// usually an airline that stopped flying and the one the code went to next
// (OE: LaudaMotion, ceased 2020, then FlyOne Romania).
const airlinesByIataCode = (() => {
  const map = new Map();
  for (const airline of airlinesCodesData) {
    const iata = String(airline.iata || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{2}$/.test(iata) || iata === 'NA') continue;
    if (!map.has(iata)) map.set(iata, []);
    map.get(iata).push(airline);
  }
  return map;
})();

/** "OE3053" -> "OE". '' when the flight number does not start with a carrier code. */
function carrierCodeOf(flightNumber) {
  const match = String(flightNumber || '').toUpperCase().match(/^([A-Z0-9]{2})\d/);
  return match ? match[1] : '';
}

/** Every airline the file lists under a code, ceased ones included. */
function airlinesHoldingCode(code) {
  return airlinesByIataCode.get(code) || [];
}

/**
 * The airlines still flying under a code. An airline listed twice under the
 * same name (SN has two "Brussels Airlines") counts once.
 */
function activeAirlinesForCode(code) {
  const seenNames = new Set();
  return airlinesHoldingCode(code).filter((airline) => {
    if (airline.ceasedOperations) return false;
    const collapsedName = collapseAirlineName(airline.name);
    if (seenNames.has(collapsedName)) return false;
    seenNames.add(collapsedName);
    return true;
  });
}

/**
 * The airline among `airlines` that this name refers to: an exact match, or a
 * short form of a longer name ("Swiss" for "Swiss International Air Lines").
 * Never the other way round - a tour operator called "Coral Travel" must not
 * match an airline that happens to be called "Coral". Where several match, one
 * still flying is preferred.
 */
function findAirlineNamed(name, airlines) {
  const wanted = collapseAirlineName(name);
  if (!wanted) return null;

  const stillFlyingFirst = (matches) =>
    matches.find((airline) => !airline.ceasedOperations) || matches[0] || null;

  const exactMatches = airlines.filter((airline) => collapseAirlineName(airline.name) === wanted);
  if (exactMatches.length > 0) return stillFlyingFirst(exactMatches);

  if (wanted.length < 4) return null;
  return stillFlyingFirst(
    airlines.filter((airline) => collapseAirlineName(airline.name).includes(wanted))
  );
}

/**
 * The file's entry for an airline name on a flight. The airlines holding the
 * flight number's code are searched first, so a name two airlines share means
 * the one on this code; then the whole file, for an airline flying under
 * another's code - a codeshare's operating airline. null when it is not there.
 */
function findAirlineRecord(name, flightNumber) {
  return findAirlineNamed(name, airlinesHoldingCode(carrierCodeOf(flightNumber)))
    || findAirlineNamed(name, airlinesCodesData);
}

/**
 * Names the airline that flew one flight.
 *
 * In this order, stopping at the first that answers:
 *   1. The name the document gave, when it is an airline in the file that is
 *      still flying. Ground truth - the same rule correctFlightNumberPrefix
 *      rests on.
 *   2. The flight number's code, when exactly one airline still flying holds
 *      it in the file.
 *   3. What the web lookup found for the code (controller Step 2b).
 *   4. The document's name, unconfirmed, or nothing.
 *
 * Step 2 is what catches a name that is not an airline at all - a tour
 * operator - and an airline that has stopped flying. Coral Travel's OE 3053
 * comes out as FlyOne Romania: not "Coral Travel", and not Laudamotion, which
 * held OE until 2020.
 *
 * Returns { name, iata, source, unsettledCode }. `iata` is filled only when the
 * name came from the code. `source` is 'document', 'airline-list', 'online',
 * or '' when nothing confirmed the name. `unsettledCode` is the code the web
 * lookup should be asked about.
 */
function resolveAirline({ nameFromModel, flightNumber, airlinesFoundOnline = {} }) {
  const name = String(nameFromModel || '').trim();
  const code = carrierCodeOf(flightNumber);

  const namedAirline = findAirlineRecord(name, flightNumber);
  if (namedAirline && !namedAirline.ceasedOperations) {
    return { name, iata: '', source: 'document', unsettledCode: '' };
  }

  const stillFlying = activeAirlinesForCode(code);
  if (stillFlying.length === 1) {
    return { name: stillFlying[0].name, iata: code, source: 'airline-list', unsettledCode: '' };
  }

  const foundOnline = code ? String(airlinesFoundOnline[code] || '').trim() : '';
  if (foundOnline) {
    return { name: foundOnline, iata: code, source: 'online', unsettledCode: '' };
  }

  return { name, iata: '', source: '', unsettledCode: code };
}

module.exports = {
  normaliseBookingCode,
  bookingCodeExceptionFor,
  extractEmbeddedBookingCode,
  correctFlightNumberPrefix,
  canonicalIataForAirline,
  carrierCodeOf,
  airlinesHoldingCode,
  activeAirlinesForCode,
  findAirlineNamed,
  findAirlineRecord,
  resolveAirline,
  STANDARD_BOOKING_CODE
};
