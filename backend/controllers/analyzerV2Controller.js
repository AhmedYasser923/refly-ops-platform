'use strict';

// =============================================================================
// TICKET ANALYZER V2
// =============================================================================
//
// A specialist uploads the documents attached to a case. Out the other end
// comes the trip as it was sold, the flights the passenger did not take, and
// the flights they were moved onto instead.
//
// Everything lives in this one file, laid out in the order it actually runs
// when documents are uploaded. Read it top to bottom and you are following the
// request. (Function declarations hoist in JavaScript, so a function may call
// one defined further down; the order here is chosen for reading, not for the
// interpreter.)
//
// WHY THIS FILE EXISTS ALONGSIDE THE OLD ANALYZER
// -----------------------------------------------
// backend/controllers/ticketController.js still runs the ticket analyzer that
// specialists use today, and none of this touches it. That tool works, but its
// trip logic sits inside an anonymous forEach inside an Express handler, which
// is why none of it can be tested.
//
// This is the rebuild. It starts from the claim-intake engine - the same rules,
// ported verbatim and held in place by the same assertions - and the specialist
// features come back one at a time on top of a green suite. The backlog and its
// order live in orientation/analyzer-v2.md.
//
// THE RULE THIS WHOLE FILE IS BUILT ON
// ------------------------------------
// The AI model is asked ONLY what is printed on the page: flight numbers,
// dates, airports, names. Every conclusion - which flights form one journey,
// which flight replaced which, whether that was a reroute or a rebooking - is
// derived here in plain JavaScript.
//
// Why: a model's answer is not reproducible, not explainable, and wrong in a
// new way each time, so you can never fix a whole class of bug. The rules below
// are trivial in code and hopelessly fuzzy in a prompt.
//
// THERE ARE NO TIMES ANYWHERE IN THIS FILE (YET)
// ----------------------------------------------
// Printed times are the least reliable thing on a travel document. A boarding
// pass prints a boarding-gate time in a box and the scheduled departure inline;
// the model read the wrong one and turned a 20:40 flight into 09:55. Passes
// also glue the date and time together ("IB 0550 A 05MAR20:40"), so a stray
// clock landing in a date field produced "05MAR20", which parsed as the year
// 2020 and tore one connecting trip into two.
//
// So all arithmetic here is in whole days. A specialist does eventually need a
// delay figure - EC261 turns on three hours - and times will come back for
// that. When they do, they arrive as a DISPLAY-ONLY field that this engine
// never reads: not for ordering, not for chaining, not for detection. Keeping
// the clock out of the load-bearing path is what keeps that bug class dead.
//
// KEEP THE ENGINE PURE
// --------------------
// Step 5 and everything below it take plain data and return plain data. No
// `request`, no `response`, no database, no model. That is the only reason the
// test suite runs in milliseconds with `node` and nothing else. If you find
// yourself reaching for `request` down there, pass the value in instead.
//
// ORDER OF PLAY
// -------------
//   Step  1  analyzeDocuments ............. the HTTP entry point
//   Step  2  readModelJson ................ parse what the model returned
//   Step 2b  lookUpAirlinesOnline ......... ask the web about unnamed airlines
//   Step  3  normalisePassengers .......... clean the people
//   Step  4  buildAnalysisResponse ........ assemble the reply
//   Step  5  buildItineraryFromLegs ....... the deterministic engine
//   Step  6  normaliseExtractedLeg ........ clean each flight
//   Step  7  resolveMissingYears .......... "05MAR" -> a real date
//   Step  8  mergeDuplicateLegs ........... one flight listed twice
//   Step  9  sortLegsChronologically ...... put them in order
//   Step 10  detectReplacementFlights ..... which flight replaced which
//   Step 11  buildOriginalBookingChains ... the trip as it was sold
//   Step 12  finaliseJourney .............. connections, story, labels
//   Step 13  buildReplacementItineraries .. group the reroutings
//   Step 14  collectWarnings .............. things worth mentioning
//   Step 15  buildTicketRecords .......... group the legs by e-ticket
// =============================================================================

const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const logUsage = require('../utils/logUsage');
const { calculateCost } = require('../utils/pricing');
const { geminiQueue, isQuotaError } = require('../utils/geminiQueue');
const genAI = require('../utils/geminiClient');
const MODELS = require('../config/models');
const { buildTicketDocumentParts } = require('../utils/ticketDocumentParts');
const ANALYZER_V2_SCHEMA = require('../schemas/analyzerV2Schema');
const { buildAnalyzerV2Prompt, buildAirlineLookupPrompt } = require('../prompts/analyzerV2Prompt');
const { parseDateParts } = require('../utils/dateYearResolver');
const {
  isPlausibleTicketNumber,
  normalizeTicketNumber,
  airlineForTicketPrefix
} = require('../utils/barcodeTicketEnrichment');
const {
  normaliseBookingCode,
  correctFlightNumberPrefix,
  resolveAirline,
  airlinesHoldingCode,
  carrierCodeOf,
  findAirlineNamed
} = require('../utils/airlineBookingRules');
// Coordinates only, for distances - see distanceBetweenAirportsKm.
const AIRPORTS_DATA = require('../airports_data.json');

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
  ASSUMED_YEAR: 'ASSUMED_YEAR',
  // The travellers on one flight hold different booking references. Rare,
  // but real: some agents issue a PNR per person on the same segment.
  SPLIT_PASSENGER_PNR: 'SPLIT_PASSENGER_PNR'
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
// STEP 1 - The HTTP entry point
// =============================================================================

/**
 * POST /api/analyzer-v2/analyze
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
 *     400  no files          - the caller's mistake
 *     503  quota exhausted   - ours, and temporary
 *     502  unparseable JSON  - an upstream dependency misbehaved
 *     200  zero flights      - NOT an error. The upload worked; the documents
 *                              just were not tickets, so the UI can show an
 *                              empty state rather than a red toast.
 *
 *   Unlike the passenger-facing intake this DOES return cost and model name in
 *   the body. A specialist choosing how to work a case wants to see what a run
 *   costs; a passenger filing a claim does not.
 */
exports.analyzeDocuments = catchAsync(async (request, response, next) => {
  const uploadedFiles = Array.isArray(request.files) ? request.files : [];

  if (uploadedFiles.length === 0) {
    return next(new AppError('Please upload at least one document.', 400));
  }

  const modelName = MODELS.analyzerV2;
  const geminiModel = genAI.getGenerativeModel({ model: modelName });

  // NOTE: sent as written. The old analyzer collapses its prompt with
  // `.replace(/\s+/g, ' ')`, which flattens the WRONG/CORRECT examples it
  // spent tokens writing. Do not add that here.
  const extractionPrompt = buildAnalyzerV2Prompt();

  // Turns each upload into something the model can read: PDF bytes plus
  // coordinate-sorted helper text, images resized and JPEG-compressed.
  const documentParts = await buildTicketDocumentParts(uploadedFiles);

  const startedAt = Date.now();
  let modelResult;

  // One retry. A second attempt fixes a transient hiccup; a third would just
  // make the specialist wait longer for the same failure.
  for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt += 1) {
    try {
      modelResult = await geminiQueue.run(() => geminiModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: extractionPrompt }, ...documentParts] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: ANALYZER_V2_SCHEMA
        }
      }));
      break;
    } catch (modelError) {
      if (attempt === MAX_MODEL_ATTEMPTS) {
        console.error('[AnalyzerV2] Gemini failed:', modelError.message);
        if (isQuotaError(modelError)) {
          return next(new AppError(
            'The analyzer is handling a lot of requests right now. Please try again in a moment.', 503
          ));
        }
        return next(new AppError('We could not read these documents. Please try again.', 502));
      }
      console.warn(`[AnalyzerV2] Attempt ${attempt} failed (${modelError.message}) - retrying.`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  let extractedPayload;
  try {
    extractedPayload = readModelJson(modelResult.response.text());
  } catch (parseError) {
    console.error('[AnalyzerV2] Unparseable model response:', parseError.message);
    return next(new AppError('We could not read these documents. Please try again.', 502));
  }

  const cost = calculateCost(modelName, modelResult.response.usageMetadata);
  const extractedLegs = Array.isArray(extractedPayload?.legs) ? extractedPayload.legs : [];

  // Fire and forget - a logging failure must never fail a case.
  logUsage(request, {
    operationType: 'analyzer_v2',
    model: modelName,
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    costUSD: cost.costUSD,
    metadata: { fileCount: uploadedFiles.length, legCount: extractedLegs.length }
  });

  // Step 2b. Most uploads skip it: it only runs for flights whose airline
  // neither the document nor airlines_codes.json can name.
  const airlineLookup = await lookUpAirlinesOnline(extractedLegs, request);

  const processingTimeMs = Date.now() - startedAt;

  if (extractedLegs.length === 0) {
    return response.json({
      success: true,
      noFlightData: true,
      processingTimeMs,
      costUSD: cost.costUSD,
      model: modelName
    });
  }

  const documentType = DOCUMENT_TYPES.has(asTrimmedText(extractedPayload?.documentType))
    ? asTrimmedText(extractedPayload.documentType)
    : 'unknown';

  // Boarding passes are evidence of what HAPPENED, not of how the trip was
  // sold. Every airline prints its own record locator, so a perfectly normal
  // Swiss-to-Air-Serbia connection shows two different codes - comparing them
  // would manufacture a "booked separately" warning out of nothing.
  const isBoardingPassUpload = documentType === 'boarding_pass';

  // `_chronology_scratchpad` is the model's reasoning workspace. The schema
  // requires it because asking for it measurably improves the extraction, but
  // it is never copied into the reply below - the old analyzer ships it to the
  // browser inside every journey, where nothing reads it.
  response.json({
    ...buildAnalysisResponse({
      documentType,
      evidenceMode: isBoardingPassUpload ? 'boarding_passes' : 'documents',
      passengers: normalisePassengers(extractedPayload?.passengers),
      bookingReferences: normaliseBookingReferences(extractedPayload?.bookingReferences),
      legs: extractedLegs,
      options: {
        ignorePnr: isBoardingPassUpload,
        airlinesFoundOnline: airlineLookup.airlinesFoundOnline
      }
    }),
    processingTimeMs,
    costUSD: cost.costUSD + airlineLookup.costUSD,
    model: modelName
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
// STEP 2b — Ask the web about airlines the documents do not name
// =============================================================================

const AIRLINE_LOOKUP_TIMEOUT_MS = 8000;
const AIRLINE_LOOKUP_CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_AIRLINE_NAME_LENGTH = 80;

// "CODE|year" -> { name, expiresAt }, for this process only. Answers are cached
// but misses are not: a code the web could not settle is asked again next time
// rather than remembered as unknown. The year is in the key because codes get
// reassigned, so OE in 2019 and OE in 2025 are different airlines.
const airlineLookupCache = new Map();

/**
 * WHAT IT DOES
 *   For flights whose airline neither the document nor airlines_codes.json can
 *   name, asks Gemini - with Google Search switched on - which airline flew
 *   under that code. Returns { airlinesFoundOnline: { CODE: name }, costUSD }.
 *
 * WHY IT IS BUILT THIS WAY
 *   The file settles most codes on its own: OE has exactly one airline still
 *   flying, FlyOne Romania. Some it cannot: two airlines still fly under FY
 *   (Firefly in Malaysia, Northwest Regional Airlines in Australia), and some
 *   codes list only airlines that have stopped flying, because the code went
 *   to an airline the file does not have yet. For those only an outside
 *   source can choose.
 *
 *   It runs HERE, before the engine, because it is network I/O and the engine
 *   must stay pure. The answers go in as plain data (options.airlinesFoundOnline).
 *
 *   It can only ever help. There is one call for all the codes and a hard
 *   timeout, and any failure - quota, timeout, an answer that will not parse -
 *   leaves the names exactly as the file step left them. It never fails a case.
 */
async function lookUpAirlinesOnline(extractedLegs, request) {
  const airlinesFoundOnline = {};
  const unsettledCodes = codesTheFileCannotSettle(extractedLegs);

  const codesToAsk = unsettledCodes.filter((unsettled) => {
    const cached = airlineLookupCache.get(unsettled.cacheKey);
    if (!cached || cached.expiresAt < Date.now()) return true;
    airlinesFoundOnline[unsettled.code] = cached.name;
    return false;
  });
  if (codesToAsk.length === 0) return { airlinesFoundOnline, costUSD: 0 };

  const modelName = MODELS.analyzerV2;

  try {
    const lookupModel = genAI.getGenerativeModel({ model: modelName });
    const lookupResult = await withTimeout(
      geminiQueue.run(() => lookupModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: buildAirlineLookupPrompt(codesToAsk) }] }],
        // Grounding with Google Search. The SDK pinned here only has types for
        // the older `googleSearchRetrieval` tool, but it passes `tools` to the
        // API unchanged, and `googleSearch` is the one current models accept.
        tools: [{ googleSearch: {} }]
      })),
      AIRLINE_LOOKUP_TIMEOUT_MS
    );

    const answers = readAirlineLookupAnswer(lookupResult.response.text(), codesToAsk);
    codesToAsk.forEach(({ code, cacheKey }) => {
      if (!answers[code]) return;
      airlinesFoundOnline[code] = answers[code];
      airlineLookupCache.set(cacheKey, {
        name: answers[code],
        expiresAt: Date.now() + AIRLINE_LOOKUP_CACHE_MS
      });
    });

    // Google bills search grounding on top of these tokens, and pricing.js does
    // not know that fee - so this figure is an undercount.
    const cost = calculateCost(modelName, lookupResult.response.usageMetadata);
    logUsage(request, {
      operationType: 'analyzer_v2',
      model: modelName,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
      costUSD: cost.costUSD,
      metadata: { purpose: 'airline_lookup', codes: codesToAsk.map(({ code }) => code) }
    });

    return { airlinesFoundOnline, costUSD: cost.costUSD };
  } catch (lookupError) {
    console.warn('[AnalyzerV2] Airline lookup skipped:', lookupError.message);
    return { airlinesFoundOnline, costUSD: 0 };
  }
}

/**
 * WHAT IT DOES
 *   Lists the airline codes the file cannot settle, each with the flights that
 *   carry it and the airlines the file has on record for it.
 *
 * WHY IT IS BUILT THIS WAY
 *   It asks with the engine's own rules, by running every leg through
 *   normaliseExtractedLeg (Step 6) with no web answers. A flight whose airline
 *   still comes out unconfirmed is exactly one the lookup can help, so the two
 *   can never disagree. Each code is asked about once, however many flights
 *   carry it.
 */
function codesTheFileCannotSettle(extractedLegs) {
  const unsettledByCode = new Map();

  extractedLegs.forEach((extractedLeg, index) => {
    const leg = normaliseExtractedLeg(extractedLeg, index);
    const code = carrierCodeOf(leg.flightNumber);
    if (leg.airlineSource || !code) return;

    if (!unsettledByCode.has(code)) {
      const flightYear = /^\d{4}/.test(leg.departureDate) ? leg.departureDate.slice(0, 4) : '';
      unsettledByCode.set(code, {
        code,
        cacheKey: `${code}|${flightYear}`,
        flights: [],
        candidates: airlinesHoldingCode(code).map((airline) => ({
          name: airline.name,
          ceasedOperations: Boolean(airline.ceasedOperations)
        }))
      });
    }

    unsettledByCode.get(code).flights.push({
      flightNumber: leg.flightNumber,
      date: leg.departureDate,
      from: leg.departureIata,
      to: leg.arrivalIata
    });
  });

  return [...unsettledByCode.values()];
}

/**
 * WHAT IT DOES
 *   Reads the lookup's answer into { CODE: 'Airline name' }.
 *
 * WHY IT IS BUILT THIS WAY
 *   A grounded answer is free text rather than schema-bound JSON, so it is read
 *   defensively. The array is cut out of whatever surrounds it, and anything
 *   that does not answer a question we asked is dropped: a code we did not ask
 *   about, an empty or overlong name, a placeholder. A name that matches one of
 *   the file's candidates takes the file's spelling, so the same airline is
 *   never written two ways.
 */
function readAirlineLookupAnswer(rawText, askedCodes) {
  const text = String(rawText || '');
  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  if (arrayStart === -1 || arrayEnd <= arrayStart) return {};

  let entries;
  try {
    entries = JSON.parse(text.slice(arrayStart, arrayEnd + 1));
  } catch (parseError) {
    return {};
  }
  if (!Array.isArray(entries)) return {};

  const askedByCode = new Map(askedCodes.map((asked) => [asked.code, asked]));
  const answers = {};

  entries.forEach((entry) => {
    const code = asUpperCase(entry?.code).trim();
    const airlineName = asMeaningfulText(entry?.airline);
    const asked = askedByCode.get(code);
    if (!asked || !airlineName || airlineName.length > MAX_AIRLINE_NAME_LENGTH) return;

    const listedAirline = findAirlineNamed(airlineName, asked.candidates || []);
    answers[code] = listedAirline ? listedAirline.name : airlineName;
  });

  return answers;
}

/** Rejects if `promise` has not settled within `milliseconds`. */
function withTimeout(promise, milliseconds) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${milliseconds} ms`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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

// Honorifics that ride along with a printed name - "HRYTSUNYK/ADIK MR", "Mrs
// Sameena Sayed" - without being part of it.
const NAME_TITLES = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mstr', 'master', 'dr', 'prof', 'chd', 'inf', 'mme', 'mlle'
]);

/**
 * "SAYED/SAMEENA SAJJAD MRS" -> ['sayed', 'sameena', 'sajjad'].
 *
 * Lower case, accents and titles dropped, split on anything that is not a
 * letter or a digit. Documents print one person as "LAST/FIRST", "First Last"
 * or "Mr First Middle Last"; as words, those are all the same.
 */
function nameWords(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word && !NAME_TITLES.has(word));
}

/** One key per person however the name is written: its words, sorted. */
function nameKeyOf(name) {
  return nameWords(name).sort().join(' ');
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

    // The same person can come back twice, split or ordered differently -
    // "Sameena Sajjad" + "Sayed" from one document, "Sameena" + "Sajjad Sayed"
    // from another. As a set of words, that is one passenger.
    const nameKey = nameKeyOf(`${firstName} ${lastName}`);
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

    const carrier = asMeaningfulText(extractedReference?.carrier).toUpperCase()
      || (prefixed ? prefixed[1] : '');

    // Validated by the same rule as a leg's PNR, so a document id the model
    // mislabelled cannot reach this list either. The carrier is offered as a
    // possible glued prefix: "LX" + "C6A4E3" printed as one run.
    const code = asBookingCode(prefixed ? prefixed[2] : rawValue, { iataCodes: [carrier] });

    if (!code || seenCodes.has(code)) return references;
    seenCodes.add(code);

    references.push({ value: code, carrier });
    return references;
  }, []);
}

// =============================================================================
// STEP 4 - Assemble the response
// =============================================================================

/**
 * WHAT IT DOES
 *   Runs the engine and shapes the reply the results panel consumes.
 *
 * WHY IT IS BUILT THIS WAY
 *   There will be more than one way into this feature - upload documents today,
 *   type flights in by hand later - and they must produce an IDENTICAL shape,
 *   or every screen after them would need to know which was used.
 *
 *   Making them converge at a single named function is the point. Two objects
 *   that merely happen to have the same keys today will drift apart within a
 *   month.
 */
/**
 * WHAT IT DOES
 *   Hands each passenger the tickets issued to them.
 *
 * WHY IT IS BUILT THIS WAY
 *   A ticket belongs to a person, so the screen reads down the passenger list
 *   rather than across the flights. Matching is by name because that is the only
 *   identifier both sides share - the engine works from the names printed on
 *   each leg, and the passengers array is built from the same strings.
 *
 *   Tickets naming nobody we recognise are still returned, under their printed
 *   name. Dropping them would hide a real extraction problem: a ticket that
 *   matched no passenger usually means a name was read two different ways.
 */
function attachTicketsToPassengers(passengers, tickets) {
  const ticketsForEachPassenger = passengers.map(() => []);
  const unmatchedTicketsByName = new Map();

  // Ticket by ticket, so each passenger's tickets stay in the order they were
  // issued - which is what makes "reissued" on every one after the first true.
  // Every ticket goes to its owner, however many ways their name was printed.
  tickets.forEach((ticket) => {
    // The engine sees whatever the leg printed, which may be "CIRIC/JOVANA",
    // "Jovana Ciric" or "Mr Adrian Gary Perez". Compare on the words.
    const ownerIndex = passengers.findIndex((passenger) =>
      nameMatchesPassenger(ticket.passengerName, passenger));

    if (ownerIndex !== -1) {
      ticketsForEachPassenger[ownerIndex].push(ticket);
      return;
    }

    // Someone we do not recognise, printed two ways, is still one card.
    const nameKey = nameKeyOf(ticket.passengerName);
    if (!unmatchedTicketsByName.has(nameKey)) unmatchedTicketsByName.set(nameKey, []);
    unmatchedTicketsByName.get(nameKey).push(ticket);
  });

  const withTickets = passengers.map((passenger, index) => ({
    ...passenger,
    tickets: ticketsForEachPassenger[index]
  }));

  const unmatched = [...unmatchedTicketsByName.values()].map((ticketsForName, index) => ({
    id: `passenger-unmatched-${index + 1}`,
    firstName: '',
    lastName: ticketsForName[0].passengerName,
    unmatched: true,
    tickets: ticketsForName
  }));

  return [...withTickets, ...unmatched];
}

/**
 * Do a printed name and a passenger record describe the same person?
 *
 * Compares words rather than whole strings, so order, separators and titles do
 * not matter: "CIRIC/JOVANA", "Jovana Ciric" and "Mrs Jovana Ciric" all match.
 * Every word of the surname must appear, and so must the first given name -
 * that is what keeps two members of one family apart. A middle name on either
 * side is optional.
 *
 * Word by word because a given name can be more than one word. Looked up as a
 * single word, "sameena sajjad" never matched "SAMEENA SAJJAD SAYED", and her
 * own ticket came back as a second, unknown passenger.
 */
function nameMatchesPassenger(printedName, passenger) {
  const printedWords = new Set(nameWords(printedName));
  const isPrinted = (word) => printedWords.has(word);
  const firstNameWords = nameWords(passenger.firstName);
  const lastNameWords = nameWords(passenger.lastName);

  if (lastNameWords.length === 0) {
    return firstNameWords.length > 0 && firstNameWords.every(isPrinted);
  }

  return lastNameWords.every(isPrinted)
    && (firstNameWords.length === 0 || isPrinted(firstNameWords[0]));
}

/**
 * WHAT IT DOES
 *   Gathers every leg the engine produced, from both halves of the trip.
 *
 * WHY IT IS BUILT THIS WAY
 *   Every leg lands in exactly one of the two - the booking, or a replacement
 *   group - so walking both is how you get the whole set without the engine
 *   having to return a third copy of them.
 */
function everyLegIn(journeys, replacementItineraries) {
  return [
    ...journeys.flatMap((journey) => journey.legs),
    ...replacementItineraries.flatMap((itinerary) => itinerary.legs)
  ];
}

/**
 * WHAT IT DOES
 *   Turns booking references into one record per code, listing the flights that
 *   code actually covers.
 *
 * WHY IT IS BUILT THIS WAY
 *   A reference groups flights exactly the way a ticket number does. Presented
 *   as a flat list - "LXC6A4E3, LJMEND" against a five-flight trip - it tells a
 *   specialist nothing about which code opens which booking, and hides the more
 *   important fact that two of those flights have no reference at all.
 *
 *   Built from the LEGS rather than from the model's top-level list, because the
 *   legs are where a code is actually tied to a flight. Anything the model
 *   reported but never attached to a leg is still included, with an empty
 *   flight list - that is a real signal, usually a code printed in a header we
 *   could not match, and dropping it would hide it.
 */
function buildBookingReferenceRecords(legs, extractedReferences) {
  const recordsByCode = new Map();

  legs.forEach((leg) => {
    bookingCodesOn(leg).forEach((code) => {
      if (!recordsByCode.has(code)) {
        recordsByCode.set(code, { value: code, carrier: '', flightNumbers: [], legIds: [] });
      }

      const record = recordsByCode.get(code);
      record.legIds.push(leg.id);
      if (leg.flightNumber && !record.flightNumbers.includes(leg.flightNumber)) {
        record.flightNumbers.push(leg.flightNumber);
      }
    });
  });

  extractedReferences.forEach((reference) => {
    const existing = recordsByCode.get(reference.value);

    if (existing) {
      // The top-level list is where the carrier prefix is printed ("LX/ABC123"),
      // so it fills in what the per-leg code alone cannot say.
      if (!existing.carrier) existing.carrier = reference.carrier;
      return;
    }

    // A reference that matched no leg has not been through a leg's validation,
    // so it gets the same check here. Without this, a document id rejected on
    // every single flight walks back into the list through the header.
    const validated = asBookingCode(reference.value, { iataCodes: [reference.carrier] });
    if (!validated) return;

    recordsByCode.set(validated, {
      value: validated,
      carrier: reference.carrier,
      flightNumbers: [],
      legIds: []
    });
  });

  return [...recordsByCode.values()];
}

/**
 * WHAT IT DOES
 *   Lists the flights that carry no booking reference at all.
 *
 * WHY IT IS BUILT THIS WAY
 *   Silence reads as "nothing to report", and here it means the opposite. On the
 *   Swiss upload the outbound pair genuinely has no usable reference - the code
 *   printed on those passes is an internal document id, which is rejected
 *   upstream - so a specialist looking for a record locator will not find one.
 *   Saying which flights those are is the difference between a gap they can see
 *   and a gap they discover later.
 */
function flightsWithoutBookingReference(legs) {
  return legs
    .filter((leg) => bookingCodesOn(leg).length === 0)
    .map((leg) => leg.flightNumber)
    .filter(Boolean);
}

function buildAnalysisResponse({ documentType, evidenceMode, passengers, bookingReferences, legs, options }) {
  const {
    journeys,
    replacementItineraries,
    replacementFlights,
    replacements,
    tickets,
    warnings
  } = buildItineraryFromLegs(legs, options || {});

  const allLegs = everyLegIn(journeys, replacementItineraries);

  return {
    success: true,
    documentType,
    evidenceMode,
    // Each passenger carries their own tickets - see attachTicketsToPassengers.
    passengers: attachTicketsToPassengers(passengers, tickets),
    // Each reference carries the flights it opens, and the flights it does not.
    bookingReferences: buildBookingReferenceRecords(allLegs, bookingReferences),
    flightsWithoutBookingReference: flightsWithoutBookingReference(allLegs),
    // The trip as it was sold. Flights the passenger did not end up taking stay
    // in here, marked `flown: false` - they are still part of the booking.
    booking: { journeys },
    // The flights they were moved onto instead, grouped by the booked flight
    // each rerouting stands in for. Empty when nothing went wrong.
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
      tickets: [],
      warnings: []
    };
  }

  const legs = sortLegsChronologically(
    mergeDuplicateLegs(
      resolveMissingYears(extractedLegs.map(
        (extractedLeg, index) => normaliseExtractedLeg(extractedLeg, index, options)
      ))
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
    // Built from the same normalised legs, so a ticket's legIds line up with the
    // ids used in journeys and replacements above.
    tickets: buildTicketRecords(legs),
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
 *   Returns a booking reference only if it really is one, for the airlines on
 *   this leg. Anything else comes back empty.
 *
 * WHY IT IS BUILT THIS WAY
 *   This used to accept whatever it was handed, with the shape rules living in
 *   the prompt. That made them a REQUEST rather than a guarantee: when the model
 *   did not comply, the bad value went straight to the screen. The Swiss
 *   boarding passes print "7464F99C" and "LXC6A4E3" in the corner - both
 *   internal document ids, not record locators - and both sailed through to be
 *   displayed as booking references.
 *
 *   The rules themselves live in backend/utils/airlineBookingRules.js, because
 *   they are airline reference data rather than pipeline logic, and because the
 *   old analyzer accumulated them over a long time against real documents:
 *   eight generic alphanumerics is an internal id, easyJet runs seven, TUI runs
 *   up to twelve digits, Neos is purely numeric, and so on.
 *
 *   What none of it can catch is a misread character INSIDE an otherwise valid
 *   code - "C6A4E3" read as "C64AE3" is still a well-formed locator. Nothing
 *   server-side can tell those apart; only a second reading of the same
 *   document can, which is what the barcode on the pass is for.
 *
 * @param {string} value The code as the model reported it.
 * @param {{iataCodes: string[], airlineNames: string[]}} [airlines] This leg's carriers.
 */
function asBookingCode(value, airlines = {}) {
  const code = normaliseBookingCode(value, airlines);
  return PLACEHOLDER_VALUES.has(code.toLowerCase()) ? '' : code;
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
/**
 * WHAT IT DOES
 *   Turns a printed e-ticket number into a bare 13-digit string, or nothing.
 *
 * WHY IT IS BUILT THIS WAY
 *   Two real failure modes, both seen on actual documents:
 *
 *   1. A trailing coupon suffix. A boarding pass prints "7242339474582-5".
 *      The "-5" identifies the coupon, not the ticket, so it is stripped for
 *      identity - otherwise the same ticket looks like a different one on every
 *      leg it covers.
 *
 *   2. A booking reference sitting in a ticket-number field. Kiwi.com e-tickets
 *      print "E-ticket number 1P1SJF" where 1P1SJF is the PNR. Accepting that
 *      would show a record locator in a ticket column, which is worse than
 *      showing nothing. A real ticket number is exactly 13 digits, so the
 *      length check alone rejects it; comparing against the PNR on the same row
 *      catches the case where an agent pads one to look right.
 *
 * @param {string} printedValue What the document showed.
 * @param {string} pnrOnSameRow The booking reference printed beside it.
 * @returns {string} The 13-digit number, or '' when it is not one.
 */
function asTicketNumber(printedValue, pnrOnSameRow) {
  const printed = asTrimmedText(printedValue);
  if (!printed) return '';

  // Strip a coupon suffix before anything else: "7242339474582-5".
  const withoutCouponSuffix = printed.replace(/-\s*\d{1,2}$/, '');
  const digits = normalizeTicketNumber(withoutCouponSuffix);

  if (!isPlausibleTicketNumber(digits)) return '';

  // A value that merely repeats the booking reference is not a ticket number,
  // however plausible its digits look.
  if (pnrOnSameRow && digits === asUpperCase(pnrOnSameRow)) return '';

  return digits;
}

/**
 * WHAT IT DOES
 *   Builds one record per passenger on a leg: who they are, the booking
 *   reference printed for THEM, and their own ticket number.
 *
 * WHY IT IS BUILT THIS WAY
 *   A leg used to carry a single `pnr` string and a list of names, which cannot
 *   express the case this exists for: two travellers on one flight holding
 *   different codes. A Kiwi.com itinerary does exactly that - Mr Perez on
 *   1P1SJF and Ms Perez on 1P1SJ8, same aircraft, same day.
 *
 *   The model is asked for one entry per passenger. When it gives us nothing -
 *   an older document, a thin boarding pass - we fall back to the leg-level PNR
 *   against the names we do have, so this list is never empty when the leg has
 *   passengers on it.
 */
function buildTravellerRecords(extractedLeg, passengerNames, legPnr, airlines) {
  const printedRows = Array.isArray(extractedLeg?.passengerTickets)
    ? extractedLeg.passengerTickets
    : [];

  const records = [];
  const seenNames = new Set();

  printedRows.forEach((row) => {
    const passengerName = asMeaningfulText(row?.passengerName);
    if (!passengerName) return;

    // One traveller printed two ways on the same flight - "SAYED/SAMEENA
    // SAJJAD" in the name list, "Sameena Sajjad Sayed" beside the ticket - is
    // one traveller, not two. Compared as words, like everywhere else.
    const nameKey = nameKeyOf(passengerName);
    if (seenNames.has(nameKey)) return;
    seenNames.add(nameKey);

    const pnr = asBookingCode(row?.pnr, airlines) || legPnr;

    records.push({
      passengerName,
      pnr,
      ticketNumber: asTicketNumber(row?.ticketNumber, pnr)
    });
  });

  // Anyone named on the leg but missing from the per-passenger rows still gets
  // a record, carrying whatever the leg as a whole knows.
  passengerNames.forEach((passengerName) => {
    const nameKey = nameKeyOf(passengerName);
    if (seenNames.has(nameKey)) return;
    seenNames.add(nameKey);

    records.push({ passengerName, pnr: legPnr, ticketNumber: '' });
  });

  return records;
}

/**
 * WHAT IT DOES
 *   Returns every distinct booking reference held by the travellers on a leg.
 *
 * WHY IT IS BUILT THIS WAY
 *   Connections are compared by this SET, not by a single code. Two legs where
 *   both passengers hold the same pair of references are one booking, even
 *   though no single string matches across the whole flight.
 */
function bookingCodesOn(leg) {
  const codes = leg.travellers.map((traveller) => traveller.pnr).filter(Boolean);
  if (codes.length === 0) return leg.pnr ? [leg.pnr] : [];
  return [...new Set(codes)].sort();
}

// Every airport's coordinates by IATA code, built once when the module loads.
// The FIRST entry for a code wins, because that is what the old analyzer's
// `airportsDatabase.find(...)` returns - so both tools measure from the same
// point. A Map rather than a find() per leg, since there are 10,000 airports.
const AIRPORT_COORDINATES_BY_IATA = AIRPORTS_DATA.reduce((index, airport) => {
  const code = String(airport.iata || '').toUpperCase();
  if (code && !index.has(code)) {
    index.set(code, { lat: Number(airport.lat), lon: Number(airport.lon) });
  }
  return index;
}, new Map());

/**
 * WHAT IT DOES
 *   The great-circle distance between two airports in whole kilometres, or
 *   null when either one is not in airports_data.json.
 *
 * WHY IT IS BUILT THIS WAY
 *   It is the old analyzer's formula, unchanged - haversine on a 6371 km
 *   earth, rounded to the kilometre - over the same file, so both tools print
 *   the same number for the same flight (IBZ-EMA 1566, IST-CPH 1978).
 *
 *   The file supplies coordinates and nothing else. Airport NAMES come from
 *   the model, as they do in the analyzer: the file calls East Midlands
 *   "Nottingham E. Midlands", which is not what anyone reads on a ticket.
 *
 *   Display only for now. The EC261 bands will read it when they arrive;
 *   nothing in the itinerary logic does.
 */
function distanceBetweenAirportsKm(fromIata, toIata) {
  const from = AIRPORT_COORDINATES_BY_IATA.get(fromIata);
  const to = AIRPORT_COORDINATES_BY_IATA.get(toIata);
  if (!from || !to) return null;

  const EARTH_RADIUS_KM = 6371;
  const toRadians = (degrees) => degrees * Math.PI / 180;

  const latitudeDelta = toRadians(to.lat - from.lat);
  const longitudeDelta = toRadians(to.lon - from.lon);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(from.lat)) * Math.cos(toRadians(to.lat)) * Math.sin(longitudeDelta / 2) ** 2;

  const kilometres = Math.round(
    EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
  return Number.isFinite(kilometres) ? kilometres : null;
}

function normaliseExtractedLeg(extractedLeg, index, options = {}) {
  // A date the model could not fully resolve arrives as a partial ("05MAR").
  // It is kept, never discarded — resolveMissingYears fills the year in later.
  const printedDepartureDate = asMeaningfulText(extractedLeg?.departureDate)
    || asMeaningfulText(extractedLeg?.rawExtractedDate);
  const printedArrivalDate = asMeaningfulText(extractedLeg?.arrivalDate);

  const isoDepartureDate = asIsoDateOrEmpty(extractedLeg?.departureDate);
  const isoArrivalDate = asIsoDateOrEmpty(extractedLeg?.arrivalDate);
  const printedFlightNumber = asUpperCase(extractedLeg?.flightNumber).replace(/\s+/g, '');

  // The airlines on this leg. Used for two things: choosing the right booking
  // reference rule (easyJet runs 7 characters, TUI runs 12 digits), and fixing
  // a carrier prefix OCR misread.
  const airlineNames = [
    asMeaningfulText(extractedLeg?.marketingAirline),
    asMeaningfulText(extractedLeg?.operatingAirline)
  ].filter(Boolean);

  const airlines = {
    iataCodes: [
      asUpperCase(extractedLeg?.marketingAirlineIata).replace(/[^A-Z0-9]/g, ''),
      asUpperCase(extractedLeg?.operatingAirlineIata).replace(/[^A-Z0-9]/g, ''),
      printedFlightNumber.slice(0, 2)
    ].filter(Boolean),
    airlineNames
  };

  // The airline NAME is ground truth, the glyph is not. Norse Atlantic Airways
  // is "N0" with a zero, so a scan reading "NO379" is wrong in a way we can
  // prove from airlines_codes.json and fix. Only ever corrects when the name
  // resolves to exactly one canonical code and every differing character is a
  // known OCR confusion (0/O, 1/I, 5/S, 8/B, 2/Z) - never invents one.
  const flightNumber = correctFlightNumberPrefix(printedFlightNumber, airlineNames);

  // Which airline flew it. A name on the document wins when it is an airline
  // airlines_codes.json knows and that is still flying; otherwise the flight
  // number's code decides - through the file, then the web lookup in Step 2b.
  // A charter printed only by its tour operator ("Coral Travel", OE 3053) comes
  // out as FlyOne Romania: not the tour operator, and not Laudamotion, which
  // held OE until 2020. resolveAirline has the full order.
  const airlinesFoundOnline = options.airlinesFoundOnline || {};
  const marketingAirlineFromModel = asMeaningfulText(extractedLeg?.marketingAirline);
  const operatingAirlineFromModel = asMeaningfulText(extractedLeg?.operatingAirline);

  const marketingAirline = resolveAirline({
    nameFromModel: marketingAirlineFromModel, flightNumber, airlinesFoundOnline
  });
  // A blank operating airline stays blank. It means "the same as the marketing
  // airline", and the row shows only that one.
  const operatingAirline = operatingAirlineFromModel
    ? resolveAirline({ nameFromModel: operatingAirlineFromModel, flightNumber, airlinesFoundOnline })
    : { name: '', iata: '', source: '' };

  const leg = {
    id: `leg-${index + 1}`,
    documentOrderIndex: index,

    flightNumber,
    flightNumberAsPrinted: printedFlightNumber === flightNumber ? '' : printedFlightNumber,
    marketingAirline: marketingAirline.name,
    marketingAirlineIata: marketingAirline.iata
      || asUpperCase(extractedLeg?.marketingAirlineIata).replace(/[^A-Z0-9]/g, ''),
    operatingAirline: operatingAirline.name,
    operatingAirlineIata: operatingAirline.iata
      || asUpperCase(extractedLeg?.operatingAirlineIata).replace(/[^A-Z0-9]/g, ''),
    // Where the airline's name came from - 'document', 'airline-list',
    // 'online', or '' when nothing could confirm it - and, when it was
    // replaced, what the model had said. Kept for the record; not shown.
    airlineSource: marketingAirline.source,
    airlineAsExtracted: marketingAirline.name === marketingAirlineFromModel ? '' : marketingAirlineFromModel,
    pnr: asBookingCode(extractedLeg?.pnr, airlines),

    departureIata: asAirportCode(extractedLeg?.departureIata),
    departureCity: asMeaningfulText(extractedLeg?.departureCity),
    arrivalIata: asAirportCode(extractedLeg?.arrivalIata),
    arrivalCity: asMeaningfulText(extractedLeg?.arrivalCity),

    // Display only: the route blocks print them the way the old analyzer's
    // flight card does. Nothing after this step reads them - flights are
    // matched and chained on the codes.
    departureAirportName: asMeaningfulText(extractedLeg?.departureAirportName),
    departureCountry: asMeaningfulText(extractedLeg?.departureCountry),
    arrivalAirportName: asMeaningfulText(extractedLeg?.arrivalAirportName),
    arrivalCountry: asMeaningfulText(extractedLeg?.arrivalCountry),

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

    // One record per traveller: their own booking reference and ticket number.
    // Filled in just below, once passengerNames and pnr are both settled.
    travellers: [],
    documentIndex: Number.isInteger(extractedLeg?.documentIndex) ? extractedLeg.documentIndex : 0,

    flags: []
  };

  leg.travellers = buildTravellerRecords(
    extractedLeg, leg.passengerNames, leg.pnr, airlines
  );

  // Display only, like the airport names: the route block prints it between
  // the two codes. Measured the old analyzer's way - see distanceBetweenAirportsKm.
  leg.distanceKm = distanceBetweenAirportsKm(leg.departureIata, leg.arrivalIata);

  // `leg.pnr` stays the code EVERYONE on this flight shares. When the travellers
  // genuinely hold different references there is no such code, so the field goes
  // empty rather than silently promoting one person's booking to speak for the
  // whole flight - the individual codes are in `travellers`.
  const distinctBookingCodes = [...new Set(
    leg.travellers.map((traveller) => traveller.pnr).filter(Boolean)
  )];

  leg.pnrIsSplit = distinctBookingCodes.length > 1;
  if (leg.pnrIsSplit) {
    leg.pnr = '';
    leg.flags.push(FLAGS.SPLIT_PASSENGER_PNR);
  } else if (!leg.pnr && distinctBookingCodes.length === 1) {
    leg.pnr = distinctBookingCodes[0];
  }

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
 *   A date field must never contain a colon. This is the guard.
 */
function removeClockTimeFromDate(value) {
  return String(value || '')
    .replace(/(\d{1,2})\s*:\s*(\d{2})(\s*:\s*\d{2})?/g, ' ')
    .replace(/[T\s.,;:/-]+$/i, '')
    .trim();
}

function parsePrintedDate(value) {
  const withoutClock = removeClockTimeFromDate(value);
  return parseDateParts(withoutClock) || parseDateParts(addSeparatorsToGluedDate(withoutClock));
}

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
    departureParts: parsePrintedDate(leg.departureDateRaw),
    arrivalParts: parsePrintedDate(leg.arrivalDateRaw)
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
    'pnr', 'departureCity', 'arrivalCity', 'rawExtractedDate', 'reportedStatus',
    // Display only, but a confirmation that names the airports on one copy of
    // a segment and not the other must not lose them in the merge.
    'departureAirportName', 'departureCountry', 'arrivalAirportName', 'arrivalCountry'
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
 *   `ignorePnr` is set for boarding-pass uploads — see analyzeDocuments.
 */
function describeConnection(arrivingLeg, departingLeg, ignorePnr) {
  // Compared as SETS. When each traveller holds their own reference there is no
  // single leg-level code to compare, but "both legs carry the same pair of
  // references" still means one booking. Falls back to the shared code when the
  // travellers are unknown, which is what bookingCodesOn returns for a thin leg.
  const samePnr = ignorePnr
    ? null
    : compareOptionalCodes(
      bookingCodesOn(arrivingLeg).join('+'),
      bookingCodesOn(departingLeg).join('+')
    );

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

/** A journey's first and last airport, carrying the airport's full name and
 *  its country as well as the code and city. The journey heading prints them
 *  the way the old analyzer's flight card does - "Istanbul Airport" over
 *  "Istanbul, Turkey". It is the only thing on the screen that does, so only a
 *  journey's two ends carry them; every other place stays code + city. */
function departureAirportOf(leg) {
  return {
    ...asPlace(leg.departureIata, leg.departureCity),
    airportName: leg.departureAirportName || '',
    country: leg.departureCountry || ''
  };
}

function arrivalAirportOf(leg) {
  return {
    ...asPlace(leg.arrivalIata, leg.arrivalCity),
    airportName: leg.arrivalAirportName || '',
    country: leg.arrivalCountry || ''
  };
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
    origin: departureAirportOf(firstBookedLeg),
    finalDestination: arrivalAirportOf(lastBookedLeg),
    // End to end, as the crow flies - the figure EC261 measures a journey by,
    // and what the heading's route block prints between the two codes.
    distanceKm: distanceBetweenAirportsKm(firstBookedLeg.departureIata, lastBookedLeg.arrivalIata),
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
// STEP 15 — Group the legs by e-ticket
// =============================================================================

/**
 * WHAT IT DOES
 *   Collapses the ticket number repeated across many legs into one record per
 *   actual ticket, listing the legs that ticket covers.
 *
 * WHY IT IS BUILT THIS WAY
 *   A ticket number is ONE DOCUMENT WITH SEVERAL COUPONS, not a property of a
 *   flight. On the Swiss case, ten boarding passes carry only six distinct
 *   numbers, because one ticket covers two legs for one passenger. Storing the
 *   number per leg would repeat it ten times to hold six facts, and would throw
 *   away the thing worth knowing: WHICH LEGS SHARE A TICKET.
 *
 *   That grouping is valuable because a reissue means a new ticket. On the
 *   Swiss case the boundaries land like this:
 *
 *     ticket 1  LX2087, LX1418   the trip as sold
 *     ticket 2  LX0724, JU0261   reissued after the Zurich connection was missed
 *     ticket 3  JU263            reissued again after JU0261 was missed
 *
 *   Those are exactly the two disruptions the engine derives from the timeline,
 *   arrived at independently - the airline's own record of the same events.
 *
 *   IT STAYS CORROBORATION. The timeline decides the itinerary; the ticket
 *   agrees or it does not, the same way reportedStatus does. Nothing here feeds
 *   back into replacement detection, and it must not start to: a ticket that
 *   disagrees is a question for a human, not a reason to overrule the dates.
 *
 * @param {Array} legs Normalised legs, after IDs have been assigned.
 * @returns {Array} One record per passenger per distinct ticket number.
 */
function buildTicketRecords(legs) {
  // Keyed by passenger + number: two travellers on one booking hold different
  // tickets, and the same person can hold several after a reissue.
  const ticketsByKey = new Map();

  legs.forEach((leg) => {
    leg.travellers.forEach((traveller) => {
      if (!traveller.ticketNumber) return;

      const key = `${traveller.passengerName.toLowerCase()}|${traveller.ticketNumber}`;
      const existing = ticketsByKey.get(key);

      if (existing) {
        existing.legIds.push(leg.id);
        if (leg.flightNumber) existing.flightNumbers.push(leg.flightNumber);
        return;
      }

      ticketsByKey.set(key, {
        id: `ticket-${ticketsByKey.size + 1}`,
        number: traveller.ticketNumber,
        passengerName: traveller.passengerName,
        // Carried alongside legIds so the screen can say "LX2087 · LX1418"
        // without joining back through the journeys to resolve every id.
        flightNumbers: leg.flightNumber ? [leg.flightNumber] : [],
        // Derived from the first three digits, which are the issuing airline's
        // IATA ticketing prefix - 724 is Swiss, 115 is Air Serbia. Null when the
        // prefix is unknown or shared, because a guess is worse than silence.
        issuedBy: airlineForTicketPrefix(traveller.ticketNumber),
        legIds: [leg.id]
      });
    });
  });

  return [...ticketsByKey.values()];
}

// =============================================================================
// Exports
// =============================================================================

// The engine is pure - legs in, structure out - so all of it can be driven from
// backend/tests/analyzerV2.test.js with no server and no model.
//
// `buildItinerary` deliberately keeps the name the claim-intake suite uses.
// That is what let those assertions port across unchanged, which is how we know
// this engine still agrees with the one it came from.
exports.buildItinerary = buildItineraryFromLegs;
exports.buildAnalysisResponse = buildAnalysisResponse;
exports.normalizeLeg = normaliseExtractedLeg;
exports.codesTheFileCannotSettle = codesTheFileCannotSettle;
exports.readAirlineLookupAnswer = readAirlineLookupAnswer;
exports.normalisePassengers = normalisePassengers;
exports.resolveLegDates = resolveMissingYears;
exports.FLAGS = FLAGS;
exports.JOURNEY_ROLES = JOURNEY_ROLES;
exports.REPLACEMENT_REASONS = REPLACEMENT_REASONS;
exports.MAX_CONNECTION_DAYS = MAX_CONNECTION_DAYS;
exports.REPLACEMENT_WINDOW_DAYS = REPLACEMENT_WINDOW_DAYS;
