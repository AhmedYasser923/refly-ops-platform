'use strict';

// =============================================================================
// CLAIM INTAKE
// =============================================================================
//
// A passenger uploads a travel document. Out the other end comes the trip they
// booked, the flights they did not take, and the flights they were moved onto
// instead — ready for them to confirm.
//
// Everything lives in this one file, laid out in the order it actually runs
// when a document is uploaded. Read it top to bottom and you are following the
// request. (Function declarations hoist in JavaScript, so a function may call
// one defined further down; the order here is chosen for reading, not for the
// interpreter.)
//
// THE RULE THIS WHOLE FILE IS BUILT ON
// ------------------------------------
// The AI model is asked ONLY what is printed on the page: flight numbers,
// dates, airports, names. Every conclusion — which flights form one journey,
// which flight replaced which, whether that was a reroute or a rebooking — is
// derived here in plain JavaScript.
//
// Why: a model's answer is not reproducible, not explainable, and wrong in a
// new way each time, so you can never fix a whole class of bug. The rules below
// are trivial in code and hopelessly fuzzy in a prompt.
//
// THERE ARE NO TIMES ANYWHERE IN THIS FILE
// ----------------------------------------
// Printed times are the least reliable thing on a travel document. A boarding
// pass prints a boarding-gate time in a box and the scheduled departure inline;
// the model read the wrong one and turned a 20:40 flight into 09:55. Passes
// also glue the date and time together ("IB 0550 A 05MAR20:40"), so a stray
// clock landing in a date field produced "05MAR20", which parsed as the year
// 2020 and tore one connecting trip into two.
//
// Nothing a claim needs depends on a departure time, so times were deleted
// entirely rather than hardened. All arithmetic here is in whole days.
//
// ORDER OF PLAY
// -------------
//   Step  1  extractClaimIntake ............ the HTTP entry point
//   Step  2  readModelJson ................. parse what the model returned
//   Step  3  normalisePassengers ........... clean the people
//   Step  4  buildIntakeResponse ........... assemble the reply
//   Step  5  buildItineraryFromLegs ........ the deterministic engine
//   Step  6  normaliseExtractedLeg ......... clean each flight
//   Step  7  resolveMissingYears ........... "05MAR" -> a real date
//   Step  8  mergeDuplicateLegs ............ one flight listed twice
//   Step  9  sortLegsChronologically ....... put them in order
//   Step 10  detectReplacementFlights ...... which flight replaced which
//   Step 11  buildOriginalBookingChains .... the trip as it was sold
//   Step 12  finaliseJourney ............... connections, story, labels
//   Step 13  buildReplacementItineraries ... group the reroutings
//   Step 14  collectWarnings ............... things worth mentioning
//   Step 15  buildManualItinerary .......... the second entry point
// =============================================================================

const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const logUsage = require('../utils/logUsage');
const { calculateCost } = require('../utils/pricing');
const { geminiQueue, isQuotaError } = require('../utils/geminiQueue');
const genAI = require('../utils/geminiClient');
const MODELS = require('../config/models');
const { buildTicketDocumentParts } = require('../utils/ticketDocumentParts');
const CLAIM_INTAKE_SCHEMA = require('../schemas/claimIntakeSchema');
const { buildClaimIntakePrompt } = require('../prompts/claimIntakePrompt');
// The one place a printed date becomes structured data. This file used to carry
// its own copy of it; the copy had drifted and was destroying every partial
// October date ("01Oct" -> "01Oc"), which cost a real trip its return journey in
// the specialist tool before it was found. Two copies of one parser is the bug.
const { readPrintedDate } = require('../utils/printedDate');

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const MAX_MODEL_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1500;

// How many days apart two flights can be and still count as one connection.
const MAX_CONNECTION_DAYS = 1;

// How far apart two departures from the same airport can be and still be the
// same flight, rebooked. Beyond three days it is a different trip entirely.
const REPLACEMENT_WINDOW_DAYS = 3;

const DOCUMENT_TYPES = new Set([
  'boarding_pass', 'booking_confirmation', 'e_ticket', 'itinerary', 'unknown'
]);

// Models emit these no matter how firmly the prompt forbids them. Filtering
// once at the boundary means the other thousand lines only ever see a real
// value or an empty string.
const PLACEHOLDER_VALUES = new Set([
  '', 'not provided', 'unknown', 'n/a', 'na', 'none', 'null', '-', '--'
]);

// Everything that can be noteworthy about a leg, a connection or a journey.
// Constants rather than bare strings so a typo fails at load time instead of
// becoming a flag that silently never matches.
const FLAGS = {
  // Connection-level
  SPLIT_PNR_CONNECTION: 'SPLIT_PNR_CONNECTION',
  UNPLANNED_STOP: 'UNPLANNED_STOP',
  // Journey-level
  AIRPORT_CHANGE: 'AIRPORT_CHANGE',
  HAS_REPLACEMENT: 'HAS_REPLACEMENT',
  // Leg-level
  MISSING_DATE: 'MISSING_DATE',
  MISSING_AIRPORT: 'MISSING_AIRPORT',
  AMBIGUOUS_FLIGHT_NUMBER: 'AMBIGUOUS_FLIGHT_NUMBER',
  REPLACED: 'REPLACED',
  REPLACEMENT: 'REPLACEMENT',
  REPORTED_NOT_FLOWN: 'REPORTED_NOT_FLOWN',
  ASSUMED_YEAR: 'ASSUMED_YEAR'
};

// Statuses the model may report for a leg. The timeline decides the itinerary,
// never these — but a leg the model independently read as unused is
// corroborating evidence, so it is kept and surfaced.
const NOT_FLOWN_STATUSES = new Set([
  'cancelled', 'unused / missed connection', 'unused', 'missed connection'
]);

// What each journey is to the trip as a whole. "Trip 1 / Trip 2" tells a
// passenger nothing they did not already know; "Outbound / Return" tells them
// we understood their booking.
const JOURNEY_ROLES = {
  OUTBOUND: 'OUTBOUND',
  RETURN: 'RETURN',
  ONWARD: 'ONWARD',
  TRIP: 'TRIP'
};

// Why an original flight was not taken. Inferred from where it sat in the
// timeline, never from anything the model said.
const REPLACEMENT_REASONS = {
  MISSED_CONNECTION: 'MISSED_CONNECTION',
  REBOOKED: 'REBOOKED'
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MULTIPLE_FLIGHT_NUMBERS_PATTERN = /[/,+]/;

// =============================================================================
// STEP 1 — The HTTP entry point
// =============================================================================

/**
 * POST /api/claim-intake/extract
 *
 * WHAT IT DOES
 *   Takes the uploaded files, sends them to Gemini with the extraction schema,
 *   turns the reply into a leg list, and hands that to the engine.
 *
 * WHY IT IS BUILT THIS WAY
 *   It is deliberately thin. It moves bytes and handles failure; it makes no
 *   decisions about the trip itself. Everything interesting happens in
 *   buildItineraryFromLegs, which is pure and therefore testable without a
 *   server, a model or a network.
 *
 *   The status codes are design decisions rather than mechanics:
 *     400  no files          — the caller's mistake
 *     503  quota exhausted   — ours, and temporary
 *     502  unparseable JSON  — an upstream dependency misbehaved
 *     200  zero flights      — NOT an error. The upload worked; the document
 *                              just was not a ticket, so the UI shows a helpful
 *                              empty state rather than a red toast.
 */
exports.extractClaimIntake = catchAsync(async (request, response, next) => {
  const uploadedFiles = Array.isArray(request.files) ? request.files : [];

  if (uploadedFiles.length === 0) {
    return next(new AppError('Please upload at least one document.', 400));
  }

  const modelName = MODELS.claimIntake;
  const geminiModel = genAI.getGenerativeModel({ model: modelName });
  const extractionPrompt = buildClaimIntakePrompt();

  // Turns each upload into something the model can read: PDF bytes plus
  // coordinate-sorted helper text, images resized and JPEG-compressed.
  const documentParts = await buildTicketDocumentParts(uploadedFiles);

  const startedAt = Date.now();
  let modelResult;

  // One retry. A second attempt fixes a transient hiccup; a third would just
  // make the passenger wait longer for the same failure.
  for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt += 1) {
    try {
      modelResult = await geminiQueue.run(() => geminiModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: extractionPrompt }, ...documentParts] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: CLAIM_INTAKE_SCHEMA
        }
      }));
      break;
    } catch (modelError) {
      if (attempt === MAX_MODEL_ATTEMPTS) {
        console.error('[ClaimIntake] Gemini failed:', modelError.message);
        if (isQuotaError(modelError)) {
          return next(new AppError(
            'We are handling a lot of requests right now. Please try again in a moment.', 503
          ));
        }
        return next(new AppError('We could not read your document. Please try again.', 502));
      }
      console.warn(`[ClaimIntake] Attempt ${attempt} failed (${modelError.message}) - retrying.`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  let extractedPayload;
  try {
    extractedPayload = readModelJson(modelResult.response.text());
  } catch (parseError) {
    console.error('[ClaimIntake] Unparseable model response:', parseError.message);
    return next(new AppError('We could not read your document. Please try again.', 502));
  }

  const cost = calculateCost(modelName, modelResult.response.usageMetadata);
  const extractedLegs = Array.isArray(extractedPayload?.legs) ? extractedPayload.legs : [];

  // Fire and forget — a logging failure must never fail a passenger's claim.
  logUsage(request, {
    operationType: 'claim_intake_extract',
    model: modelName,
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    costUSD: cost.costUSD,
    metadata: { fileCount: uploadedFiles.length, legCount: extractedLegs.length }
  });

  const processingTimeMs = Date.now() - startedAt;

  if (extractedLegs.length === 0) {
    return response.json({ success: true, noFlightData: true, processingTimeMs });
  }

  const documentType = DOCUMENT_TYPES.has(asTrimmedText(extractedPayload?.documentType))
    ? asTrimmedText(extractedPayload.documentType)
    : 'unknown';

  // Boarding passes are evidence of what HAPPENED, not of how the trip was
  // sold. Every airline prints its own record locator, so a perfectly normal
  // Swiss-to-Air-Serbia connection shows two different codes — comparing them
  // would manufacture a "booked separately" warning out of nothing.
  const isBoardingPassUpload = documentType === 'boarding_pass';

  // Cost is deliberately absent from the response body — this endpoint is
  // passenger-facing. It still lands in UsageLog above.
  response.json({
    ...buildIntakeResponse({
      documentType,
      evidenceMode: isBoardingPassUpload ? 'boarding_passes' : 'documents',
      passengers: normalisePassengers(extractedPayload?.passengers),
      bookingReferences: normaliseBookingReferences(extractedPayload?.bookingReferences),
      legs: extractedLegs,
      options: { ignorePnr: isBoardingPassUpload }
    }),
    processingTimeMs
  });
});

// =============================================================================
// STEP 2 — Read what the model returned
// =============================================================================

/**
 * WHAT IT DOES
 *   Turns the model's text response into an object.
 *
 * WHY IT IS BUILT THIS WAY
 *   Structured output usually returns clean JSON, but models occasionally wrap
 *   it in a markdown fence anyway. Stripping the fence costs one line and saves
 *   an otherwise perfectly good extraction from being thrown away as a 502.
 */
function readModelJson(rawResponseText) {
  const withoutMarkdownFence = rawResponseText
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  return JSON.parse(withoutMarkdownFence);
}

// =============================================================================
// STEP 3 — Clean the people and the booking references
// =============================================================================

/**
 * WHAT IT DOES
 *   Trims a value to a string, treating null and undefined as empty.
 *
 * WHY IT IS BUILT THIS WAY
 *   `?? ''` catches both null and undefined in one operator, so every function
 *   after this one can assume it is holding a string.
 */
function asTrimmedText(value) {
  return String(value ?? '').trim();
}

function asUpperCase(value) {
  return asTrimmedText(value).toUpperCase();
}

/**
 * WHAT IT DOES
 *   Returns the value, or an empty string if it is placeholder junk.
 */
function asMeaningfulText(value) {
  const trimmed = asTrimmedText(value);
  return PLACEHOLDER_VALUES.has(trimmed.toLowerCase()) ? '' : trimmed;
}

/**
 * WHAT IT DOES
 *   Collapses the model's passenger list into distinct travellers.
 *
 * WHY IT IS BUILT THIS WAY
 *   Names only — no ticket numbers. A passenger identifier is not needed to
 *   work out what happened to a trip, and asking a model for one invites it to
 *   return a PNR, a frequent-flyer number, or an invention.
 *
 *   A row with no name at all is dropped rather than rendered as an empty card.
 */
function normalisePassengers(extractedPassengers) {
  if (!Array.isArray(extractedPassengers)) return [];

  const seenNameKeys = new Set();

  return extractedPassengers.reduce((passengers, extractedPassenger) => {
    const firstName = asMeaningfulText(extractedPassenger?.firstName);
    const lastName = asMeaningfulText(extractedPassenger?.lastName);

    if (!firstName && !lastName) return passengers;

    const nameKey = `${firstName}|${lastName}`.toLowerCase();
    if (seenNameKeys.has(nameKey)) return passengers;
    seenNameKeys.add(nameKey);

    passengers.push({
      id: `passenger-${passengers.length + 1}`,
      firstName,
      lastName
    });

    return passengers;
  }, []);
}

/**
 * WHAT IT DOES
 *   Collects every booking reference, splitting the carrier prefix back out.
 *
 * WHY IT IS BUILT THIS WAY
 *   A confirmation prints "AA/SNMAUJ, BA/7IQHOL" — the prefix is the airline,
 *   not part of the code — and the model sometimes hands the whole thing over
 *   in the value field. Splitting it here means the rest of the system only
 *   ever sees a bare code plus a carrier.
 */
function normaliseBookingReferences(extractedReferences) {
  if (!Array.isArray(extractedReferences)) return [];

  const seenCodes = new Set();

  return extractedReferences.reduce((references, extractedReference) => {
    const rawValue = asMeaningfulText(extractedReference?.value).toUpperCase();
    const prefixed = rawValue.match(/^([A-Z0-9]{2,3})\s*\/\s*([A-Z0-9]+)$/);

    const code = prefixed ? prefixed[2] : rawValue;
    const carrier = asMeaningfulText(extractedReference?.carrier).toUpperCase()
      || (prefixed ? prefixed[1] : '');

    if (!code || seenCodes.has(code)) return references;
    seenCodes.add(code);

    references.push({ value: code, carrier });
    return references;
  }, []);
}

// =============================================================================
// STEP 4 — Assemble the response
// =============================================================================

/**
 * WHAT IT DOES
 *   Runs the engine and shapes the reply the review screen consumes.
 *
 * WHY IT IS BUILT THIS WAY
 *   There are two ways into this feature — upload a document, or type the
 *   flights in by hand — and they must produce an IDENTICAL shape, or every
 *   screen after them would need to know which was used.
 *
 *   Making them converge at a single named function is the point. Two objects
 *   that merely happen to have the same keys today will drift apart within a
 *   month.
 */
function buildIntakeResponse({ documentType, evidenceMode, passengers, bookingReferences, legs, options }) {
  const {
    journeys,
    replacementItineraries,
    replacementFlights,
    replacements,
    warnings
  } = buildItineraryFromLegs(legs, options || {});

  return {
    success: true,
    documentType,
    evidenceMode,
    passengers,
    bookingReferences,
    // The trip as it was sold. Flights the passenger did not end up taking stay
    // in here, marked `flown: false` — they are still part of the booking.
    booking: { journeys },
    // The flights they were moved onto instead, grouped by the booked flight
    // each rerouting stands in for. Empty when nothing went wrong, which is
    // what the disruption questions branch on.
    replacementItineraries,
    // The same flights flat, for callers that just want the list.
    replacementFlights,
    replacements,
    warnings
  };
}

// =============================================================================
// STEP 5 — The engine
// =============================================================================

/**
 * WHAT IT DOES
 *   Takes a flat list of extracted flights and returns the whole trip
 *   structure: the booking, the replacement flights, and what to warn about.
 *
 * WHY THE STAGE ORDER IS WHAT IT IS
 *   The sequence carries logic that is invisible in the code. Reorder any two
 *   and you get a bug that looks like something else entirely:
 *
 *     normalise    — nothing downstream should ever see raw model output
 *     resolve      — BEFORE dedupe: a partial date ("05MAR") would not match
 *                    the same flight written out in full ("2026-03-05")
 *     dedupe       — BEFORE sort and detection: both would otherwise see two
 *                    flights, and detection could read a duplicate as a rebooking
 *     sort         — ordering must exist before "did they return in between?"
 *                    can use list position as a proxy for time
 *     detect       — BEFORE the booking is assembled: what belongs to the
 *                    booking depends on knowing which flights only exist
 *                    because of a disruption
 *     booking      — now it can safely skip replacements
 *     finalise     — journeys, connections, story, outbound/return labels
 *     group        — everything left over, under the flight it stands in for
 *
 * @param {Array} extractedLegs Flat legs as read from the uploaded documents.
 * @param {{ ignorePnr?: boolean }} [options] ignorePnr for boarding-pass-only
 *   uploads, where booking references say nothing about how the trip was sold.
 */
function buildItineraryFromLegs(extractedLegs, options = {}) {
  const ignorePnr = Boolean(options.ignorePnr);

  if (!Array.isArray(extractedLegs) || extractedLegs.length === 0) {
    return {
      journeys: [],
      replacementItineraries: [],
      replacementFlights: [],
      replacements: [],
      warnings: []
    };
  }

  const legs = sortLegsChronologically(
    mergeDuplicateLegs(
      resolveMissingYears(extractedLegs.map(normaliseExtractedLeg))
    )
  );

  const { replacements } = detectReplacementFlights(legs);

  const bookingChains = buildOriginalBookingChains(legs);
  const bookedLegIds = new Set(bookingChains.flat().map((leg) => leg.id));

  const journeys = flagGroundTransfers(
    labelJourneyRoles(
      bookingChains.map((chain, chainIndex) =>
        finaliseJourney(chain, chainIndex, legs, replacements, ignorePnr))
    )
  );

  const replacementItineraries = buildReplacementItineraries(legs, bookedLegIds, replacements);
  const replacementFlights = replacementItineraries.flatMap((itinerary) => itinerary.legs);

  return {
    journeys,
    replacementItineraries,
    replacementFlights,
    replacements,
    warnings: collectWarnings(journeys, replacementFlights)
  };
}

// =============================================================================
// STEP 6 — Clean each flight
// =============================================================================

/**
 * WHAT IT DOES
 *   Keeps only three capital letters, and only if there are exactly three.
 *
 * WHY IT IS BUILT THIS WAY
 *   This is a validation wearing a cleaner's coat. Returning '' for anything
 *   that is not a three-letter code means the string "Marseille" can never
 *   accidentally become an airport.
 */
function asAirportCode(value) {
  const letters = asUpperCase(value).replace(/[^A-Z]/g, '');
  return letters.length === 3 ? letters : '';
}

/**
 * WHAT IT DOES
 *   Accepts YYYY-MM-DD, or the date half of an ISO datetime. Anything else
 *   comes back empty.
 *
 * WHY IT IS BUILT THIS WAY
 *   Anything it rejects is not lost — it is picked up later by
 *   resolveMissingYears, which handles partials like "05MAR".
 */
function asIsoDateOrEmpty(value) {
  const trimmed = asTrimmedText(value);
  if (ISO_DATE_PATTERN.test(trimmed)) return trimmed;

  const isoDatePrefix = trimmed.match(/^(\d{4}-\d{2}-\d{2})T/);
  return isoDatePrefix ? isoDatePrefix[1] : '';
}

/**
 * WHAT IT DOES
 *   Uppercases a booking reference and strips any carrier prefix.
 */
function asBookingCode(value) {
  const withoutCarrierPrefix = asUpperCase(value).replace(/^[A-Z0-9]{2,3}\s*\/\s*/, '');
  return PLACEHOLDER_VALUES.has(withoutCarrierPrefix.toLowerCase()) ? '' : withoutCarrierPrefix;
}

/**
 * WHAT IT DOES
 *   Turns whatever the model produced into the leg object every other function
 *   in this file relies on, and raises the flags that are knowable from a
 *   single flight in isolation.
 *
 * WHY IT IS BUILT THIS WAY
 *   Three details do a lot of work later:
 *
 *   - STABLE IDS ("leg-1", "leg-2"). The UI keys its edit map off these,
 *     replacements reference them, the story links to them. Generated once,
 *     here, and never renumbered.
 *
 *   - documentOrderIndex. When two flights share a date and there is no clock,
 *     the order the documents listed them in is the only sequence signal there
 *     is. Keep it.
 *
 *   - THREE DATE FIELDS. `rawExtractedDate` is what was printed (shown to the
 *     passenger), `departureDateRaw` is what we will try to parse, and
 *     `departureDateISO` is the resolved value everything computes on. Never
 *     collapse them into one: the passenger needs to see what their document
 *     actually said.
 */
function normaliseExtractedLeg(extractedLeg, index) {
  // A date the model could not fully resolve arrives as a partial ("05MAR").
  // It is kept, never discarded — resolveMissingYears fills the year in later.
  const printedDepartureDate = asMeaningfulText(extractedLeg?.departureDate)
    || asMeaningfulText(extractedLeg?.rawExtractedDate);
  const printedArrivalDate = asMeaningfulText(extractedLeg?.arrivalDate);

  const isoDepartureDate = asIsoDateOrEmpty(extractedLeg?.departureDate);
  const isoArrivalDate = asIsoDateOrEmpty(extractedLeg?.arrivalDate);
  const flightNumber = asUpperCase(extractedLeg?.flightNumber).replace(/\s+/g, '');

  const leg = {
    id: `leg-${index + 1}`,
    documentOrderIndex: index,

    flightNumber,
    marketingAirline: asMeaningfulText(extractedLeg?.marketingAirline),
    marketingAirlineIata: asUpperCase(extractedLeg?.marketingAirlineIata).replace(/[^A-Z0-9]/g, ''),
    operatingAirline: asMeaningfulText(extractedLeg?.operatingAirline),
    operatingAirlineIata: asUpperCase(extractedLeg?.operatingAirlineIata).replace(/[^A-Z0-9]/g, ''),
    pnr: asBookingCode(extractedLeg?.pnr),

    departureIata: asAirportCode(extractedLeg?.departureIata),
    departureCity: asMeaningfulText(extractedLeg?.departureCity),
    arrivalIata: asAirportCode(extractedLeg?.arrivalIata),
    arrivalCity: asMeaningfulText(extractedLeg?.arrivalCity),

    rawExtractedDate: asMeaningfulText(extractedLeg?.rawExtractedDate) || printedDepartureDate,
    departureDate: isoDepartureDate,
    departureDateRaw: printedDepartureDate,
    departureDateISO: isoDepartureDate,
    // 'document' | 'sibling' | 'current' — filled in by resolveMissingYears.
    yearSource: '',

    // An arrival with no printed date lands the same day unless stated otherwise.
    arrivalDate: isoArrivalDate || isoDepartureDate,
    arrivalDateRaw: printedArrivalDate || printedDepartureDate,
    arrivalDateISO: isoArrivalDate || isoDepartureDate,

    // The model's own read of whether this flight was flown. Stored, but it can
    // never decide anything — see modelAgreesWithTimeline.
    reportedStatus: asMeaningfulText(extractedLeg?.flightStatus),

    passengerNames: Array.isArray(extractedLeg?.passengerNames)
      ? extractedLeg.passengerNames.map(asMeaningfulText).filter(Boolean)
      : [],
    documentIndex: Number.isInteger(extractedLeg?.documentIndex) ? extractedLeg.documentIndex : 0,

    flags: []
  };

  if (!leg.departureDateRaw) leg.flags.push(FLAGS.MISSING_DATE);
  if (NOT_FLOWN_STATUSES.has(leg.reportedStatus.toLowerCase())) {
    leg.flags.push(FLAGS.REPORTED_NOT_FLOWN);
  }
  if (!leg.departureIata || !leg.arrivalIata) leg.flags.push(FLAGS.MISSING_AIRPORT);

  // Two flight numbers in one printed row ("BA494/AA7041") is either a
  // codeshare (one flight) or a hidden stopover (two). We genuinely cannot
  // tell, so we do not guess — flag it and let the review screen ask.
  if (MULTIPLE_FLIGHT_NUMBERS_PATTERN.test(leg.flightNumber)) {
    leg.flags.push(FLAGS.AMBIGUOUS_FLIGHT_NUMBER);
  }

  return leg;
}

// =============================================================================
// STEP 7 — Resolve missing years
// =============================================================================
//
// A boarding pass prints "05MAR". No year. This is the most load-bearing part
// of the file: no date means no ordering, and no ordering means connections and
// replacements cannot be detected at all.
//
// An early version of the prompt said "leave the date blank if the year is not
// printed". The model generalised that to any date it was unsure about, every
// partial was rejected, and the whole pipeline went silent — no error, no
// crash, every request returning 200 and doing nothing.

/**
 * WHAT IT DOES
 *   Converts an ISO date to a UTC millisecond timestamp, or null.
 *
 * WHY IT IS BUILT THIS WAY
 *   null — not 0, not NaN, not a thrown error — means "unknown". Every caller
 *   then has to make a conscious decision about what unknown means for its own
 *   question, which is exactly the decision you want made deliberately.
 *
 *   Date.UTC everywhere, never local time: the server's timezone must not be
 *   able to change the answer.
 */
function dateToUtcMillis(isoDate) {
  if (!isoDate) return null;

  const [year, month, day] = isoDate.split('-').map(Number);
  const millis = Date.UTC(year, month - 1, day);
  return Number.isNaN(millis) ? null : millis;
}

function wholeDaysBetween(fromIsoDate, toIsoDate) {
  const from = dateToUtcMillis(fromIsoDate);
  const to = dateToUtcMillis(toIsoDate);
  if (from === null || to === null) return null;

  return Math.round((to - from) / 86400000);
}

/**
 * Ordering and every gap run on the RESOLVED date, which may carry a year we
 * assumed rather than one we read.
 */
function departureDayMillis(leg) {
  return dateToUtcMillis(leg.departureDateISO);
}

const currentUtcYear = () => new Date().getUTCFullYear();

function toIsoDate(month, day, year) {
  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0')
  ].join('-');
}

/**
 * A single sortable integer for a month and day, so "did the calendar go
 * backwards?" is one integer comparison instead of two.
 */
function monthDayOrderKey(dateParts) {
  return dateParts.month * 100 + dateParts.day;
}

/**
 * WHAT IT DOES
 *   Fills in the year on every leg that did not print one, and records where
 *   that year came from.
 *
 * WHY IT IS BUILT THIS WAY
 *   Four moves: anchor on the first leg that carries a real year, propagate it
 *   to the partials, fall back to the current year if no document anywhere has
 *   one, and always record which of those happened.
 *
 *   The fallback deserves a defence, because the first version did the opposite
 *   — it left the date blank and asked the passenger. That is more honest and
 *   it was worse: a blank stops someone mid-claim, and claims are filed close
 *   to the flights they are about, so the current year is right the
 *   overwhelming majority of the time.
 *
 *   The discipline is not "never guess". It is NEVER GUESS INVISIBLY. That is
 *   the entire job of `yearSource`.
 */
function resolveMissingYears(legs) {
  const parsedLegs = legs.map((leg) => ({
    leg,
    departureParts: readPrintedDate(leg.departureDateRaw),
    arrivalParts: readPrintedDate(leg.arrivalDateRaw)
  }));

  const anchorYear = parsedLegs
    .find((entry) => entry.departureParts?.hasYear)?.departureParts.year ?? null;

  let workingYear = anchorYear ?? currentUtcYear();
  let previousMonthDay = null;

  parsedLegs.forEach(({ leg, departureParts, arrivalParts }) => {
    if (!departureParts) return;

    if (departureParts.hasYear) {
      workingYear = departureParts.year;
    } else if (previousMonthDay !== null && monthDayOrderKey(departureParts) < previousMonthDay) {
      // The itinerary went backwards in the calendar. That is a New Year
      // rollover, not time travel.
      workingYear += 1;
    }

    const resolvedDepartureDate = toIsoDate(departureParts.month, departureParts.day, workingYear);
    leg.departureDateISO = resolvedDepartureDate;
    leg.departureDate = resolvedDepartureDate;

    if (departureParts.hasYear) {
      leg.yearSource = 'document';
    } else {
      // 'sibling' — another document in this upload printed the year, so it is
      // as good as printed. 'current' — nothing did, so this is our assumption.
      leg.yearSource = anchorYear !== null ? 'sibling' : 'current';
      leg.flags.push(FLAGS.ASSUMED_YEAR);
    }

    previousMonthDay = monthDayOrderKey(departureParts);

    if (arrivalParts) {
      // An arrival earlier in the calendar than its departure crossed midnight.
      const arrivalYear = arrivalParts.hasYear
        ? arrivalParts.year
        : workingYear + (monthDayOrderKey(arrivalParts) < monthDayOrderKey(departureParts) ? 1 : 0);

      const resolvedArrivalDate = toIsoDate(arrivalParts.month, arrivalParts.day, arrivalYear);

      // No flight lands before it takes off, and none is still airborne two
      // days later. An arrival outside that window came from a misread field,
      // so fall back to the departure date rather than trust it — a bad arrival
      // date silently breaks connection detection.
      const daysAloft = wholeDaysBetween(resolvedDepartureDate, resolvedArrivalDate);
      const isBelievable = daysAloft !== null && daysAloft >= 0 && daysAloft <= 2;

      leg.arrivalDateISO = isBelievable ? resolvedArrivalDate : resolvedDepartureDate;
    } else {
      leg.arrivalDateISO = resolvedDepartureDate;
    }

    leg.arrivalDate = leg.arrivalDateISO;
  });

  return legs;
}

// =============================================================================
// STEP 8 — Merge the same flight listed twice
// =============================================================================

/**
 * WHAT IT DOES
 *   Builds the key that identifies one physical flight, or '' to opt out.
 *
 * WHY IT IS BUILT THIS WAY
 *   A flight number is unique to one airline on one day. Same number, same
 *   date, same route can therefore only ever be ONE physical flight — that is
 *   a fact about aviation, not a heuristic, which is what makes merging safe to
 *   do deterministically instead of hoping the prompt catches it.
 *
 *   Legs with no flight number return '' and are never merged: there is nothing
 *   solid to match on, and silently merging two genuinely different flights is
 *   far worse than showing both.
 */
function physicalFlightKey(leg) {
  if (!leg.flightNumber) return '';
  return [leg.flightNumber, leg.departureDateISO, leg.departureIata, leg.arrivalIata].join('|');
}

/**
 * WHAT IT DOES
 *   Folds a duplicate copy of a flight into the one we are keeping.
 *
 * WHY IT IS BUILT THIS WAY
 *   Each field is taken from whichever copy actually filled it in — one
 *   passenger's block may name the airline where another's leaves it blank —
 *   and the passenger names are unioned rather than overwritten.
 */
function mergeDuplicateLegInto(keptLeg, duplicateLeg) {
  const FIELDS_TO_BACKFILL = [
    'marketingAirline', 'marketingAirlineIata', 'operatingAirline', 'operatingAirlineIata',
    'pnr', 'departureCity', 'arrivalCity', 'rawExtractedDate', 'reportedStatus'
  ];

  FIELDS_TO_BACKFILL.forEach((field) => {
    if (!keptLeg[field] && duplicateLeg[field]) keptLeg[field] = duplicateLeg[field];
  });

  duplicateLeg.passengerNames.forEach((name) => {
    if (!keptLeg.passengerNames.includes(name)) keptLeg.passengerNames.push(name);
  });

  duplicateLeg.flags.forEach((flag) => {
    if (!keptLeg.flags.includes(flag)) keptLeg.flags.push(flag);
  });

  return keptLeg;
}

/**
 * WHAT IT DOES
 *   Collapses repeated printings of the same flight into one leg.
 *
 * WHY IT IS BUILT THIS WAY
 *   A confirmation lists each segment ONCE PER PASSENGER — the same flight, one
 *   block per traveller, each with its own record locator and e-ticket number.
 *   Read literally that is two flights, and two flights put a phantom journey in
 *   the middle of the trip: a real Alicante-Istanbul-Algiers-Alicante booking
 *   came back as THREE trips, with "Trip 2: Marseille to Istanbul" wedged
 *   between the outbound and the return.
 */
function mergeDuplicateLegs(legs) {
  const legByFlightKey = new Map();

  return legs.filter((leg) => {
    const flightKey = physicalFlightKey(leg);
    if (!flightKey) return true;

    const alreadyKept = legByFlightKey.get(flightKey);
    if (alreadyKept) {
      mergeDuplicateLegInto(alreadyKept, leg);
      return false;
    }

    legByFlightKey.set(flightKey, leg);
    return true;
  });
}

// =============================================================================
// STEP 9 — Put the flights in order
// =============================================================================

/**
 * WHAT IT DOES
 *   Sorts by day, then by the order the flights appeared in the documents.
 *   Legs with no readable date sort last rather than being dropped.
 *
 * WHY IT IS BUILT THIS WAY
 *   My first version sorted by "day plus time, defaulting a missing time to
 *   00:00". That sent every untimed leg to the front of its own day and broke
 *   the connection chain.
 *
 *   The lesson: when some rows carry a signal and others do not, do not invent
 *   the missing signal — fall back to a neutral one (document order) for
 *   everybody.
 */
function sortLegsChronologically(legs) {
  return legs
    .map((leg, index) => ({ leg, index }))
    .sort((first, second) => {
      const firstDay = departureDayMillis(first.leg);
      const secondDay = departureDayMillis(second.leg);

      if (firstDay === null && secondDay === null) return first.index - second.index;
      if (firstDay === null) return 1;
      if (secondDay === null) return -1;
      if (firstDay !== secondDay) return firstDay - secondDay;

      return first.index - second.index;
    })
    .map((entry) => entry.leg);
}

// =============================================================================
// STEP 10 — Work out which flight replaced which
// =============================================================================
//
// A passenger who misses or loses a flight ends up holding two boarding passes
// covering the same piece of the trip, and NOTHING on the documents says which
// one they actually flew. This is the core of the feature.

function passengerNameKey(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z]/g, '');
}

/**
 * WHAT IT DOES
 *   Says whether two legs could belong to the same traveller.
 *
 * WHY IT IS BUILT THIS WAY
 *   Read the first line carefully: it returns TRUE when either side has no
 *   names at all. That is deliberate. A nameless boarding pass should still
 *   work, so unknown is treated as "could be the same person" — the alternative
 *   silently drops real disruptions on documents that happen not to print a name.
 */
function legsCouldShareAPassenger(firstLeg, secondLeg) {
  if (firstLeg.passengerNames.length === 0 || secondLeg.passengerNames.length === 0) return true;

  const firstLegNameKeys = new Set(firstLeg.passengerNames.map(passengerNameKey));
  return secondLeg.passengerNames.some((name) => firstLegNameKeys.has(passengerNameKey(name)));
}

/**
 * WHAT IT DOES
 *   Says whether the passenger came back to an airport between two points in
 *   the trip.
 *
 * WHY IT IS BUILT THIS WAY
 *   It takes INDEXES, not dates. The list is already sorted chronologically, so
 *   an index between two others is a flight between them in time — and unlike a
 *   date comparison it stays exact when several flights share a day. When you
 *   have already established an ordering, use it.
 */
function passengerReturnedToAirportBetween(legs, airportCode, fromIndex, toIndex) {
  for (let index = fromIndex + 1; index < toIndex; index += 1) {
    if (legs[index].arrivalIata === airportCode) return true;
  }
  return false;
}

/**
 * WHAT IT DOES
 *   The definition of a connection: the second flight leaves from where the
 *   first one landed, no more than a day later.
 *
 * WHY IT IS BUILT THIS WAY
 *   Every other part of the engine calls this rather than re-implementing the
 *   check, so "what counts as a connection" means exactly one thing everywhere
 *   and there is exactly one place to change it.
 */
function secondFlightCouldFollowFirst(firstLeg, secondLeg) {
  if (!firstLeg.arrivalIata || !secondLeg.departureIata) return false;
  if (firstLeg.arrivalIata !== secondLeg.departureIata) return false;

  const daysApart = wholeDaysBetween(
    firstLeg.arrivalDateISO || firstLeg.departureDateISO,
    secondLeg.departureDateISO
  );

  return daysApart !== null && daysApart >= 0 && daysApart <= MAX_CONNECTION_DAYS;
}

/**
 * WHAT IT DOES
 *   Walks forward through chaining flights to see whether the passenger
 *   eventually lands at a given airport.
 *
 * WHY IT IS BUILT THIS WAY
 *   Because a rebooking can reroute. MAD-GRU replaced by MAD-LIS-GRU is still a
 *   replacement, and without this recursive walk you would only ever catch
 *   same-route swaps. The `visitedIndexes` set stops it looping.
 */
function flightEventuallyReaches(legs, startIndex, destinationIata, visitedIndexes = new Set()) {
  const startLeg = legs[startIndex];
  if (!startLeg.arrivalIata) return false;
  if (startLeg.arrivalIata === destinationIata) return true;

  for (let nextIndex = startIndex + 1; nextIndex < legs.length; nextIndex += 1) {
    if (visitedIndexes.has(nextIndex)) continue;
    if (!secondFlightCouldFollowFirst(startLeg, legs[nextIndex])) continue;

    visitedIndexes.add(nextIndex);
    if (flightEventuallyReaches(legs, nextIndex, destinationIata, visitedIndexes)) return true;
  }

  return false;
}

/**
 * WHAT IT DOES
 *   Decides WHY the original flight was not taken.
 *
 * WHY IT IS BUILT THIS WAY
 *   Read off position in the timeline, never from anything the model said: if
 *   an earlier flight fed into that airport the passenger was connecting, so it
 *   was a missed connection. Otherwise the disruption happened where the trip
 *   started, so it was a rebooking.
 */
function inferWhyOriginalWasNotFlown(flownLegs, originalLeg) {
  const wasFedByAnEarlierFlight = flownLegs.some((leg) =>
    leg !== originalLeg && secondFlightCouldFollowFirst(leg, originalLeg));

  return wasFedByAnEarlierFlight
    ? REPLACEMENT_REASONS.MISSED_CONNECTION
    : REPLACEMENT_REASONS.REBOOKED;
}

/**
 * WHAT IT DOES
 *   Finds the flight that replaced a given one, or returns -1.
 *
 * WHY IT IS BUILT THIS WAY — FIVE CLAUSES, ALL LOAD-BEARING
 *
 *   1. Same departure airport, later, within 3 days.
 *      The shape of a rebooking. Beyond that it is a different trip.
 *
 *   2. Eventually reaches the same destination.
 *      Otherwise ANY later flight out of that airport would qualify.
 *
 *   3. The passenger never returned to that airport in between.
 *      This is the clever one. LHR-CDG on Monday and LHR-CDG on Wednesday is
 *      two trips if a CDG-LHR leg sits between them, and a rebooking if nothing
 *      does. Remove this clause and every return trip in the world becomes a
 *      rebooking.
 *
 *   4. Shared passenger.
 *      Two travellers' documents never replace each other.
 *
 *   5. Not the same flight number on the same day.
 *      That is a duplicate document, not a disruption.
 */
function findReplacementFor(legs, originalIndex, supersededByIndex) {
  const originalLeg = legs[originalIndex];

  if (!originalLeg.departureIata || !originalLeg.arrivalIata) return -1;
  if (departureDayMillis(originalLeg) === null) return -1;

  for (let candidateIndex = originalIndex + 1; candidateIndex < legs.length; candidateIndex += 1) {
    if (supersededByIndex.has(candidateIndex)) continue;

    const candidateLeg = legs[candidateIndex];
    if (candidateLeg.departureIata !== originalLeg.departureIata) continue;
    if (departureDayMillis(candidateLeg) === null) continue;

    const daysLater = wholeDaysBetween(originalLeg.departureDateISO, candidateLeg.departureDateISO);
    if (daysLater === null || daysLater < 0 || daysLater > REPLACEMENT_WINDOW_DAYS) continue;

    // Same day is a real rebooking — unless it is literally the same flight
    // printed twice, which is a duplicate document, not a disruption.
    const isSameFlightPrintedTwice = daysLater === 0
      && originalLeg.flightNumber
      && originalLeg.flightNumber === candidateLeg.flightNumber;
    if (isSameFlightPrintedTwice) continue;

    if (!legsCouldShareAPassenger(originalLeg, candidateLeg)) continue;
    if (passengerReturnedToAirportBetween(
      legs, originalLeg.departureIata, originalIndex, candidateIndex
    )) continue;
    if (!flightEventuallyReaches(legs, candidateIndex, originalLeg.arrivalIata)) continue;

    return candidateIndex;
  }

  return -1;
}

/**
 * WHAT IT DOES
 *   Says whether the model independently reached the same conclusion the
 *   timeline did.
 *
 * WHY IT IS BUILT THIS WAY
 *   This is the ONLY place the model's opinion is consulted, and look how
 *   carefully it is fenced: it can move `confidence` from 'medium' to 'high'
 *   and nothing else. It can never change the answer. The timeline decides; the
 *   model corroborates — so a disagreement becomes visible instead of silent.
 */
function modelAgreesWithTimeline(originalLeg, replacementLeg) {
  const originalReadAsUnused = NOT_FLOWN_STATUSES.has(originalLeg.reportedStatus.toLowerCase());
  const replacementReadAsReplacement =
    replacementLeg.reportedStatus.toLowerCase() === 'replacement flight';

  return originalReadAsUnused || replacementReadAsReplacement;
}

/**
 * WHAT IT DOES
 *   Pairs every superseded flight with the flight that replaced it, and wires
 *   the relationship in both directions.
 *
 * WHY IT IS BUILT THIS WAY
 *   The superseded leg is NEVER deleted. It hangs off the flight that replaced
 *   it, because a flight the passenger booked and did not take is a central
 *   fact of their claim, not noise to be filtered out.
 */
function detectReplacementFlights(legs) {
  const supersededByIndex = new Map();

  for (let index = 0; index < legs.length; index += 1) {
    if (supersededByIndex.has(index)) continue;

    const replacementIndex = findReplacementFor(legs, index, supersededByIndex);
    if (replacementIndex !== -1) supersededByIndex.set(index, replacementIndex);
  }

  const flownLegs = legs.filter((_, index) => !supersededByIndex.has(index));
  const replacements = [];

  supersededByIndex.forEach((replacementIndex, originalIndex) => {
    const originalLeg = legs[originalIndex];
    const replacementLeg = legs[replacementIndex];

    const daysLater = wholeDaysBetween(
      originalLeg.departureDateISO,
      replacementLeg.departureDateISO
    );

    originalLeg.isSuperseded = true;
    originalLeg.supersededByLegId = replacementLeg.id;
    originalLeg.flags.push(FLAGS.REPLACED);

    const replacementRecord = {
      id: `replacement-${replacements.length + 1}`,
      originalLeg,
      originalLegId: originalLeg.id,
      replacementLegId: replacementLeg.id,
      fromIata: originalLeg.departureIata,
      toIata: originalLeg.arrivalIata,
      daysLater,
      sameRoute: originalLeg.arrivalIata === replacementLeg.arrivalIata,
      sameCarrier: flownBySameCarrier(originalLeg, replacementLeg) === true,
      reason: inferWhyOriginalWasNotFlown(flownLegs, originalLeg),
      confidence: modelAgreesWithTimeline(originalLeg, replacementLeg) ? 'high' : 'medium'
    };

    replacementLeg.isReplacement = true;
    replacementLeg.replacesLegId = originalLeg.id;
    replacementLeg.replacedLeg = originalLeg;
    replacementLeg.replacementReason = replacementRecord.reason;
    replacementLeg.replacementDaysLater = daysLater;
    if (!replacementLeg.flags.includes(FLAGS.REPLACEMENT)) {
      replacementLeg.flags.push(FLAGS.REPLACEMENT);
    }

    replacements.push(replacementRecord);
  });

  return { flownLegs, replacements };
}

// =============================================================================
// STEP 11 — Rebuild the trip as it was sold
// =============================================================================

/**
 * WHAT IT DOES
 *   Compares two optional codes, returning true, false, or null.
 *
 * WHY IT IS BUILT THIS WAY
 *   Three-valued on purpose. "These PNRs differ" and "we do not know one of
 *   these PNRs" are different facts, and only the first should raise a warning.
 *   A two-valued comparison would flag every missing field as a mismatch.
 */
function compareOptionalCodes(firstCode, secondCode) {
  if (!firstCode || !secondCode) return null;
  return firstCode === secondCode;
}

function flownBySameCarrier(firstLeg, secondLeg) {
  const byIataCode = compareOptionalCodes(
    firstLeg.operatingAirlineIata,
    secondLeg.operatingAirlineIata
  );
  if (byIataCode !== null) return byIataCode;

  return compareOptionalCodes(
    firstLeg.operatingAirline.toUpperCase(),
    secondLeg.operatingAirline.toUpperCase()
  );
}

/**
 * WHAT IT DOES
 *   Walks a chain of flights forward, always taking the earliest onward flight
 *   that passes the `isAcceptable` test.
 *
 * WHY IT IS BUILT THIS WAY
 *   This is the tidiest thing in the file: ONE function doing two opposite jobs.
 *
 *     isAcceptable = wasPartOfOriginalBooking  ->  the trip as it was SOLD
 *     isAcceptable = wasActuallyFlown          ->  the trip as it HAPPENED
 *
 *   Diff those two chains and you have the entire story of the disruption, with
 *   no second traversal to keep in sync.
 *
 *   Two guards inside it:
 *     - `visitedAirports` stops an infinite loop on a circular itinerary.
 *     - A candidate arriving back at the chain's ORIGIN is rejected, because
 *       that is the way home, not a connection. Without it a quick
 *       there-and-back reads as one journey with a stop in the middle.
 */
function walkChainForward(allLegs, startLeg, isAcceptable) {
  const chain = [startLeg];
  const usedLegIds = new Set([startLeg.id]);
  const visitedAirports = new Set([startLeg.departureIata]);
  const chainOriginIata = startLeg.departureIata;

  let currentLeg = startLeg;

  while (currentLeg.arrivalIata && !visitedAirports.has(currentLeg.arrivalIata)) {
    visitedAirports.add(currentLeg.arrivalIata);

    let earliestOnwardLeg = null;
    let earliestOnwardDay = null;

    allLegs.forEach((candidateLeg) => {
      if (usedLegIds.has(candidateLeg.id)) return;
      if (!isAcceptable(candidateLeg)) return;
      if (chainOriginIata && candidateLeg.arrivalIata === chainOriginIata) return;
      if (!legsCouldShareAPassenger(currentLeg, candidateLeg)) return;
      if (!secondFlightCouldFollowFirst(currentLeg, candidateLeg)) return;

      const candidateDay = departureDayMillis(candidateLeg);
      if (candidateDay === null) return;

      if (earliestOnwardDay === null || candidateDay < earliestOnwardDay) {
        earliestOnwardLeg = candidateLeg;
        earliestOnwardDay = candidateDay;
      }
    });

    if (!earliestOnwardLeg) break;

    chain.push(earliestOnwardLeg);
    usedLegIds.add(earliestOnwardLeg.id);
    currentLeg = earliestOnwardLeg;
  }

  return chain;
}

const wasPartOfOriginalBooking = (leg) => !leg.isReplacement;
const wasActuallyFlown = (leg) => !leg.isSuperseded;

/**
 * WHAT IT DOES
 *   Rebuilds the trip the passenger actually booked, as one or more chains.
 *
 * WHY IT IS BUILT THIS WAY — THE SEEDING RULE
 *   A chain may only START from a leg that is not itself a replacement AND does
 *   not depart from an airport a replacement flight delivered the passenger to.
 *
 *   That second clause took two attempts. Here is the case that forced it, a
 *   real Swiss reroute:
 *
 *     LX2087  LIS -> ZRH   booked, flown
 *     LX1418  ZRH -> BEG   booked, NOT flown
 *     LX0724  ZRH -> AMS   replacement for LX1418
 *     JU0261  AMS -> BEG   booked during the disruption, NOT flown
 *     JU263   AMS -> BEG   replacement for JU0261
 *
 *   JU0261 is not a replacement — nothing had replaced it at the moment it was
 *   arranged — so a naive rule seeds a brand new "booking" starting at
 *   Amsterdam. But the passenger never booked anything from Amsterdam; they
 *   only ended up there because Zurich fell through.
 *
 *   The general move: when a rule fails on a real document, resist
 *   special-casing that document. Find the PROPERTY that distinguishes it.
 */
function buildOriginalBookingChains(legs) {
  const airportsReachedByReplacements = new Set(
    legs.filter((leg) => leg.isReplacement && leg.arrivalIata).map((leg) => leg.arrivalIata)
  );

  const chains = [];
  const claimedLegIds = new Set();

  legs.forEach((leg) => {
    if (claimedLegIds.has(leg.id)) return;
    if (leg.isReplacement) return;
    if (airportsReachedByReplacements.has(leg.departureIata)) return;

    const chain = walkChainForward(legs, leg, (candidateLeg) =>
      wasPartOfOriginalBooking(candidateLeg) && !claimedLegIds.has(candidateLeg.id));

    chain.forEach((chainLeg) => claimedLegIds.add(chainLeg.id));
    chains.push(chain);
  });

  return chains;
}

// =============================================================================
// STEP 12 — Turn each chain into a journey
// =============================================================================

/**
 * WHAT IT DOES
 *   Describes the point where the passenger changes planes.
 *
 * WHY IT IS BUILT THIS WAY
 *   Layover length went with the clock. What survives is what a claim actually
 *   turns on: where they changed planes, whether the two flights were sold
 *   under one booking, and (added later) whether that stop was ever planned.
 *
 *   `ignorePnr` is set for boarding-pass uploads — see extractClaimIntake.
 */
function describeConnection(arrivingLeg, departingLeg, ignorePnr) {
  const samePnr = ignorePnr ? null : compareOptionalCodes(arrivingLeg.pnr, departingLeg.pnr);

  const connection = {
    atIata: departingLeg.departureIata || arrivingLeg.arrivalIata,
    atCity: departingLeg.departureCity || arrivingLeg.arrivalCity,
    fromLegId: arrivingLeg.id,
    toLegId: departingLeg.id,
    daysApart: wholeDaysBetween(
      arrivingLeg.arrivalDateISO || arrivingLeg.departureDateISO,
      departingLeg.departureDateISO
    ),
    samePnr,
    sameOperatingCarrier: flownBySameCarrier(arrivingLeg, departingLeg),
    flags: []
  };

  // Booked on separate references: a missed connection here may not be the
  // airline's liability, which is the single most consequential thing to
  // surface about a connection.
  if (samePnr === false) connection.flags.push(FLAGS.SPLIT_PNR_CONNECTION);

  return connection;
}

function airportCodesAlong(chain) {
  if (chain.length === 0) return [];
  return [chain[0].departureIata, ...chain.map((leg) => leg.arrivalIata)].filter(Boolean);
}

function asPlace(iata, city) {
  return { iata: iata || '', city: city || '' };
}

/** Every airport touched, in order, named as well as coded — the review screen
 *  draws the booked route against the flown one and needs both. */
function namedPlacesAlong(chain) {
  if (chain.length === 0) return [];
  return [
    asPlace(chain[0].departureIata, chain[0].departureCity),
    ...chain.map((leg) => asPlace(leg.arrivalIata, leg.arrivalCity))
  ];
}

function summariseLeg(leg) {
  return {
    id: leg.id,
    flightNumber: leg.flightNumber,
    from: asPlace(leg.departureIata, leg.departureCity),
    to: asPlace(leg.arrivalIata, leg.arrivalCity),
    date: leg.departureDate
  };
}

/**
 * WHAT IT DOES
 *   Turns one replacement into a described event.
 *
 * WHY IT IS BUILT THIS WAY
 *   Two kinds, and the distinction matters. A REROUTE landed somewhere else, so
 *   a stop entered the trip that was never planned. A LATER_FLIGHT is the same
 *   route, later departure. Rendering both identically — which the first
 *   version did — hides the fact that one of them changed the shape of the
 *   journey.
 */
function describeDisruptionEvent(replacementRecord, replacementLeg, bookedRoute) {
  const originalLeg = replacementRecord.originalLeg;

  const wasRerouted = Boolean(
    originalLeg.arrivalIata
    && replacementLeg.arrivalIata
    && originalLeg.arrivalIata !== replacementLeg.arrivalIata
  );

  const addedStops = wasRerouted
    && replacementLeg.arrivalIata
    && !bookedRoute.includes(replacementLeg.arrivalIata)
    ? [replacementLeg.arrivalIata]
    : [];

  return {
    id: replacementRecord.id,
    kind: wasRerouted ? 'REROUTE' : 'LATER_FLIGHT',
    reason: replacementRecord.reason,
    at: asPlace(originalLeg.departureIata, originalLeg.departureCity),
    original: summariseLeg(originalLeg),
    replacement: summariseLeg(replacementLeg),
    daysLater: replacementRecord.daysLater,
    addedStops
  };
}

/**
 * WHAT IT DOES
 *   Diffs the booked chain against the flown chain and describes the difference.
 *
 * WHY IT IS BUILT THIS WAY
 *   The two flight lists say what was booked and what replaced it. They do not
 *   say it as a sentence, and on a rerouted trip the sentence is what makes it
 *   land: a stop that only exists because something fell through reads exactly
 *   like a stop the passenger chose, unless we say otherwise.
 *
 *   `changedRoute` is what the UI gates on. A straight rebooking is already
 *   fully told by the flight rows themselves; narrating it again above them
 *   just teaches people to skip both.
 */
function buildDisruptionStory(bookedChain, flownChain, replacements) {
  const legIdsInThisJourney = new Set([...bookedChain, ...flownChain].map((leg) => leg.id));

  const relevantReplacements = replacements.filter((record) =>
    legIdsInThisJourney.has(record.originalLegId)
    || legIdsInThisJourney.has(record.replacementLegId));

  // No disruption, no story.
  if (relevantReplacements.length === 0) return null;

  const bookedRoute = airportCodesAlong(bookedChain);
  const flownRoute = airportCodesAlong(flownChain);

  const lastBookedLeg = bookedChain[bookedChain.length - 1];
  const lastFlownLeg = flownChain[flownChain.length - 1];

  const legById = new Map([...bookedChain, ...flownChain].map((leg) => [leg.id, leg]));

  const events = relevantReplacements
    .map((record) => {
      const replacementLeg = legById.get(record.replacementLegId);
      return replacementLeg
        ? describeDisruptionEvent(record, replacementLeg, bookedRoute)
        : null;
    })
    .filter(Boolean);

  const addedStops = flownRoute.filter((iata, position) =>
    position > 0 && position < flownRoute.length - 1 && !bookedRoute.includes(iata));

  return {
    changedRoute: bookedRoute.join('>') !== flownRoute.join('>'),
    booked: {
      route: bookedRoute,
      places: namedPlacesAlong(bookedChain),
      legs: bookedChain.map(summariseLeg),
      stopCount: Math.max(0, bookedChain.length - 1),
      destination: asPlace(lastBookedLeg.arrivalIata, lastBookedLeg.arrivalCity),
      arrivalDate: lastBookedLeg.arrivalDate
    },
    flown: {
      route: flownRoute,
      places: namedPlacesAlong(flownChain),
      legs: flownChain.map(summariseLeg),
      stopCount: Math.max(0, flownChain.length - 1),
      destination: asPlace(lastFlownLeg.arrivalIata, lastFlownLeg.arrivalCity),
      arrivalDate: lastFlownLeg.arrivalDate
    },
    events,
    outcome: {
      // False means the trip ended somewhere other than where it was headed:
      // a stranded passenger, not a delayed one.
      reachedDestination: Boolean(lastFlownLeg.arrivalIata)
        && lastFlownLeg.arrivalIata === lastBookedLeg.arrivalIata,
      addedStops,
      extraStopCount: Math.max(0, flownChain.length - bookedChain.length),
      // Kept for the assessment summary; the review screen no longer says it.
      daysLate: wholeDaysBetween(
        lastBookedLeg.arrivalDateISO || lastBookedLeg.departureDateISO,
        lastFlownLeg.arrivalDateISO || lastFlownLeg.departureDateISO
      )
    }
  };
}

/**
 * WHAT IT DOES
 *   Turns one booked chain into the journey object the client renders.
 *
 * WHY IT IS BUILT THIS WAY
 *   Note how the flown chain is found: start where the BOOKING started — or on
 *   the flight that replaced it, if that first booked leg was superseded — and
 *   then follow only flights that were actually flown.
 */
function finaliseJourney(bookedChain, chainIndex, allLegs, replacements, ignorePnr) {
  const firstBookedLeg = bookedChain[0];
  const lastBookedLeg = bookedChain[bookedChain.length - 1];

  const connections = [];
  for (let position = 1; position < bookedChain.length; position += 1) {
    connections.push(describeConnection(
      bookedChain[position - 1], bookedChain[position], ignorePnr
    ));
  }

  const flownChainStartLeg = firstBookedLeg.isSuperseded
    ? allLegs.find((leg) => leg.id === firstBookedLeg.supersededByLegId) || firstBookedLeg
    : firstBookedLeg;

  const flownChain = walkChainForward(allLegs, flownChainStartLeg, wasActuallyFlown);
  const story = buildDisruptionStory(bookedChain, flownChain, replacements);

  const eventIds = story ? story.events.map((event) => event.id) : [];
  const journeyReplacements = replacements.filter((record) => eventIds.includes(record.id));

  // A layover the passenger never chose must not look like one they did.
  if (story) {
    connections.forEach((connection) => {
      if (story.outcome.addedStops.includes(connection.atIata)) {
        connection.flags.push(FLAGS.UNPLANNED_STOP);
      }
    });
  }

  return {
    id: `journey-${chainIndex + 1}`,
    legs: bookedChain.map((leg) => ({ ...leg, flown: !leg.isSuperseded })),
    connections,
    flags: journeyReplacements.length > 0 ? [FLAGS.HAS_REPLACEMENT] : [],
    story,
    replacements: journeyReplacements,
    isDirect: bookedChain.length === 1,
    stopCount: bookedChain.length - 1,
    origin: asPlace(firstBookedLeg.departureIata, firstBookedLeg.departureCity),
    finalDestination: asPlace(lastBookedLeg.arrivalIata, lastBookedLeg.arrivalCity),
    departureDate: firstBookedLeg.departureDate,
    arrivalDate: lastBookedLeg.arrivalDate
  };
}

/**
 * WHAT IT DOES
 *   Labels the set of journeys Outbound / Return / Onward / Trip.
 *
 * WHY IT IS BUILT THIS WAY
 *   It reads AIRPORTS ONLY, never dates. That is what makes an open jaw work —
 *   fly out to Barcelona, home from Madrid, and it still reads as a return —
 *   and it stops two unrelated trips in one upload being forced into a shape
 *   they are not. Choosing which signal to key on is the design work.
 */
function labelJourneyRoles(journeys) {
  if (journeys.length < 2) {
    return journeys.map((journey) => ({ ...journey, role: JOURNEY_ROLES.TRIP }));
  }

  const homeAirportIata = journeys[0].origin.iata;

  const roles = journeys.map((journey, index) => {
    if (index === 0) return null;

    // Ends up back where the whole trip started: this is the way home.
    if (homeAirportIata && journey.finalDestination.iata === homeAirportIata) {
      return JOURNEY_ROLES.RETURN;
    }
    // Picks up where the previous journey left off: still going out.
    if (journey.origin.iata && journey.origin.iata === journeys[index - 1].finalDestination.iata) {
      return JOURNEY_ROLES.ONWARD;
    }
    return JOURNEY_ROLES.TRIP;
  });

  // The first journey is only an "outbound" if something later comes back.
  roles[0] = roles.includes(JOURNEY_ROLES.RETURN) ? JOURNEY_ROLES.OUTBOUND : JOURNEY_ROLES.TRIP;

  return journeys.map((journey, index) => ({ ...journey, role: roles[index] }));
}

/**
 * WHAT IT DOES
 *   Flags a journey that starts at a different airport from where the previous
 *   one ended, within a day.
 *
 * WHY IT IS BUILT THIS WAY
 *   That is a ground transfer — land at Heathrow, fly out of Gatwick — which is
 *   a new journey rather than a connection, but worth saying out loud because
 *   it is often where a claim gets complicated.
 */
function flagGroundTransfers(journeys) {
  journeys.forEach((journey, index) => {
    if (index === 0) return;

    const previousJourney = journeys[index - 1];
    if (!previousJourney.finalDestination.iata || !journey.origin.iata) return;
    if (previousJourney.finalDestination.iata === journey.origin.iata) return;

    const daysBetweenJourneys = wholeDaysBetween(
      previousJourney.arrivalDate,
      journey.departureDate
    );

    if (daysBetweenJourneys !== null
      && daysBetweenJourneys >= 0
      && daysBetweenJourneys <= MAX_CONNECTION_DAYS) {
      journey.flags.push(FLAGS.AIRPORT_CHANGE);
    }
  });

  return journeys;
}

// =============================================================================
// STEP 13 — Group the replacement flights
// =============================================================================

function referenceToLeg(leg, reason) {
  if (!leg) return null;

  return {
    legId: leg.id,
    flightNumber: leg.flightNumber,
    from: asPlace(leg.departureIata, leg.departureCity),
    to: asPlace(leg.arrivalIata, leg.arrivalCity),
    date: leg.departureDate,
    reason: reason || ''
  };
}

/**
 * WHAT IT DOES
 *   Works out which booked flight each replacement flight ultimately stands in
 *   for.
 *
 * WHY IT IS BUILT THIS WAY
 *   One missed flight is not always replaced by one flight. When the airline
 *   reroutes, a single leg is replaced by a WHOLE NEW ROUTING: ZRH-BEG becomes
 *   ZRH-AMS then AMS-BEG. The second of those replaced nothing on its own, so
 *   listed flat it reads as an orphan the passenger never booked — which is
 *   exactly how JU0261 looked before this existed.
 *
 *   Two moves, repeated to a fixed point:
 *     SEED   — a flight that directly replaced a booked flight starts a group.
 *     SPREAD — a flight joins that group when it carries on from where a flight
 *              already in the group left the passenger.
 *
 *   The `while (somethingChanged)` loop is not laziness: a rerouting can be any
 *   number of legs long, and a leg part-way along it can itself be replaced, so
 *   a single pass genuinely cannot resolve it.
 */
function groupReplacementsByOriginalFlight(replacementLegs, bookedLegIds, replacements) {
  const originalLegByReplacementLegId = new Map();

  replacements.forEach((record) => {
    if (!bookedLegIds.has(record.originalLegId)) return;
    originalLegByReplacementLegId.set(record.replacementLegId, record.originalLeg);
  });

  let somethingChanged = true;
  while (somethingChanged) {
    somethingChanged = false;

    replacementLegs.forEach((leg) => {
      if (originalLegByReplacementLegId.has(leg.id)) return;

      const feederLeg = replacementLegs.find((otherLeg) => (
        originalLegByReplacementLegId.has(otherLeg.id)
        && otherLeg.id !== leg.id
        && secondFlightCouldFollowFirst(otherLeg, leg)
      ));

      if (feederLeg) {
        originalLegByReplacementLegId.set(leg.id, originalLegByReplacementLegId.get(feederLeg.id));
        somethingChanged = true;
      }
    });
  }

  return originalLegByReplacementLegId;
}

/**
 * WHAT IT DOES
 *   Builds the second list the review screen shows: the flights the passenger
 *   was moved onto, grouped by the booked flight each rerouting stands in for.
 *
 * WHY IT IS BUILT THIS WAY
 *   Every leg appears in exactly one list — the booking or this one. A leg the
 *   passenger did not fly stays where it belongs and is marked `flown: false`
 *   rather than being hidden.
 */
function buildReplacementItineraries(legs, bookedLegIds, replacements) {
  const replacementRecordByOriginalLegId = new Map(
    replacements.map((record) => [record.originalLegId, record])
  );

  const replacementLegs = legs.filter((leg) => !bookedLegIds.has(leg.id));
  if (replacementLegs.length === 0) return [];

  const originalLegByReplacementLegId = groupReplacementsByOriginalFlight(
    replacementLegs, bookedLegIds, replacements
  );

  const describeReplacementLeg = (leg) => {
    const record = leg.replacedLeg
      ? replacementRecordByOriginalLegId.get(leg.replacedLeg.id)
      : null;

    return {
      ...leg,
      flown: !leg.isSuperseded,
      insteadOf: referenceToLeg(leg.replacedLeg, record ? record.reason : '')
    };
  };

  const itineraries = [];
  const itineraryIndexByOriginalLegId = new Map();

  replacementLegs.forEach((leg) => {
    const originalLeg = originalLegByReplacementLegId.get(leg.id) || null;
    const groupKey = originalLeg ? originalLeg.id : '';

    if (!itineraryIndexByOriginalLegId.has(groupKey)) {
      const record = originalLeg ? replacementRecordByOriginalLegId.get(originalLeg.id) : null;

      itineraryIndexByOriginalLegId.set(groupKey, itineraries.length);
      itineraries.push({
        id: `replacement-itinerary-${itineraries.length + 1}`,
        insteadOf: referenceToLeg(originalLeg, record ? record.reason : ''),
        legs: []
      });
    }

    itineraries[itineraryIndexByOriginalLegId.get(groupKey)].legs.push(describeReplacementLeg(leg));
  });

  return itineraries.map((itinerary) => {
    const flownLegs = itinerary.legs.filter((leg) => leg.flown);

    return {
      ...itinerary,
      route: airportCodesAlong(flownLegs),
      places: namedPlacesAlong(flownLegs),
      // True when the rerouting needed more than one flight, which is what
      // makes it worth describing as a routing at all rather than a swap.
      isReroute: flownLegs.length > 1
    };
  });
}

// =============================================================================
// STEP 14 — Collect what is worth mentioning
// =============================================================================

/**
 * WHAT IT DOES
 *   Gathers one message per distinct problem across the whole trip.
 *
 * WHY IT IS BUILT THIS WAY
 *   Deduplicated by code, so the same problem is stated once rather than once
 *   per leg. Nothing renders these on the review screen today — each warning's
 *   job turned out to be better done in place, next to the field it concerns —
 *   but they are derived for the disruption questions and the assessment
 *   summary.
 */
function collectWarnings(journeys, replacementFlights) {
  const warnings = [];
  const seenCodes = new Set();

  const addWarning = (code, message) => {
    if (seenCodes.has(code)) return;
    seenCodes.add(code);
    warnings.push({ code, message });
  };

  const everyLeg = [...journeys.flatMap((journey) => journey.legs), ...replacementFlights];

  journeys.forEach((journey) => {
    if (journey.flags.includes(FLAGS.AIRPORT_CHANGE)) {
      addWarning(FLAGS.AIRPORT_CHANGE,
        'One part of this trip departs from a different airport than the previous flight arrived at.');
    }

    journey.connections.forEach((connection) => {
      if (connection.flags.includes(FLAGS.SPLIT_PNR_CONNECTION)) {
        addWarning(FLAGS.SPLIT_PNR_CONNECTION,
          'Some connecting flights were booked under separate booking references.');
      }
    });

    journey.replacements.forEach((record) => {
      if (record.reason === REPLACEMENT_REASONS.MISSED_CONNECTION) {
        addWarning(REPLACEMENT_REASONS.MISSED_CONNECTION,
          'It looks like a connection was missed and you were put on a later flight.');
      } else {
        addWarning(REPLACEMENT_REASONS.REBOOKED,
          'It looks like one of your flights was rebooked onto a later one.');
      }
    });
  });

  everyLeg.forEach((leg) => {
    if (leg.flags.includes(FLAGS.MISSING_DATE)) {
      addWarning(FLAGS.MISSING_DATE,
        'Some flight dates could not be read and need to be confirmed.');
    }
    if (leg.yearSource === 'current') {
      addWarning(FLAGS.ASSUMED_YEAR,
        `Your documents show the day and month but not the year, so we have used ${leg.departureDate.slice(0, 4)}. Change any date that is wrong.`);
    }
    if (leg.flags.includes(FLAGS.AMBIGUOUS_FLIGHT_NUMBER)) {
      addWarning(FLAGS.AMBIGUOUS_FLIGHT_NUMBER,
        'A flight shows more than one flight number and may need to be split.');
    }
  });

  return warnings;
}

// =============================================================================
// STEP 15 — The second entry point
// =============================================================================

/**
 * POST /api/claim-intake/itinerary
 *
 * WHAT IT DOES
 *   Takes flights the passenger typed in by hand and runs them through exactly
 *   the same engine.
 *
 * WHY IT IS BUILT THIS WAY
 *   A passenger who types their own flights still needs journeys, roles and
 *   replacement detection — the disruption questions read the same fields
 *   either way. No model, no cost: this is the deterministic engine and nothing
 *   else.
 *
 *   Because both handlers return through buildIntakeResponse, nothing from the
 *   review screen onwards can tell the two paths apart.
 */
exports.buildManualItinerary = catchAsync(async (request, response, next) => {
  const submittedLegs = Array.isArray(request.body?.legs) ? request.body.legs : [];

  const usableLegs = submittedLegs.filter((leg) =>
    asTrimmedText(leg?.departureIata)
    || asTrimmedText(leg?.arrivalIata)
    || asTrimmedText(leg?.flightNumber));

  if (usableLegs.length === 0) {
    return next(new AppError('Please add at least one flight.', 400));
  }

  response.json(buildIntakeResponse({
    documentType: 'manual',
    evidenceMode: 'manual',
    passengers: normalisePassengers(request.body?.passengers),
    bookingReferences: [],
    legs: usableLegs
  }));
});

// =============================================================================
// Exported for the test suite. The engine is pure — legs in, structure out —
// which is why it can be tested with plain `node` and no server running.
// =============================================================================

exports.buildItinerary = buildItineraryFromLegs;
exports.normalizeLeg = normaliseExtractedLeg;
exports.resolveLegDates = resolveMissingYears;
exports.FLAGS = FLAGS;
exports.JOURNEY_ROLES = JOURNEY_ROLES;
exports.REPLACEMENT_REASONS = REPLACEMENT_REASONS;
exports.MAX_CONNECTION_DAYS = MAX_CONNECTION_DAYS;
exports.REPLACEMENT_WINDOW_DAYS = REPLACEMENT_WINDOW_DAYS;
