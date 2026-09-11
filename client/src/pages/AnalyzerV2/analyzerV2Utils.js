// Display helpers for Ticket Analyzer v2.
//
// Everything here is presentation only. No decision about the trip is taken in
// this file - the server already made all of them, deterministically, and the
// whole point of the rebuild is that the client never second-guesses it.
//
// Keep these pure: they are the only part of the page worth unit-testing later.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "2026-03-26" -> "Thu, 26 Mar 2026".
 *
 * A date that is not a full ISO date is returned untouched: the engine
 * deliberately keeps unresolved partials like "05MAR" alive rather than
 * blanking them, and a specialist needs to see exactly what was printed.
 */
export function formatDate(value) {
  if (!value) return '';
  if (!ISO_DATE.test(value)) return value;

  // Parsed as UTC on purpose. `new Date('2026-03-26')` is already UTC midnight;
  // reading it back with local getters would shift the day for anyone west of
  // Greenwich and show the wrong date.
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;

  return `${WEEKDAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "2026-03-26" -> "26 Mar". For dense rows where the year is already obvious. */
export function formatDateShort(value) {
  if (!value || !ISO_DATE.test(value)) return value || '';

  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;

  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** A place as the engine returns it -> "Zurich (ZRH)", or just the code. */
export function formatPlace(place) {
  if (!place) return '';
  if (place.city && place.iata) return `${place.city} (${place.iata})`;
  return place.iata || place.city || '';
}

/**
 * An airport's name as the old analyzer prints it: "Zurich" -> "Zurich
 * Airport", while "Amsterdam Airport Schiphol" is left alone.
 *
 * Copied from TicketAnalyzer/ticketAnalyzerUtils.js rather than imported: v2 is
 * replacing that tool, and must not stop building the day it is deleted.
 */
export function withAirportSuffix(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '';
  return /airport|aeropuerto|aéroport|aeroporto|flughafen/i.test(trimmed) ? trimmed : `${trimmed} Airport`;
}

/** The line under an airport's name: "Istanbul, Turkey", or whichever half is known. */
export function formatCityAndCountry(place) {
  if (!place) return '';
  return [place.city, place.country].filter(Boolean).join(', ');
}

/** 1566 -> "1566 KM", as the old analyzer prints it. '' when the distance is unknown. */
export function formatDistance(kilometres) {
  if (!Number.isFinite(kilometres)) return '';
  return `${kilometres} KM`;
}

/** ["LIS","ZRH","BEG"] -> "LIS → ZRH → BEG" */
export function formatRoute(codes) {
  if (!Array.isArray(codes) || codes.length === 0) return '';
  return codes.join(' → ');
}

/** The same, but with city names, for the story block. */
export function formatPlaceRoute(places) {
  if (!Array.isArray(places) || places.length === 0) return '';
  return places.map((place) => (place.city || place.iata || '').toUpperCase()).join(' → ');
}

const ROLE_LABELS = {
  OUTBOUND: 'Outbound',
  RETURN: 'Return',
  ONWARD: 'Onward',
  TRIP: 'Trip'
};

export function formatJourneyRole(role) {
  return ROLE_LABELS[role] || 'Trip';
}

const REASON_LABELS = {
  MISSED_CONNECTION: 'after a missed connection',
  REBOOKED: 'after it was not flown'
};

export function formatReplacementReason(reason) {
  return REASON_LABELS[reason] || 'after it was not flown';
}

// Every flag the engine can raise, in specialist language. Anything not listed
// still renders - as its raw code - so a newly added flag is visible on the
// screen rather than silently swallowed.
//
// This map is the VOCABULARY and is kept complete on purpose. Which flags are
// actually shown is a separate decision, and it lives in NEVER_CHIPPED in
// components/FlightRow.jsx. Keeping the two apart means a new surface that
// renders flags gets readable text rather than raw codes, even for flags the
// flight row chooses not to badge.
const FLAG_LABELS = {
  SPLIT_PNR_CONNECTION: 'Separate bookings',
  UNPLANNED_STOP: 'Unplanned stop',
  AIRPORT_CHANGE: 'Airport change',
  HAS_REPLACEMENT: 'Disrupted',
  MISSING_DATE: 'No date',
  MISSING_AIRPORT: 'No airport',
  AMBIGUOUS_FLIGHT_NUMBER: 'Ambiguous flight no.',
  REPLACED: 'Not flown',
  REPLACEMENT: 'Replacement',
  REPORTED_NOT_FLOWN: 'Reported unused',
  ASSUMED_YEAR: 'Assumed year',
  SPLIT_PASSENGER_PNR: 'Separate PNRs'
};

export function formatFlag(flag) {
  return FLAG_LABELS[flag] || flag;
}

// Flags that mean "look at this", as opposed to flags that are just describing
// what happened. Drives the colour, nothing else.
const ATTENTION_FLAGS = new Set([
  'MISSING_DATE',
  'MISSING_AIRPORT',
  'AMBIGUOUS_FLIGHT_NUMBER',
  'ASSUMED_YEAR',
  'SPLIT_PNR_CONNECTION',
  'SPLIT_PASSENGER_PNR',
  'AIRPORT_CHANGE',
  'UNPLANNED_STOP'
]);

export function flagTone(flag) {
  if (flag === 'REPLACED') return 'muted';
  if (flag === 'REPLACEMENT') return 'accent';
  return ATTENTION_FLAGS.has(flag) ? 'warning' : 'neutral';
}

/**
 * Turns one story event into the sentence a specialist reads.
 *
 * Deliberately plain. The old analyzer wrote copy like ">=3h - likely EC261
 * eligible" directly into the card, which is an assessment wearing a
 * description's clothes. This says what happened and stops there.
 */
export function describeEvent(event) {
  if (!event) return '';

  const at = event.at?.city || event.at?.iata || 'the connecting airport';
  const originalFlight = event.original?.flightNumber || 'the booked flight';
  const originalTo = event.original?.to?.city || event.original?.to?.iata || '';
  const replacementFlight = event.replacement?.flightNumber || 'a later flight';
  const reason = event.reason === 'MISSED_CONNECTION'
    ? 'the connection was missed'
    : 'it was not flown';

  const openingClause = originalTo
    ? `In ${at}, ${originalFlight} to ${originalTo} was not flown because ${reason}.`
    : `In ${at}, ${originalFlight} was not flown because ${reason}.`;

  const addedStops = Array.isArray(event.addedStops) ? event.addedStops : [];
  const rerouteClause = addedStops.length > 0
    ? ` The passenger was sent via ${addedStops.join(', ')} on ${replacementFlight}.`
    : ` The passenger travelled on ${replacementFlight} instead.`;

  return openingClause + rerouteClause;
}

/** "1 day later", "2 days later", or '' when it was the same day. */
export function formatDaysLater(days) {
  if (!days) return '';
  return days === 1 ? '1 day later' : `${days} days later`;
}

/** Bytes -> "1.4 MB". Used only in the upload list. */
export function formatFileSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A passenger record -> "Jovana Ciric". How a person is named when you are
 * talking about them.
 *
 * The engine drops anyone with neither name, so at least one part is always
 * present; the filter is here for the half-extracted case, not the empty one.
 */
export function formatPassengerName(passenger) {
  if (!passenger) return '';
  return [passenger.firstName, passenger.lastName].filter(Boolean).join(' ');
}

/**
 * The same person as the document prints them -> "CIRIC/JOVANA".
 *
 * Kept alongside the readable form on purpose. This is the exact string a
 * specialist pastes into an airline's system to find the booking, so losing it
 * would cost them a manual reformat on every case. Shown quietly next to the
 * readable name rather than instead of it.
 */
export function formatPrintedName(passenger) {
  if (!passenger) return '';
  if (!passenger.firstName) return (passenger.lastName || '').toUpperCase();
  return `${passenger.lastName}/${passenger.firstName}`.toUpperCase();
}

/**
 * A 13-digit ticket number, grouped for reading: "724 5528980584".
 *
 * The first three digits are the issuing airline's prefix and are the part a
 * specialist scans for, so they get their own group. The rest is left whole -
 * chunking it further would make it harder to compare against a screen.
 */
export function formatTicketNumber(number) {
  if (!number || number.length !== 13) return number || '';
  return `${number.slice(0, 3)} ${number.slice(3)}`;
}
