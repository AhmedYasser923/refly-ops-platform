'use strict';

// Run directly: node backend/tests/analyzerV2.test.js
//
// These assertions are a straight port of backend/tests/itineraryService.test.js,
// which covers the claim-intake engine. Ticket Analyzer v2 was built by copying
// that engine, so running the SAME cases against the copy is what proves the
// copy did not quietly change anything. Keep them in step: if a case here has to
// be edited to pass, the two engines have diverged, and that should be a
// decision someone made on purpose rather than something you discovered.
//
// The engine lives inside backend/controllers/analyzerV2Controller.js, laid out
// in the order a request runs through it. It is pure - legs in, structure out -
// so it needs no server, no model and no database to test.
//
// Every case here is dates-only. There is no clock in the engine, so a flight is
// described by where it goes and on what day, and same-day order comes from the
// airports chaining plus the order the documents listed them in.
//
// The last block goes further and runs both engines side by side on the same
// fixtures, deep-comparing the results.

const assert = require('node:assert/strict');
const {
  buildItinerary,
  buildAnalysisResponse,
  FLAGS,
  REPLACEMENT_REASONS
} = require('../controllers/analyzerV2Controller');

function leg(overrides = {}) {
  return {
    flightNumber: 'BA568',
    marketingAirline: 'British Airways',
    marketingAirlineIata: 'BA',
    operatingAirline: 'British Airways',
    operatingAirlineIata: 'BA',
    pnr: 'ABC123',
    departureIata: 'LHR',
    departureCity: 'London',
    departureDate: '2026-08-24',
    arrivalIata: 'LYN',
    arrivalCity: 'Lyon',
    arrivalDate: '2026-08-24',
    passengerNames: ['Test Passenger'],
    documentIndex: 0,
    ...overrides
  };
}

const onward = (overrides = {}) => leg({
  flightNumber: 'BF657',
  marketingAirline: 'French Bee',
  marketingAirlineIata: 'BF',
  operatingAirline: 'French Bee',
  operatingAirlineIata: 'BF',
  departureIata: 'LYN',
  departureCity: 'Lyon',
  arrivalIata: 'BCN',
  arrivalCity: 'Barcelona',
  ...overrides
});

const flightNumbers = (legs) => legs.map((entry) => entry.flightNumber);

// --- direct flight -----------------------------------------------------------
{
  const { journeys, replacementFlights } = buildItinerary([leg()]);

  assert.equal(journeys.length, 1, 'single leg is one journey');
  assert.equal(journeys[0].isDirect, true);
  assert.equal(journeys[0].stopCount, 0);
  assert.equal(journeys[0].connections.length, 0);
  assert.equal(journeys[0].origin.iata, 'LHR');
  assert.equal(journeys[0].finalDestination.iata, 'LYN');
  assert.equal(journeys[0].legs[0].flown, true);
  assert.equal(journeys[0].story, null, 'nothing went wrong, so nothing to narrate');
  assert.deepEqual(replacementFlights, [], 'and no replacement flights');
}

// --- clean two-leg connection -------------------------------------------------
{
  const { journeys } = buildItinerary([leg(), onward()]);

  assert.equal(journeys.length, 1, 'a connection stays one journey');
  assert.equal(journeys[0].isDirect, false);
  assert.equal(journeys[0].stopCount, 1);
  assert.equal(journeys[0].connections.length, 1);
  assert.equal(journeys[0].connections[0].atIata, 'LYN');
  assert.equal(journeys[0].connections[0].daysApart, 0);
  assert.equal(journeys[0].finalDestination.iata, 'BCN');
}

// --- a connection may span one night ------------------------------------------
{
  const { journeys } = buildItinerary([
    leg(),
    onward({ departureDate: '2026-08-25', arrivalDate: '2026-08-25' })
  ]);

  assert.equal(journeys.length, 1, 'next-day onward flight is still a connection');
  assert.equal(journeys[0].connections[0].daysApart, 1);
}

// --- but not two ---------------------------------------------------------------
{
  const { journeys } = buildItinerary([
    leg(),
    onward({ departureDate: '2026-08-27', arrivalDate: '2026-08-27' })
  ]);

  assert.equal(journeys.length, 2, 'three days later is a separate trip');
}

// --- airport change ------------------------------------------------------------
{
  const { journeys } = buildItinerary([
    leg(),
    leg({
      flightNumber: 'U28321',
      departureIata: 'LYS',
      departureCity: 'Lyon Saint-Exupery',
      arrivalIata: 'BCN',
      arrivalCity: 'Barcelona'
    })
  ]);

  assert.equal(journeys.length, 2, 'a ground transfer starts a new journey');
  assert.ok(journeys[1].flags.includes(FLAGS.AIRPORT_CHANGE));
}

// --- return trip ---------------------------------------------------------------
{
  const { journeys } = buildItinerary([
    leg(),
    leg({
      flightNumber: 'BA569',
      departureIata: 'LYN',
      departureCity: 'Lyon',
      arrivalIata: 'LHR',
      arrivalCity: 'London',
      departureDate: '2026-08-31',
      arrivalDate: '2026-08-31'
    })
  ]);

  assert.equal(journeys.length, 2, 'out and back is two journeys');
  assert.deepEqual(journeys.map((entry) => entry.role), ['OUTBOUND', 'RETURN']);
}

// --- split-PNR connection ------------------------------------------------------
{
  const { journeys, warnings } = buildItinerary([leg(), onward({ pnr: 'ZZZ999' })]);

  assert.equal(journeys[0].connections[0].samePnr, false);
  assert.ok(journeys[0].connections[0].flags.includes(FLAGS.SPLIT_PNR_CONNECTION));
  assert.ok(warnings.some((w) => w.code === FLAGS.SPLIT_PNR_CONNECTION));
}

// --- out-of-order input --------------------------------------------------------
{
  const { journeys } = buildItinerary([
    onward({ departureDate: '2026-08-25', arrivalDate: '2026-08-25' }),
    leg()
  ]);

  assert.equal(journeys.length, 1, 'input order does not decide the itinerary');
  assert.deepEqual(flightNumbers(journeys[0].legs), ['BA568', 'BF657']);
}

// --- missing date: kept, flagged, sorted last -----------------------------------
{
  const { journeys, warnings } = buildItinerary([
    leg({ departureDate: '', arrivalDate: '', flightNumber: 'XX999', departureIata: 'CDG', arrivalIata: 'MAD' }),
    leg()
  ]);

  const allLegs = journeys.flatMap((journey) => journey.legs);
  assert.equal(allLegs.length, 2, 'no leg is ever dropped');
  assert.equal(allLegs[allLegs.length - 1].flightNumber, 'XX999', 'undated leg sorts last');
  assert.ok(allLegs[allLegs.length - 1].flags.includes(FLAGS.MISSING_DATE));
  assert.ok(warnings.some((w) => w.code === FLAGS.MISSING_DATE));
}

// --- missing airport ------------------------------------------------------------
{
  const { journeys } = buildItinerary([leg({ arrivalIata: '' })]);
  assert.ok(journeys[0].legs[0].flags.includes(FLAGS.MISSING_AIRPORT));
}

// --- dirty input ----------------------------------------------------------------
{
  const { journeys } = buildItinerary([
    leg({
      flightNumber: ' ba 568 ',
      pnr: 'BA/ABC123',
      departureIata: 'lhr',
      arrivalCity: 'Not Provided',
      departureDate: '2026-08-24T09:00:00'
    })
  ]);

  const [only] = journeys[0].legs;
  assert.equal(only.flightNumber, 'BA568');
  assert.equal(only.pnr, 'ABC123');
  assert.equal(only.departureIata, 'LHR');
  assert.equal(only.arrivalCity, '', 'placeholder text becomes an empty string');
  assert.equal(only.departureDate, '2026-08-24', 'a datetime yields the date alone');
}

// --- empty input -----------------------------------------------------------------
{
  const empty = buildItinerary([]);
  assert.deepEqual(empty.journeys, []);
  assert.deepEqual(empty.replacementFlights, []);
  assert.deepEqual(empty.warnings, []);
}

// --- ambiguous flight number -----------------------------------------------------
{
  const { journeys, warnings } = buildItinerary([leg({ flightNumber: 'BA494/AA7041' })]);
  assert.ok(journeys[0].legs[0].flags.includes(FLAGS.AMBIGUOUS_FLIGHT_NUMBER));
  assert.ok(warnings.some((w) => w.code === FLAGS.AMBIGUOUS_FLIGHT_NUMBER));
}

// --- the same flight listed once per passenger is still one flight ------------
{
  // Confirmations list a segment once per traveller, each block carrying that
  // passenger's own record locator. Read literally that is two flights, and two
  // flights put a phantom journey in the middle of the trip.
  const { journeys, replacementItineraries } = buildItinerary([
    leg({ flightNumber: 'FR6454', pnr: 'T71T6R', marketingAirline: 'Ryanair', departureIata: 'ALC', arrivalIata: 'MRS', departureDate: '2026-03-29', arrivalDate: '2026-03-29', passengerNames: ['Adrian Gary Perez', 'Sylwia Monika Perez'] }),
    leg({ flightNumber: 'PC1126', pnr: '1P1SJF', marketingAirline: 'Pegasus', departureIata: 'MRS', arrivalIata: 'SAW', departureDate: '2026-03-29', arrivalDate: '2026-03-29', passengerNames: ['Adrian Gary Perez'] }),
    leg({ flightNumber: 'PC1126', pnr: '1P1SJ8', marketingAirline: '', departureIata: 'MRS', arrivalIata: 'SAW', departureDate: '2026-03-29', arrivalDate: '2026-03-29', passengerNames: ['Sylwia Monika Perez'] }),
    leg({ flightNumber: 'PC751', pnr: '1P1SBG', marketingAirline: 'Pegasus', departureIata: 'SAW', arrivalIata: 'ALG', departureDate: '2026-04-06', arrivalDate: '2026-04-06', passengerNames: ['Adrian Gary Perez', 'Sylwia Monika Perez'] }),
    leg({ flightNumber: 'VY3751', pnr: 'CDBN2Y', marketingAirline: 'Vueling', departureIata: 'ALG', arrivalIata: 'ALC', departureDate: '2026-04-06', arrivalDate: '2026-04-06', passengerNames: ['Adrian Gary Perez', 'Sylwia Monika Perez'] })
  ]);

  assert.equal(journeys.length, 2, 'out and back, with no phantom trip in between');
  assert.deepEqual(journeys.map((journey) => journey.role), ['OUTBOUND', 'RETURN']);
  assert.deepEqual(flightNumbers(journeys[0].legs), ['FR6454', 'PC1126']);
  assert.deepEqual(flightNumbers(journeys[1].legs), ['PC751', 'VY3751']);
  assert.deepEqual(replacementItineraries, [], 'a duplicate is not a rebooking');

  const merged = journeys[0].legs[1];
  assert.deepEqual(
    merged.passengerNames,
    ['Adrian Gary Perez', 'Sylwia Monika Perez'],
    'both travellers end up on the one flight'
  );
  assert.equal(merged.marketingAirline, 'Pegasus', 'a value missing from one block is taken from the other');
}

// --- but two different flights on one route and day are both kept --------------
{
  const { journeys } = buildItinerary([
    leg({ flightNumber: 'BA100', departureIata: 'LHR', arrivalIata: 'JFK', departureDate: '2026-03-29', arrivalDate: '2026-03-29' }),
    leg({ flightNumber: 'BA112', departureIata: 'LHR', arrivalIata: 'JFK', departureDate: '2026-03-29', arrivalDate: '2026-03-29' })
  ]);

  const all = journeys.flatMap((journey) => journey.legs).map((entry) => entry.flightNumber);
  assert.ok(all.includes('BA100'), 'different flight numbers are never merged');
}

// =================================================================================
// Replacement detection, and the booking / replacement split
// =================================================================================

// --- the Iberia upload: same route, later flight ----------------------------------
{
  const ib = (overrides) => leg({ passengerNames: ['ESTIMA/ELIS'], arrivalDate: '', ...overrides });

  const { journeys, replacementFlights, replacements } = buildItinerary([
    ib({ flightNumber: 'IB0550', departureIata: 'OPO', arrivalIata: 'MAD', rawExtractedDate: '05MAR', departureDate: '05MAR' }),
    ib({ flightNumber: 'IB0267', departureIata: 'MAD', arrivalIata: 'GRU', rawExtractedDate: '05MAR', departureDate: '05MAR' }),
    ib({ flightNumber: 'IB0271', departureIata: 'MAD', arrivalIata: 'GRU', rawExtractedDate: '06MAR', departureDate: '06MAR' })
  ], { ignorePnr: true });

  assert.equal(journeys.length, 1, 'one connecting trip, not two direct ones');
  assert.deepEqual(flightNumbers(journeys[0].legs), ['IB0550', 'IB0267'], 'the booking is what was sold');
  assert.equal(journeys[0].legs[0].flown, true);
  assert.equal(journeys[0].legs[1].flown, false, 'IB0267 was booked but not flown');

  assert.deepEqual(flightNumbers(replacementFlights), ['IB0271']);
  assert.equal(replacementFlights[0].flown, true);
  assert.equal(replacementFlights[0].insteadOf.flightNumber, 'IB0267');

  // One flight replaced by one flight: a group of one, and no rerouting to describe.
  const [group] = journeys.length ? buildItinerary([
    ib({ flightNumber: 'IB0550', departureIata: 'OPO', arrivalIata: 'MAD', rawExtractedDate: '05MAR', departureDate: '05MAR' }),
    ib({ flightNumber: 'IB0267', departureIata: 'MAD', arrivalIata: 'GRU', rawExtractedDate: '05MAR', departureDate: '05MAR' }),
    ib({ flightNumber: 'IB0271', departureIata: 'MAD', arrivalIata: 'GRU', rawExtractedDate: '06MAR', departureDate: '06MAR' })
  ], { ignorePnr: true }).replacementItineraries : [];
  assert.equal(group.insteadOf.flightNumber, 'IB0267');
  assert.equal(group.isReroute, false, 'same route, so there is no new routing to describe');
  assert.deepEqual(flightNumbers(group.legs), ['IB0271']);

  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].reason, REPLACEMENT_REASONS.MISSED_CONNECTION);
  assert.equal(replacements[0].daysLater, 1);

  assert.equal(journeys[0].story.changedRoute, false, 'same route, so no narrative is rendered');
  assert.deepEqual(journeys[0].story.booked.route, ['OPO', 'MAD', 'GRU']);
  assert.deepEqual(journeys[0].story.flown.route, ['OPO', 'MAD', 'GRU']);
}

// --- the Swiss upload: a reroute, then a second rebooking --------------------------
{
  const names = ['CIRIC/JOVANA', 'JOVICEVIC/DUSAN'];
  const bp = (overrides) => leg({ passengerNames: names, arrivalDate: '', ...overrides });

  const passes = [
    bp({ flightNumber: 'LX2087', pnr: '7464F99C', departureIata: 'LIS', arrivalIata: 'ZRH', rawExtractedDate: '26MAR', departureDate: '26MAR' }),
    bp({ flightNumber: 'LX1418', pnr: '7464F99C', departureIata: 'ZRH', arrivalIata: 'BEG', rawExtractedDate: '26MAR', departureDate: '26MAR' }),
    bp({ flightNumber: 'LX0724', pnr: 'LXC6A4E3', departureIata: 'ZRH', arrivalIata: 'AMS', rawExtractedDate: '27MAR', departureDate: '27MAR' }),
    bp({ flightNumber: 'JU0261', pnr: 'LXC6A4E3', departureIata: 'AMS', arrivalIata: 'BEG', rawExtractedDate: '27MAR', departureDate: '27MAR' }),
    bp({ flightNumber: 'JU263', pnr: 'LJMEND', departureIata: 'AMS', arrivalIata: 'BEG', rawExtractedDate: '27MAR', departureDate: '27MAR' })
  ];

  const { journeys, replacementFlights, warnings } = buildItinerary(passes, { ignorePnr: true });

  assert.equal(journeys.length, 1, 'one trip, Lisbon to Belgrade');
  assert.deepEqual(flightNumbers(journeys[0].legs), ['LX2087', 'LX1418'], 'the booking is only what was sold');
  assert.equal(journeys[0].legs[1].flown, false);

  // JU0261 was arranged during the disruption and then also missed. It belongs
  // to neither the booking nor the flights actually taken, but it must appear.
  assert.deepEqual(flightNumbers(replacementFlights), ['LX0724', 'JU0261', 'JU263']);
  assert.equal(replacementFlights[0].insteadOf.flightNumber, 'LX1418');
  assert.equal(replacementFlights[1].flown, false, 'JU0261 was not flown either');
  assert.equal(replacementFlights[1].insteadOf, null, 'and it stands in for nothing');
  assert.equal(replacementFlights[2].insteadOf.flightNumber, 'JU0261');

  // The whole point of grouping: LX0724 and JU0261 are ONE rerouting standing in
  // for LX1418, not two unrelated flights. JU0261 replaced nothing on its own,
  // so ungrouped it reads as an orphan the passenger never booked.
  const { replacementItineraries } = buildItinerary(passes, { ignorePnr: true });
  assert.equal(replacementItineraries.length, 1, 'one missed flight, one rerouting');

  const [rerouting] = replacementItineraries;
  assert.equal(rerouting.insteadOf.flightNumber, 'LX1418');
  assert.equal(rerouting.isReroute, true);
  assert.deepEqual(rerouting.route, ['ZRH', 'AMS', 'BEG'], 'the routing actually flown');
  assert.deepEqual(flightNumbers(rerouting.legs), ['LX0724', 'JU0261', 'JU263']);
  assert.equal(rerouting.legs[1].flown, false, 'JU0261 sits inside the rerouting, not alone');
  assert.equal(rerouting.legs[2].insteadOf.flightNumber, 'JU0261', 'and JU263 replaced its sibling');

  const story = journeys[0].story;
  assert.equal(story.changedRoute, true, 'the trip changed shape, so it is worth narrating');
  assert.deepEqual(story.booked.route, ['LIS', 'ZRH', 'BEG']);
  assert.deepEqual(story.flown.route, ['LIS', 'ZRH', 'AMS', 'BEG']);
  assert.deepEqual(story.events.map((event) => event.kind), ['REROUTE', 'LATER_FLIGHT']);
  assert.deepEqual(story.outcome.addedStops, ['AMS']);
  assert.equal(story.outcome.reachedDestination, true);
  assert.equal(story.outcome.daysLate, 1);

  // Nothing here looks separately booked, with or without ignorePnr.
  //
  // Note what the outbound pair carries: "7464F99C" is the internal document id
  // printed in the corner of those passes, NOT a record locator. The server
  // rejects it on shape - eight characters - so both legs end up with no
  // reference at all, and there is simply nothing to compare.
  //
  // The important half of that is the second assertion: no reference must never
  // become a SPLIT booking. Absence of evidence is not evidence of a split.
  assert.ok(!warnings.some((w) => w.code === FLAGS.SPLIT_PNR_CONNECTION));
  assert.equal(journeys[0].connections[0].samePnr, null, 'boarding-pass PNRs are not compared at all');

  const compared = buildItinerary(passes).journeys[0].connections[0];
  assert.equal(compared.samePnr, null, 'a rejected document id leaves nothing to compare');
  assert.ok(
    !compared.flags.includes(FLAGS.SPLIT_PNR_CONNECTION),
    'and an unknown reference never reads as a separate booking'
  );

  // "LXC6A4E3" is ALSO an internal document id, not a locator with a carrier
  // code glued to the front. Eight generic alphanumerics is the signature, and
  // the old analyzer names this exact string as an example after a long time
  // spent on real documents. Swiss is not one of the length exceptions, so it is
  // rejected too - the only locator these passes carry is LJMEND.
  const replacementLegs = buildItinerary(passes).replacementItineraries[0].legs;
  assert.equal(replacementLegs[0].pnr, '', 'LXC6A4E3 is an internal id, not a PNR');
  assert.equal(replacementLegs[2].pnr, 'LJMEND', 'and LJMEND is a real one');
}

// --- a return that starts where a replacement landed --------------------------------
// The Swiss case above forbids a chain from starting at an airport a replacement
// delivered the passenger to. This is the case that narrowed that ban: an Air
// Canada return where the replacement landed at the BOOKED destination, so the
// return trip genuinely begins there.
{
  const ac = (flightNumber, from, to, date) => leg({
    flightNumber,
    marketingAirline: 'Air Canada', marketingAirlineIata: 'AC',
    operatingAirline: 'Air Canada', operatingAirlineIata: 'AC',
    pnr: 'A6RFKW',
    departureIata: from, arrivalIata: to, departureCity: from, arrivalCity: to,
    departureDate: date, arrivalDate: date
  });

  const { journeys, replacementItineraries } = buildItinerary([
    ac('AC813', 'LIS', 'YUL', '2026-08-13'),
    ac('AC1096', 'YUL', 'MCO', '2026-08-13'),
    ac('AC1098', 'YUL', 'MCO', '2026-08-13'),
    ac('AC1637', 'MCO', 'YUL', '2026-08-25'),
    ac('AC812', 'YUL', 'LIS', '2026-08-25')
  ]);

  assert.equal(journeys.length, 2, 'an outbound and a return');
  assert.deepEqual(flightNumbers(journeys[0].legs), ['AC813', 'AC1096'], 'the outbound as it was sold');

  // The bug this exists for: AC1637 was refused as the head of a chain because
  // AC1098, the replacement, had landed at MCO. The whole return then fell out
  // of the booking and surfaced as an orphan in the replacement list, leaving
  // the return itself reading "Direct, YUL -> LIS".
  assert.deepEqual(
    flightNumbers(journeys[1].legs), ['AC1637', 'AC812'],
    'the return keeps its first leg, though a replacement had delivered her to MCO'
  );
  assert.equal(journeys[1].isDirect, false, 'so it is a connection, not a direct flight');

  assert.equal(replacementItineraries.length, 1, 'the only rerouting is the one standing in for AC1096');
  assert.deepEqual(flightNumbers(replacementItineraries[0].legs), ['AC1098']);
  assert.equal(replacementItineraries[0].insteadOf.flightNumber, 'AC1096');
}

// --- a rebooking that reroutes: MAD->GRU becomes MAD->LIS->GRU -----------------------
{
  const p = (overrides) => leg({ passengerNames: ['SOLO/TRAVELLER'], ...overrides });

  const { journeys, replacementFlights } = buildItinerary([
    p({ flightNumber: 'IB6827', departureIata: 'MAD', arrivalIata: 'GRU', departureDate: '2026-03-05', arrivalDate: '2026-03-05' }),
    p({ flightNumber: 'TP1013', departureIata: 'MAD', arrivalIata: 'LIS', departureDate: '2026-03-06', arrivalDate: '2026-03-06' }),
    p({ flightNumber: 'TP0085', departureIata: 'LIS', arrivalIata: 'GRU', departureDate: '2026-03-06', arrivalDate: '2026-03-06' })
  ]);

  assert.deepEqual(flightNumbers(journeys[0].legs), ['IB6827']);
  assert.equal(journeys[0].legs[0].flown, false);
  assert.deepEqual(flightNumbers(replacementFlights), ['TP1013', 'TP0085']);
  assert.equal(journeys[0].story.changedRoute, true);
  assert.deepEqual(journeys[0].story.outcome.addedStops, ['LIS']);
}

// --- guard: a genuine repeat trip is not a rebooking ----------------------------------
{
  const p = (overrides) => leg({ passengerNames: ['SOLO/TRAVELLER'], ...overrides });

  const { journeys, replacementFlights } = buildItinerary([
    p({ flightNumber: 'AF1', departureIata: 'LHR', arrivalIata: 'CDG', departureDate: '2026-03-02', arrivalDate: '2026-03-02' }),
    p({ flightNumber: 'AF2', departureIata: 'CDG', arrivalIata: 'LHR', departureDate: '2026-03-03', arrivalDate: '2026-03-03' }),
    p({ flightNumber: 'AF3', departureIata: 'LHR', arrivalIata: 'CDG', departureDate: '2026-03-04', arrivalDate: '2026-03-04' })
  ]);

  assert.deepEqual(replacementFlights, [], 'coming home in between makes it two trips');
  assert.deepEqual(buildItinerary([]).replacementItineraries, []);
  assert.equal(journeys.length, 3);
}

// --- guard: more than three days apart is a different trip -----------------------------
{
  const p = (overrides) => leg({ passengerNames: ['SOLO/TRAVELLER'], ...overrides });

  const { replacementFlights } = buildItinerary([
    p({ flightNumber: 'AF1', departureIata: 'LHR', arrivalIata: 'CDG', departureDate: '2026-03-02', arrivalDate: '2026-03-02' }),
    p({ flightNumber: 'AF3', departureIata: 'LHR', arrivalIata: 'CDG', departureDate: '2026-03-09', arrivalDate: '2026-03-09' })
  ]);

  assert.deepEqual(replacementFlights, []);
}

// --- guard: another traveller's flight never replaces yours ------------------------------
{
  const { replacementFlights } = buildItinerary([
    leg({ flightNumber: 'AF1', departureIata: 'LHR', arrivalIata: 'CDG', passengerNames: ['ONE/PASSENGER'], departureDate: '2026-03-02', arrivalDate: '2026-03-02' }),
    leg({ flightNumber: 'AF3', departureIata: 'LHR', arrivalIata: 'CDG', passengerNames: ['OTHER/PERSON'], departureDate: '2026-03-03', arrivalDate: '2026-03-03' })
  ]);

  assert.deepEqual(replacementFlights, []);
}

// --- guard: the same flight printed twice is a duplicate, not a rebooking -----------------
{
  const same = { flightNumber: 'IB0267', departureIata: 'MAD', arrivalIata: 'GRU', departureDate: '2026-03-05', arrivalDate: '2026-03-05' };
  const { replacementFlights } = buildItinerary([leg(same), leg(same)]);

  assert.deepEqual(replacementFlights, [], 'two prints of one flight replace nothing');
}

// --- a cancelled flight with no replacement is left alone -----------------------------------
{
  const { journeys, replacementFlights } = buildItinerary([
    leg({ flightStatus: 'Cancelled' })
  ]);

  assert.deepEqual(replacementFlights, []);
  assert.ok(journeys[0].legs[0].flags.includes(FLAGS.REPORTED_NOT_FLOWN));
  assert.equal(journeys[0].legs[0].flown, true, 'nothing replaced it, so the timeline says nothing');
}

// --- the model agreeing with the timeline raises confidence -----------------------------------
{
  const p = (overrides) => leg({ passengerNames: ['SOLO/TRAVELLER'], departureIata: 'MAD', arrivalIata: 'GRU', ...overrides });

  const quiet = buildItinerary([
    p({ flightNumber: 'IB1', departureDate: '2026-03-05', arrivalDate: '2026-03-05' }),
    p({ flightNumber: 'IB2', departureDate: '2026-03-06', arrivalDate: '2026-03-06' })
  ]);
  assert.equal(quiet.replacements[0].confidence, 'medium', 'the timeline alone is medium');

  const corroborated = buildItinerary([
    p({ flightNumber: 'IB1', departureDate: '2026-03-05', arrivalDate: '2026-03-05', flightStatus: 'Unused / Missed Connection' }),
    p({ flightNumber: 'IB2', departureDate: '2026-03-06', arrivalDate: '2026-03-06' })
  ]);
  assert.equal(corroborated.replacements[0].confidence, 'high', 'the model agreeing raises it');
}

// =================================================================================
// Dates
// =================================================================================

// --- glued boarding-pass forms are parsed, never discarded --------------------------
{
  const { journeys } = buildItinerary([
    leg({ rawExtractedDate: '05MAR26', departureDate: '05MAR26', arrivalDate: '' })
  ]);

  const [only] = journeys[0].legs;
  assert.equal(only.departureDate, '2026-03-05', '"05MAR26" resolves to a full date');
  assert.ok(!only.flags.includes(FLAGS.MISSING_DATE));
}

// --- an hour glued to a date is never read as a year ---------------------------------
{
  // "IB 0550 A 05MAR20:40" once produced departureDate "05MAR20" -> the year
  // 2020, which tore one connecting trip into two direct ones.
  const ib = (overrides) => leg({ passengerNames: ['ESTIMA/ELIS'], ...overrides });

  const { journeys } = buildItinerary([
    ib({ flightNumber: 'IB0550', departureIata: 'OPO', arrivalIata: 'MAD', rawExtractedDate: '05MAR', departureDate: '05MAR', arrivalDate: '05MAR20' }),
    ib({ flightNumber: 'IB0267', departureIata: 'MAD', arrivalIata: 'GRU', rawExtractedDate: '05MAR', departureDate: '05MAR', arrivalDate: '05MAR23' })
  ], { ignorePnr: true });

  const thisYear = new Date().getUTCFullYear();
  assert.equal(journeys.length, 1, 'one connecting trip, not two direct ones');
  journeys[0].legs.forEach((entry) => {
    assert.equal(entry.arrivalDate.slice(0, 4), String(thisYear), 'no hour is ever read as a year');
    assert.ok(entry.arrivalDate >= entry.departureDate, 'and no flight lands before it takes off');
  });
}

// --- a wild arrival date falls back to the departure day ------------------------------
{
  const [journey] = buildItinerary([
    leg({ rawExtractedDate: '5 Mar 2026', departureDate: '2026-03-05', arrivalDate: '2019-03-05' })
  ]).journeys;

  assert.equal(journey.legs[0].arrivalDate, '2026-03-05', 'an unbelievable arrival is not trusted');
}

// --- a partial borrows the year from a sibling document --------------------------------
{
  const { journeys } = buildItinerary([
    leg({ rawExtractedDate: '5 Mar 2026', departureDate: '2026-03-05', arrivalDate: '' }),
    onward({ rawExtractedDate: '05 Mar', departureDate: '05 Mar', arrivalDate: '' })
  ]);

  assert.equal(journeys.length, 1);
  assert.equal(journeys[0].legs[1].departureDate, '2026-03-05', 'year propagates across documents');
  assert.ok(journeys[0].legs[1].flags.includes(FLAGS.ASSUMED_YEAR));
  assert.equal(journeys[0].legs[1].yearSource, 'sibling', 'borrowed, not assumed from today');
  assert.equal(journeys[0].legs[0].yearSource, 'document', 'the leg that printed a year says so');
}

// --- no year anywhere falls back to the current year -------------------------------------
{
  const { journeys, warnings } = buildItinerary([
    leg({ rawExtractedDate: '05MAR', departureDate: '05MAR', arrivalDate: '' })
  ]);

  const thisYear = new Date().getUTCFullYear();
  const [shown] = journeys[0].legs;
  assert.equal(shown.departureDate, `${thisYear}-03-05`, 'the year falls back to the current one');
  assert.equal(shown.yearSource, 'current', 'and says so, so the passenger can correct it');
  assert.equal(shown.rawExtractedDate, '05MAR', 'the passenger still sees what was printed');
  assert.ok(!shown.flags.includes(FLAGS.MISSING_DATE), 'a filled date is not a missing one');
  assert.ok(warnings.some((w) => w.code === FLAGS.ASSUMED_YEAR), 'and the review screen says which year');
}

// --- localised month names and separators --------------------------------------------------
{
  const french = buildItinerary([leg({ rawExtractedDate: '22 mars 2026', departureDate: '22 mars 2026', arrivalDate: '' })]);
  assert.equal(french.journeys[0].legs[0].departureDate, '2026-03-22', 'French month name');

  const spanish = buildItinerary([leg({ rawExtractedDate: '05/mar./2026', departureDate: '05/mar./2026', arrivalDate: '' })]);
  assert.equal(spanish.journeys[0].legs[0].departureDate, '2026-03-05', 'Spanish abbreviation with separators');
}

// --- a trip across New Year stays chronological -----------------------------------------------
{
  const { journeys } = buildItinerary([
    leg({ rawExtractedDate: '28 Dec 2025', departureDate: '2025-12-28', arrivalDate: '' }),
    onward({ rawExtractedDate: '04 Jan', departureDate: '04 Jan', arrivalDate: '', departureIata: 'LYN', arrivalIata: 'BCN' })
  ]);

  const dates = journeys.flatMap((journey) => journey.legs).map((entry) => entry.departureDate);
  assert.deepEqual(dates, ['2025-12-28', '2026-01-04'], 'the year rolls forward, not backward');
}

// =================================================================================
// Journey roles
// =================================================================================
{
  const hop = (overrides) => leg({ ...overrides });
  const roles = (legs) => buildItinerary(legs).journeys.map((journey) => journey.role);

  assert.deepEqual(
    roles([
      hop({ flightNumber: 'BA1', departureIata: 'LHR', arrivalIata: 'BCN', departureDate: '2026-03-05', arrivalDate: '2026-03-05' }),
      hop({ flightNumber: 'BA2', departureIata: 'BCN', arrivalIata: 'LHR', departureDate: '2026-03-12', arrivalDate: '2026-03-12' })
    ]),
    ['OUTBOUND', 'RETURN'],
    'a round trip is an outbound and a return'
  );

  assert.deepEqual(roles([hop()]), ['TRIP'], 'a lone journey has nothing to be told apart from');

  assert.deepEqual(
    roles([
      hop({ flightNumber: 'BA1', departureIata: 'LHR', arrivalIata: 'BCN', departureDate: '2026-03-05', arrivalDate: '2026-03-05' }),
      hop({ flightNumber: 'VY9', departureIata: 'MAD', arrivalIata: 'LHR', departureDate: '2026-03-12', arrivalDate: '2026-03-12' })
    ]),
    ['OUTBOUND', 'RETURN'],
    'an open jaw still comes home'
  );

  assert.deepEqual(
    roles([
      hop({ flightNumber: 'BA1', departureIata: 'LHR', arrivalIata: 'BCN', departureDate: '2026-03-05', arrivalDate: '2026-03-05' }),
      hop({ flightNumber: 'VY2', departureIata: 'BCN', arrivalIata: 'ROM', departureDate: '2026-03-09', arrivalDate: '2026-03-09' }),
      hop({ flightNumber: 'AZ3', departureIata: 'ROM', arrivalIata: 'LHR', departureDate: '2026-03-14', arrivalDate: '2026-03-14' })
    ]),
    ['OUTBOUND', 'ONWARD', 'RETURN'],
    'multi-city carries on, then comes home'
  );

  assert.deepEqual(
    roles([
      hop({ flightNumber: 'BA1', departureIata: 'LHR', arrivalIata: 'BCN', departureDate: '2026-03-05', arrivalDate: '2026-03-05' }),
      hop({ flightNumber: 'AF7', departureIata: 'CDG', arrivalIata: 'NCE', departureDate: '2026-05-05', arrivalDate: '2026-05-05' })
    ]),
    ['TRIP', 'TRIP'],
    'two unrelated trips are not an outbound and a return'
  );
}

// --- a full round trip with connections, and nothing wrong ---------------------------------
{
  const p = (overrides) => leg({ passengerNames: ['SOLO/TRAVELLER'], ...overrides });

  const { journeys, replacementFlights, warnings } = buildItinerary([
    p({ flightNumber: 'IB3717', departureIata: 'LIS', arrivalIata: 'MAD', departureDate: '2026-03-05', arrivalDate: '2026-03-05' }),
    p({ flightNumber: 'IB6027', departureIata: 'MAD', arrivalIata: 'GRU', departureDate: '2026-03-05', arrivalDate: '2026-03-05' }),
    p({ flightNumber: 'IB6028', departureIata: 'GRU', arrivalIata: 'MAD', departureDate: '2026-03-20', arrivalDate: '2026-03-21' }),
    p({ flightNumber: 'IB3712', departureIata: 'MAD', arrivalIata: 'LIS', departureDate: '2026-03-21', arrivalDate: '2026-03-21' })
  ]);

  assert.deepEqual(journeys.map((journey) => journey.role), ['OUTBOUND', 'RETURN']);
  assert.deepEqual(flightNumbers(journeys[0].legs), ['IB3717', 'IB6027']);
  assert.deepEqual(flightNumbers(journeys[1].legs), ['IB6028', 'IB3712'], 'the overnight return holds together');
  assert.deepEqual(replacementFlights, []);
  assert.deepEqual(warnings, [], 'a clean trip warns about nothing');
  journeys.forEach((journey) => assert.equal(journey.story, null));
}

// --- airline-specific booking reference rules ---------------------------------
// Carried over from the old analyzer, where they lived in the prompt as
// instructions to the model. They are enforced here instead, because a prompt
// rule is a request and this is a guarantee.
{
  const codeFor = (pnr, airlineName, iata) => buildItinerary([
    leg({ pnr, marketingAirline: airlineName, marketingAirlineIata: iata,
      operatingAirline: airlineName, operatingAirlineIata: iata })
  ]).journeys[0].legs[0].pnr;

  // The default shape: 5 to 7 alphanumerics with at least one letter.
  assert.equal(codeFor('ABC123', 'Swiss', 'LX'), 'ABC123');
  assert.equal(codeFor('LJMEND', 'Air Serbia', 'JU'), 'LJMEND');
  assert.equal(codeFor('BA/7IQHOL', 'British Airways', 'BA'), '7IQHOL', 'a carrier prefix is stripped');

  // Eight generic alphanumerics is the signature of an internal document id.
  // Both of these are printed on the real Swiss boarding passes.
  assert.equal(codeFor('7464F99C', 'Swiss', 'LX'), '', 'an internal id is not a PNR');
  assert.equal(codeFor('LXC6A4E3', 'Swiss', 'LX'), '', 'nor is this one');
  assert.equal(codeFor('123456', 'Swiss', 'LX'), '', 'a locator always has a letter');
  assert.equal(codeFor('ABCD', 'Swiss', 'LX'), '', 'four is too short');

  // Airlines whose locators genuinely break the default shape. Without these,
  // a real reference from one of these carriers is thrown away as malformed.
  assert.equal(codeFor('ABCDEFG', 'easyJet UK', 'U2'), 'ABCDEFG', 'easyJet runs 7');
  assert.equal(codeFor('12345678', 'Condor Flugdienst', 'DE'), '12345678', 'Condor runs 8 digits');
  assert.equal(codeFor('12345678', 'Arkia Israel Airlines', 'IZ'), '12345678', 'Arkia runs 8 digits');
  assert.equal(codeFor('12345678', 'Air Arabia Maroc', '3O'), '12345678', 'Air Arabia Maroc runs 8 digits');
  assert.equal(codeFor('123456789012', 'TUI Airways', 'BY'), '123456789012', 'TUI runs up to 12 digits');
  assert.equal(codeFor('123456789', 'Fly Jinnah', '9P'), '123456789', 'Fly Jinnah runs 9 digits');
  assert.equal(codeFor('ABC1234', 'Corendon Dutch Airlines', 'CD'), 'ABC1234', 'Corendon Dutch runs 7');
  assert.equal(codeFor('1234567', 'Neos', 'NO'), '1234567', 'Neos is purely numeric');
  assert.equal(codeFor('1234567', 'Sunclass Airlines', 'DK'), '1234567', 'Sunclass is purely numeric');
  assert.equal(codeFor('12345678', 'Electra Airways', ''), '12345678', 'Electra is matched by name alone');

  // The exceptions are per airline, never global. The same strings from a
  // carrier without an exception stay rejected.
  assert.equal(codeFor('12345678', 'Swiss', 'LX'), '', 'eight digits is not a Swiss locator');
  assert.equal(codeFor('123456789012', 'Swiss', 'LX'), '', 'nor is twelve');

  // A locator buried in a pseudo e-ticket string: carrier + that carrier's own
  // IATA ticketing prefix + the six-character code.
  assert.equal(
    codeFor('LH220HABMTTA4', 'Lufthansa', 'LH'), 'HABMTT',
    'LH + 220 is a real pairing, so the locator is recovered'
  );
  assert.equal(
    codeFor('LH999HABMTTA4', 'Lufthansa', 'LH'), '',
    'but 999 is not Lufthansa, so nothing is chopped off a string we cannot explain'
  );
}

// --- the airline name is ground truth, the glyph is not -----------------------
// Norse Atlantic Airways is "N0" with a ZERO. A scan reading "NO379" is wrong in
// a way that airlines_codes.json can prove, so it is corrected rather than
// carried forward into every downstream comparison.
{
  const numberFor = (flightNumber, airlineName) => buildItinerary([
    leg({ flightNumber, marketingAirline: airlineName, operatingAirline: airlineName })
  ]).journeys[0].legs[0];

  const corrected = numberFor('NO379', 'Norse Atlantic Airways');
  assert.equal(corrected.flightNumber, 'N0379', 'letter O becomes digit zero');
  assert.equal(corrected.flightNumberAsPrinted, 'NO379', 'and what the document said is kept');

  assert.equal(numberFor('ZO101', 'Norse Atlantic UK').flightNumber, 'Z0101');

  // Already correct, or nothing to correct: left exactly alone.
  const untouched = numberFor('N0379', 'Norse Atlantic Airways');
  assert.equal(untouched.flightNumber, 'N0379');
  assert.equal(untouched.flightNumberAsPrinted, '', 'no note when nothing changed');

  assert.equal(numberFor('LX2087', 'Swiss').flightNumber, 'LX2087');
  assert.equal(numberFor('BA568', 'British Airways').flightNumber, 'BA568');

  // An airline we cannot resolve is never second-guessed - inventing a carrier
  // code would be worse than carrying a misread one.
  assert.equal(numberFor('NO379', 'Some Airline We Do Not Know').flightNumber, 'NO379');

  // And a prefix that differs by something OTHER than a known OCR confusion is
  // left alone too: QQ and BA are not a glyph pair.
  assert.equal(numberFor('QQ568', 'British Airways').flightNumber, 'QQ568');

  // Two flight numbers printed in one row must still reach the ambiguity check -
  // the separator has to survive prefix correction.
  const ambiguous = numberFor('BA494/AA7041', 'British Airways');
  assert.ok(ambiguous.flags.includes(FLAGS.AMBIGUOUS_FLIGHT_NUMBER), 'the slash survives');
}

// --- per-passenger tickets: one document, several coupons ----------------------
// The real Swiss / Air Serbia upload. Ten boarding passes, but only SIX distinct
// ticket numbers, because one ticket covers two legs for one passenger.
{
  const JOVANA = 'CIRIC/JOVANA';
  const DUSAN = 'JOVICEVIC/DUSAN';

  const pass = (overrides) => leg({
    marketingAirline: 'Swiss',
    marketingAirlineIata: 'LX',
    operatingAirline: 'Swiss',
    operatingAirlineIata: 'LX',
    pnr: '',
    passengerNames: [JOVANA, DUSAN],
    ...overrides
  });

  const ticketed = (jovanaTicket, dusanTicket, pnr = '') => ([
    { passengerName: JOVANA, ticketNumber: jovanaTicket, pnr },
    { passengerName: DUSAN, ticketNumber: dusanTicket, pnr }
  ]);

  const { tickets } = buildItinerary([
    pass({
      flightNumber: 'LX2087', departureIata: 'LIS', arrivalIata: 'ZRH',
      departureDate: '2026-03-26', arrivalDate: '2026-03-26',
      passengerTickets: ticketed('7245528980584', '7245528980585')
    }),
    pass({
      flightNumber: 'LX1418', departureIata: 'ZRH', arrivalIata: 'BEG',
      departureDate: '2026-03-26', arrivalDate: '2026-03-26',
      passengerTickets: ticketed('7245528980584', '7245528980585')
    }),
    pass({
      flightNumber: 'LX0724', departureIata: 'ZRH', arrivalIata: 'AMS',
      departureDate: '2026-03-27', arrivalDate: '2026-03-27',
      passengerTickets: ticketed('7242347956916', '7242347956915', 'LXC6A4E3')
    }),
    pass({
      flightNumber: 'JU0261', departureIata: 'AMS', arrivalIata: 'BEG',
      departureDate: '2026-03-27', arrivalDate: '2026-03-27',
      passengerTickets: ticketed('7242347956916', '7242347956915', 'LXC6A4E3')
    }),
    // Printed with a coupon suffix, which is not part of the ticket's identity.
    pass({
      flightNumber: 'JU263', departureIata: 'AMS', arrivalIata: 'BEG',
      departureDate: '2026-03-27', arrivalDate: '2026-03-27',
      passengerTickets: ticketed('7242339474582-5', '7242339474581-4', 'LJMEND')
    })
  ], { ignorePnr: true });

  assert.equal(tickets.length, 6, 'ten passes collapse to six tickets');

  const jovana = tickets.filter((ticket) => ticket.passengerName === JOVANA);
  assert.equal(jovana.length, 3, 'she holds three tickets: the original and two reissues');

  assert.deepEqual(
    jovana.map((ticket) => ticket.flightNumbers),
    [['LX2087', 'LX1418'], ['LX0724', 'JU0261'], ['JU263']],
    'each ticket lists exactly the legs it covers'
  );

  assert.equal(jovana[2].number, '7242339474582', 'the coupon suffix is stripped');
  assert.equal(jovana[0].issuedBy.iata, 'LX', '724 is Swiss');
  assert.equal(jovana[0].issuedBy.name, 'Swiss');

  // Each traveller holds their own ticket - never both, never shared.
  const dusan = tickets.filter((ticket) => ticket.passengerName === DUSAN);
  assert.equal(dusan.length, 3);
  assert.equal(
    new Set(tickets.map((ticket) => ticket.number)).size, 6,
    'no ticket number is shared between the two passengers'
  );
}

// --- a booking reference in a ticket-number field is not a ticket -------------
// Kiwi.com prints "E-ticket number 1P1SJF", where 1P1SJF is the PNR. Accepting
// it would show a record locator in a ticket column.
{
  const withTicket = (ticketNumber, pnr) => buildItinerary([
    leg({ pnr, passengerTickets: [{ passengerName: 'Test Passenger', ticketNumber, pnr }] })
  ]).tickets;

  assert.deepEqual(withTicket('1P1SJF', '1P1SJF'), [], 'the PNR repeated is rejected');
  assert.deepEqual(withTicket('12345', 'ABC123'), [], 'too short is rejected');
  assert.deepEqual(withTicket('724552898058412', 'ABC123'), [], 'too long is rejected');
  assert.deepEqual(withTicket('0000000000000', 'ABC123'), [], 'all zeroes is rejected');
  assert.equal(withTicket('7245528980584', 'ABC123').length, 1, 'a real one is kept');
  assert.equal(
    withTicket('724 5528 980584', 'ABC123')[0].number, '7245528980584',
    'printed spacing is normalised away'
  );
}

// --- two travellers, different booking references, same flight ----------------
// A Kiwi.com segment really does this: Mr Perez on 1P1SJF, Ms Perez on 1P1SJ8.
{
  const ADRIAN = 'Mr. Adrian Gary Perez';
  const SYLWIA = 'Ms. Sylwia Monika Perez';

  const { journeys } = buildItinerary([
    leg({
      flightNumber: 'PC1126', departureIata: 'MRS', arrivalIata: 'SAW',
      pnr: '',
      passengerNames: [ADRIAN, SYLWIA],
      passengerTickets: [
        { passengerName: ADRIAN, ticketNumber: '', pnr: '1P1SJF' },
        { passengerName: SYLWIA, ticketNumber: '', pnr: '1P1SJ8' }
      ]
    })
  ]);

  const [only] = journeys[0].legs;

  assert.equal(only.pnrIsSplit, true);
  assert.ok(only.flags.includes(FLAGS.SPLIT_PASSENGER_PNR));
  assert.equal(only.pnr, '', 'no single code speaks for the whole flight');
  assert.deepEqual(
    only.travellers.map((traveller) => traveller.pnr),
    ['1P1SJF', '1P1SJ8'],
    'each traveller keeps their own reference'
  );
}

// --- connections compare the SET of references, not one string ----------------
// Both passengers hold their own code, but the same pair on both legs is still
// one booking - it must not read as a split-PNR connection.
{
  const perPassenger = (flightNumber, extra) => leg({
    flightNumber,
    pnr: '',
    passengerNames: ['A PASSENGER', 'B PASSENGER'],
    passengerTickets: [
      { passengerName: 'A PASSENGER', ticketNumber: '', pnr: 'AAA111' },
      { passengerName: 'B PASSENGER', ticketNumber: '', pnr: 'BBB222' }
    ],
    ...extra
  });

  const { journeys } = buildItinerary([
    perPassenger('BA568'),
    perPassenger('BF657', { departureIata: 'LYN', arrivalIata: 'BCN' })
  ]);

  assert.equal(journeys.length, 1, 'still one journey');
  assert.equal(
    journeys[0].connections[0].samePnr, true,
    'the same pair of references on both legs is one booking'
  );
  assert.ok(!journeys[0].connections[0].flags.includes(FLAGS.SPLIT_PNR_CONNECTION));
}

// --- tickets reach the response attached to the right passenger ---------------
{
  const response = buildAnalysisResponse({
    documentType: 'boarding_pass',
    evidenceMode: 'boarding_passes',
    passengers: [
      { id: 'passenger-1', firstName: 'Jovana', lastName: 'Ciric' },
      { id: 'passenger-2', firstName: 'Dusan', lastName: 'Jovicevic' }
    ],
    bookingReferences: [],
    legs: [
      leg({
        flightNumber: 'LX2087', departureIata: 'LIS', arrivalIata: 'ZRH', pnr: '',
        passengerNames: ['CIRIC/JOVANA', 'JOVICEVIC/DUSAN'],
        passengerTickets: [
          { passengerName: 'CIRIC/JOVANA', ticketNumber: '7245528980584', pnr: '' },
          { passengerName: 'JOVICEVIC/DUSAN', ticketNumber: '7245528980585', pnr: '' }
        ]
      })
    ],
    options: { ignorePnr: true }
  });

  assert.equal(response.passengers.length, 2, 'no phantom passenger appears');
  assert.equal(
    response.passengers[0].tickets[0].number, '7245528980584',
    'CIRIC/JOVANA on the document matches the Jovana Ciric record'
  );
  assert.equal(response.passengers[1].tickets[0].number, '7245528980585');
  assert.ok(
    response.passengers.every((passenger) => !passenger.unmatched),
    'every ticket found an owner'
  );
}

// --- a ticket naming nobody we know is surfaced, never silently dropped -------
{
  const response = buildAnalysisResponse({
    documentType: 'e_ticket',
    evidenceMode: 'documents',
    passengers: [{ id: 'passenger-1', firstName: 'Jovana', lastName: 'Ciric' }],
    bookingReferences: [],
    legs: [
      leg({
        pnr: '',
        passengerNames: ['SOMEONE/ELSE'],
        passengerTickets: [
          { passengerName: 'SOMEONE/ELSE', ticketNumber: '7245528980584', pnr: '' }
        ]
      })
    ],
    options: {}
  });

  const unmatched = response.passengers.filter((passenger) => passenger.unmatched);
  assert.equal(unmatched.length, 1, 'the stray ticket is shown, not swallowed');
  assert.equal(unmatched[0].tickets[0].number, '7245528980584');
}

// --- both engines, same inputs, same output -------------------------------------------------
// The strongest check in this file. Everything above proves Ticket Analyzer v2
// behaves CORRECTLY; this proves it behaves IDENTICALLY to the engine it was
// copied from, which is a different and stronger claim.
//
// When the two are deliberately allowed to diverge - times arriving for
// specialists is the first planned case - this block is what tells you exactly
// which fixtures moved, instead of leaving you to guess.
{
  const claimIntakeEngine = require('../controllers/claimIntakeController').buildItinerary;

  // THE ONE DELIBERATE DIVERGENCE SO FAR.
  //
  // v2 carries per-passenger tickets and booking references, which a passenger
  // filing their own claim has no use for. Those fields are stripped before
  // comparing, so this block still proves the TRIP LOGIC is identical - which
  // journeys, which flights replaced which, which warnings - while allowing the
  // specialist additions to exist.
  //
  // Anything NOT listed here must still match exactly. If you find yourself
  // adding a key to this list, you are changing the shared engine, and that
  // needs to be a decision rather than a way to get the suite green.
  //
  // Three divergences are about VALUES rather than keys, so no amount of
  // stripping would surface them here - the fixtures below simply do not
  // contain the inputs that trigger them. They are asserted explicitly in the
  // block after this one instead, so they are recorded as tested facts rather
  // than as something a future reader has to rediscover.
  const SPECIALIST_ONLY_FIELDS = [
    'tickets', 'travellers', 'pnrIsSplit', 'flightNumberAsPrinted',
    // Each airport's full name and country - on a leg, and on a journey's two
    // ends - and the distance, on both. Display only: the route blocks print
    // them and the engine never reads them.
    'departureAirportName', 'departureCountry', 'arrivalAirportName', 'arrivalCountry',
    'airportName', 'country', 'distanceKm',
    // Where the airline's name came from, and what the model said when it was
    // replaced. The record of a decision, not a change to the trip logic.
    'airlineSource', 'airlineAsExtracted'
  ];

  const withoutSpecialistFields = (value) => JSON.parse(JSON.stringify(
    value,
    (key, nested) => (SPECIALIST_ONLY_FIELDS.includes(key) ? undefined : nested)
  ));

  const pax = (overrides) => leg({ passengerNames: ['SOLO/TRAVELLER'], ...overrides });

  const fixtures = {
    'direct flight': [pax({})],

    'two-leg connection': [
      pax({ flightNumber: 'IB3717', departureIata: 'LIS', arrivalIata: 'MAD', departureDate: '2026-03-05', arrivalDate: '2026-03-05' }),
      pax({ flightNumber: 'IB6027', departureIata: 'MAD', arrivalIata: 'GRU', departureDate: '2026-03-05', arrivalDate: '2026-03-05' })
    ],

    'round trip': [
      pax({ flightNumber: 'IB3717', departureIata: 'LIS', arrivalIata: 'MAD', departureDate: '2026-03-05', arrivalDate: '2026-03-05' }),
      pax({ flightNumber: 'IB6027', departureIata: 'MAD', arrivalIata: 'GRU', departureDate: '2026-03-05', arrivalDate: '2026-03-05' }),
      pax({ flightNumber: 'IB6028', departureIata: 'GRU', arrivalIata: 'MAD', departureDate: '2026-03-20', arrivalDate: '2026-03-21' }),
      pax({ flightNumber: 'IB3712', departureIata: 'MAD', arrivalIata: 'LIS', departureDate: '2026-03-21', arrivalDate: '2026-03-21' })
    ],

    'a missed flight and its replacement': [
      pax({ flightNumber: 'IB0550', departureIata: 'LIS', arrivalIata: 'MAD', departureDate: '2026-03-05', arrivalDate: '2026-03-05' }),
      pax({ flightNumber: 'IB0267', departureIata: 'MAD', arrivalIata: 'ZRH', departureDate: '2026-03-05', arrivalDate: '2026-03-05' }),
      pax({ flightNumber: 'IB0271', departureIata: 'MAD', arrivalIata: 'ZRH', departureDate: '2026-03-06', arrivalDate: '2026-03-06' })
    ],

    'a reroute through a new airport': [
      pax({ flightNumber: 'LX2087', departureIata: 'LIS', arrivalIata: 'ZRH', departureDate: '2026-03-26', arrivalDate: '2026-03-26' }),
      pax({ flightNumber: 'LX1418', departureIata: 'ZRH', arrivalIata: 'BEG', departureDate: '2026-03-26', arrivalDate: '2026-03-26' }),
      pax({ flightNumber: 'LX0724', departureIata: 'ZRH', arrivalIata: 'AMS', departureDate: '2026-03-27', arrivalDate: '2026-03-27' }),
      pax({ flightNumber: 'JU0261', departureIata: 'AMS', arrivalIata: 'BEG', departureDate: '2026-03-27', arrivalDate: '2026-03-27' })
    ],

    'partial dates needing a year': [
      pax({ flightNumber: 'IB0550', departureDate: '05MAR', arrivalDate: '05MAR', rawExtractedDate: '05MAR' }),
      pax({ flightNumber: 'IB0267', departureDate: '2026-03-05', arrivalDate: '2026-03-05' })
    ],

    'the same flight listed twice': [
      pax({ flightNumber: 'IB0550', passengerNames: ['ONE/TRAVELLER'] }),
      pax({ flightNumber: 'IB0550', passengerNames: ['TWO/TRAVELLER'] })
    ],

    'a ground transfer': [
      pax({ flightNumber: 'BA568', departureIata: 'LHR', arrivalIata: 'LYN', departureDate: '2026-08-24', arrivalDate: '2026-08-24' }),
      pax({ flightNumber: 'BF657', departureIata: 'CDG', arrivalIata: 'BCN', departureDate: '2026-08-24', arrivalDate: '2026-08-24' })
    ],

    'nothing at all': []
  };

  let compared = 0;

  Object.entries(fixtures).forEach(([name, legs]) => {
    // Each engine mutates the legs it is handed, so give each its own copy.
    const forV2 = JSON.parse(JSON.stringify(legs));
    const forIntake = JSON.parse(JSON.stringify(legs));

    assert.deepEqual(
      withoutSpecialistFields(buildItinerary(forV2)),
      claimIntakeEngine(forIntake),
      `engines disagree on: ${name}`
    );
    compared += 1;
  });

  // Boarding-pass mode ignores booking references, and that option has to carry
  // across identically too - it is the switch that decides whether a two-airline
  // connection reads as one trip or as a split booking.
  const boardingPasses = [
    pax({ flightNumber: 'LX2087', departureIata: 'LIS', arrivalIata: 'ZRH', pnr: 'AAA111', departureDate: '2026-03-26', arrivalDate: '2026-03-26' }),
    pax({ flightNumber: 'JU0261', departureIata: 'ZRH', arrivalIata: 'BEG', pnr: 'BBB222', departureDate: '2026-03-26', arrivalDate: '2026-03-26' })
  ];

  [{ ignorePnr: true }, { ignorePnr: false }].forEach((options) => {
    assert.deepEqual(
      withoutSpecialistFields(
        buildItinerary(JSON.parse(JSON.stringify(boardingPasses)), options)
      ),
      claimIntakeEngine(JSON.parse(JSON.stringify(boardingPasses)), options),
      `engines disagree with ignorePnr=${options.ignorePnr}`
    );
    compared += 1;
  });

  assert.equal(compared, 11, 'every fixture was actually compared');
  console.log(`analyzerV2: ${compared} fixtures identical to the claim-intake engine`);
}

// --- booking references are grouped by the flights they open ------------------
// A flat list of codes against a five-flight trip says nothing about which one
// to quote when calling an airline, and hides the more important fact that some
// flights have no reference at all.
{
  const response = buildAnalysisResponse({
    documentType: 'boarding_pass',
    evidenceMode: 'boarding_passes',
    passengers: [],
    // As the model reported them: two internal document ids, one real locator,
    // and one that is well-formed but belongs to no flight we found.
    bookingReferences: [
      { value: '7464F99C', carrier: '' },
      { value: 'LXC6A4E3', carrier: '' },
      { value: 'LJMEND', carrier: 'JU' },
      { value: 'ZZ9988', carrier: 'BA' }
    ],
    legs: [
      leg({ flightNumber: 'LX2087', pnr: '7464F99C', marketingAirline: 'Swiss',
        marketingAirlineIata: 'LX', operatingAirline: 'Swiss', operatingAirlineIata: 'LX' }),
      leg({ flightNumber: 'JU263', pnr: 'LJMEND', marketingAirline: 'Air Serbia',
        marketingAirlineIata: 'JU', operatingAirline: 'Air Serbia', operatingAirlineIata: 'JU',
        departureIata: 'AMS', arrivalIata: 'BEG',
        departureDate: '2026-08-25', arrivalDate: '2026-08-25' })
    ],
    options: { ignorePnr: true }
  });

  const codes = response.bookingReferences.map((reference) => reference.value);
  assert.ok(codes.includes('LJMEND'), 'a real locator is kept');
  assert.ok(!codes.includes('7464F99C'), 'a document id is rejected on the leg');
  assert.ok(
    !codes.includes('LXC6A4E3'),
    'and rejected again in the header - it must not walk back in through the other door'
  );
  assert.ok(
    codes.includes('ZZ9988'),
    'but a well-formed code we could not tie to a flight is still surfaced'
  );

  const ljmend = response.bookingReferences.find((r) => r.value === 'LJMEND');
  assert.deepEqual(ljmend.flightNumbers, ['JU263'], 'each code lists the flights it opens');

  const orphan = response.bookingReferences.find((r) => r.value === 'ZZ9988');
  assert.deepEqual(orphan.flightNumbers, [], 'and an unmatched one says so by carrying none');

  // Silence would read as "nothing to report" when it means the opposite.
  assert.deepEqual(
    response.flightsWithoutBookingReference, ['LX2087'],
    'the flight whose only printed code was a document id has none'
  );
}

// --- the divergences that are about values, not keys --------------------------
// v2 applies rules the passenger tool does not have. These assertions exist so
// the difference is DOCUMENTED AND DELIBERATE: if someone later ports these
// rules into the claim-intake engine, these assertions fail and tell them to
// delete this block, rather than the difference quietly persisting or quietly
// vanishing.
//
// All are bugs in the passenger tool, not features. Worth fixing there too.
{
  const claimIntakeEngine = require('../controllers/claimIntakeController').buildItinerary;

  const swissPass = () => [leg({
    flightNumber: 'LX2087', pnr: '7464F99C',
    marketingAirline: 'Swiss', marketingAirlineIata: 'LX',
    operatingAirline: 'Swiss', operatingAirlineIata: 'LX'
  })];

  assert.equal(
    buildItinerary(swissPass()).journeys[0].legs[0].pnr, '',
    'v2 rejects an internal document id'
  );
  assert.equal(
    claimIntakeEngine(swissPass()).journeys[0].legs[0].pnr, '7464F99C',
    'the passenger tool still shows it as a booking reference - a bug there'
  );

  const norse = () => [leg({
    flightNumber: 'NO379',
    marketingAirline: 'Norse Atlantic Airways',
    operatingAirline: 'Norse Atlantic Airways'
  })];

  assert.equal(
    buildItinerary(norse()).journeys[0].legs[0].flightNumber, 'N0379',
    'v2 corrects the carrier prefix against the airline name'
  );
  assert.equal(
    claimIntakeEngine(norse()).journeys[0].legs[0].flightNumber, 'NO379',
    'the passenger tool carries the misread forward'
  );

  // A return trip that starts where a replacement landed. v2 refuses to seed a
  // chain only at an airport the booking NEVER reaches; the passenger tool
  // refuses at any airport a replacement touched, which costs it the entire
  // return of this Lisbon - Orlando trip. See buildOriginalBookingChains.
  const returnAfterReplacement = () => {
    const ac = (flightNumber, from, to, date) => leg({
      flightNumber,
      marketingAirline: 'Air Canada', marketingAirlineIata: 'AC',
      operatingAirline: 'Air Canada', operatingAirlineIata: 'AC',
      pnr: 'A6RFKW',
      departureIata: from, arrivalIata: to, departureCity: from, arrivalCity: to,
      departureDate: date, arrivalDate: date
    });

    return [
      ac('AC813', 'LIS', 'YUL', '2026-08-13'),
      ac('AC1096', 'YUL', 'MCO', '2026-08-13'),
      ac('AC1098', 'YUL', 'MCO', '2026-08-13'),
      ac('AC1637', 'MCO', 'YUL', '2026-08-25'),
      ac('AC812', 'YUL', 'LIS', '2026-08-25')
    ];
  };

  assert.deepEqual(
    flightNumbers(buildItinerary(returnAfterReplacement()).journeys[1].legs), ['AC1637', 'AC812'],
    'v2 keeps the return whole, because MCO was the booked destination'
  );
  assert.deepEqual(
    flightNumbers(claimIntakeEngine(returnAfterReplacement()).journeys[1].legs), ['AC812'],
    'the passenger tool loses the return leg to the replacement list - a bug there'
  );
}

// --- airport names and countries, for the journey heading ---------------------
// Display only: the heading prints each end's full name over "City, Country",
// the way the old analyzer's flight card does. Nothing in the engine reads them,
// so these assertions prove only that they arrive intact where the screen looks.
{
  const bucharestToHeraklion = (overrides = {}) => leg({
    flightNumber: '0E3053',
    marketingAirline: 'Coral Travel', marketingAirlineIata: '',
    operatingAirline: 'Coral Travel', operatingAirlineIata: '',
    departureIata: 'OTP', departureCity: 'Bucharest',
    departureAirportName: 'Henri Coandă International Airport', departureCountry: 'Romania',
    arrivalIata: 'HER', arrivalCity: 'Heraklion',
    arrivalAirportName: 'Heraklion International Airport', arrivalCountry: 'Greece',
    departureDate: '2025-08-21', arrivalDate: '2025-08-21',
    ...overrides
  });

  const [journey] = buildItinerary([bucharestToHeraklion()]).journeys;
  assert.deepEqual(journey.origin, {
    iata: 'OTP', city: 'Bucharest',
    airportName: 'Henri Coandă International Airport', country: 'Romania'
  }, 'the journey starts at a named airport');
  assert.deepEqual(journey.finalDestination, {
    iata: 'HER', city: 'Heraklion',
    airportName: 'Heraklion International Airport', country: 'Greece'
  }, 'and ends at one');
  assert.equal(
    journey.legs[0].arrivalAirportName, 'Heraklion International Airport',
    'the leg keeps them too'
  );

  // Placeholder junk is dropped rather than printed as an airport's name.
  const [unnamed] = buildItinerary([bucharestToHeraklion({
    departureAirportName: 'N/A', departureCountry: 'Unknown'
  })]).journeys;
  assert.equal(unnamed.origin.airportName, '', '"N/A" is not an airport name');
  assert.equal(unnamed.origin.country, '', 'nor is "Unknown" a country');

  // A journey of two flights takes its first airport from the first flight and
  // its last from the second - never the connecting airport in between.
  const [connecting] = buildItinerary([
    leg({
      departureAirportName: 'Heathrow Airport', departureCountry: 'United Kingdom',
      arrivalAirportName: 'Lyon-Saint Exupéry Airport', arrivalCountry: 'France'
    }),
    onward({
      departureAirportName: 'Lyon-Saint Exupéry Airport', departureCountry: 'France',
      arrivalAirportName: 'Josep Tarradellas Barcelona-El Prat Airport', arrivalCountry: 'Spain'
    })
  ]).journeys;
  assert.equal(connecting.stopCount, 1, 'one journey with a connection');
  assert.equal(connecting.origin.airportName, 'Heathrow Airport');
  assert.equal(connecting.finalDestination.airportName, 'Josep Tarradellas Barcelona-El Prat Airport');
  assert.equal(connecting.finalDestination.country, 'Spain');

  // One flight printed twice - a confirmation listing the segment once per
  // passenger - is one flight. When only one copy names the airports, the
  // merged flight must keep the names.
  const [merged] = buildItinerary([
    bucharestToHeraklion({
      departureAirportName: '', departureCountry: '', arrivalAirportName: '', arrivalCountry: '',
      passengerNames: ['First Passenger']
    }),
    bucharestToHeraklion({ passengerNames: ['Second Passenger'] })
  ]).journeys;
  assert.equal(merged.legs.length, 1, 'the two copies are one flight');
  assert.equal(
    merged.origin.airportName, 'Henri Coandă International Airport',
    'and the merge keeps the airport name'
  );
  assert.equal(merged.finalDestination.country, 'Greece', 'and the country');
}

// --- distance, measured the old analyzer's way --------------------------------
// The same haversine over the same airports_data.json, so both tools print the
// same number. The two figures below are read off the old analyzer's own
// screen, which is what makes them worth asserting.
{
  const flight = (departureIata, arrivalIata) =>
    buildItinerary([leg({ departureIata, arrivalIata })]).journeys[0];

  assert.equal(flight('IBZ', 'EMA').legs[0].distanceKm, 1566, 'Ibiza - East Midlands, as the analyzer shows it');
  assert.equal(flight('IST', 'CPH').legs[0].distanceKm, 1978, 'Istanbul - Copenhagen, as the analyzer shows it');
  assert.equal(flight('IST', 'CPH').distanceKm, 1978, 'a direct journey is as long as its one flight');
  assert.equal(flight('IST', 'QQQ').legs[0].distanceKm, null, 'an airport not in the data has no distance');

  // A journey is measured end to end, as the crow flies - not by adding up its
  // flights. That is the figure EC261 uses.
  const [connecting] = buildItinerary([leg(), onward()]).journeys;
  assert.equal(connecting.stopCount, 1);
  assert.equal(
    connecting.distanceKm, flight('LHR', 'BCN').distanceKm,
    'London - Lyon - Barcelona is measured London to Barcelona'
  );
}

// --- the airline, when the document does not name one we can trust -----------
// Coral Travel's charter prints only the tour operator and "OE 3053". OE was
// Laudamotion's until it stopped flying in 2020 and is FlyOne Romania's now,
// and airlines_codes.json says so. The code decides; the web is asked only
// about codes the file cannot settle.
{
  const {
    resolveAirline,
    activeAirlinesForCode,
    carrierCodeOf
  } = require('../utils/airlineBookingRules');
  const {
    codesTheFileCannotSettle,
    readAirlineLookupAnswer
  } = require('../controllers/analyzerV2Controller');

  const oe = (nameFromModel) => resolveAirline({ nameFromModel, flightNumber: 'OE3053' });

  assert.equal(carrierCodeOf('OE3053'), 'OE');
  assert.deepEqual(
    activeAirlinesForCode('OE').map((airline) => airline.name), ['FlyOne Romania'],
    'the ceased LaudaMotion is not a candidate'
  );
  assert.deepEqual(
    oe('Laudamotion'), { name: 'FlyOne Romania', iata: 'OE', source: 'airline-list', unsettledCode: '' },
    'an airline that has stopped flying gives way to the one flying the code now'
  );
  assert.equal(oe('Coral Travel').name, 'FlyOne Romania', 'a tour operator is not an airline');
  assert.equal(oe('').name, 'FlyOne Romania', 'and no name at all is filled in from the code');

  assert.deepEqual(
    resolveAirline({ nameFromModel: 'British Airways', flightNumber: 'BA568' }),
    { name: 'British Airways', iata: '', source: 'document', unsettledCode: '' },
    'a printed airline that is still flying is kept'
  );
  assert.equal(
    resolveAirline({ nameFromModel: 'Swiss', flightNumber: 'LX2087' }).name, 'Swiss',
    'including a short form of its name'
  );
  assert.equal(
    resolveAirline({ nameFromModel: 'American Airlines', flightNumber: 'BA494' }).name, 'American Airlines',
    'and one flying under another code - a codeshare - is not overruled by the flight number'
  );

  // JU is listed under Air Serbia and Jat Airways. Jat Airways is marked as
  // ceased (it stopped in 2013), so the file settles JU by itself.
  assert.deepEqual(
    resolveAirline({ nameFromModel: '', flightNumber: 'JU263' }),
    { name: 'Air Serbia', iata: 'JU', source: 'airline-list', unsettledCode: '' },
    'a code whose other airline has stopped flying is settled by the file'
  );

  // FY is still flown by two airlines, Firefly (Malaysia) and Northwest
  // Regional Airlines (Australia), so the file cannot choose between them.
  const fy = (nameFromModel, airlinesFoundOnline) =>
    resolveAirline({ nameFromModel, flightNumber: 'FY3120', airlinesFoundOnline });
  assert.deepEqual(
    fy(''), { name: '', iata: '', source: '', unsettledCode: 'FY' },
    'an ambiguous code with no name is left for the web'
  );
  assert.equal(fy('Firefly').source, 'document', 'unless the document named one of them');
  assert.deepEqual(
    fy('', { FY: 'Firefly' }), { name: 'Firefly', iata: 'FY', source: 'online', unsettledCode: '' },
    'and the web answer is used when there is one'
  );
  assert.equal(
    resolveAirline({ nameFromModel: '', flightNumber: '0B123' }).unsettledCode, '0B',
    'a code whose only airlines have all stopped flying is left for the web too'
  );

  // Step 2b asks only about what the file could not settle, once per code.
  const unsettled = codesTheFileCannotSettle([
    leg({ flightNumber: 'FY3120', marketingAirline: '', operatingAirline: '' }),
    leg({ flightNumber: 'FY3121', marketingAirline: '', operatingAirline: '' }),
    leg({ flightNumber: 'OE3053', marketingAirline: '', operatingAirline: '' }),
    leg()
  ]);
  assert.deepEqual(unsettled.map(({ code }) => code), ['FY'], 'OE and BA are settled by the file');
  assert.deepEqual(unsettled[0].flights.map(({ flightNumber }) => flightNumber), ['FY3120', 'FY3121']);
  assert.ok(
    unsettled[0].candidates.some(({ name }) => name === 'Firefly'),
    'and the file\'s candidates go with the question'
  );

  // The answer is free text, so it is read defensively.
  const asked = [
    { code: 'JU', candidates: [{ name: 'Air Serbia' }, { name: 'Jat Airways' }] },
    { code: 'VY', candidates: [] }
  ];
  assert.deepEqual(
    readAirlineLookupAnswer(
      '```json\n[{"code":"ju","airline":"air serbia"},{"code":"XX","airline":"Nobody Air"},{"code":"VY","airline":""}]\n```',
      asked
    ),
    { JU: 'Air Serbia' },
    'fenced JSON is read; an unasked code and an empty answer are dropped; the file\'s spelling wins'
  );
  assert.deepEqual(readAirlineLookupAnswer('I could not find that.', asked), {}, 'prose is not an answer');
  assert.deepEqual(readAirlineLookupAnswer('[{"code":"JU","airline":"N/A"}]', asked), {}, 'nor is a placeholder');

  // And end to end through the engine.
  const [charter] = buildItinerary([leg({
    flightNumber: 'OE3053',
    marketingAirline: 'Laudamotion', marketingAirlineIata: 'OE',
    operatingAirline: 'Laudamotion', operatingAirlineIata: 'OE',
    departureIata: 'OTP', arrivalIata: 'HER', departureDate: '2025-08-21', arrivalDate: '2025-08-21'
  })]).journeys;
  assert.equal(charter.legs[0].marketingAirline, 'FlyOne Romania');
  assert.equal(charter.legs[0].operatingAirline, 'FlyOne Romania', 'both carriers, so no false "operated by"');
  assert.equal(charter.legs[0].airlineSource, 'airline-list');
  assert.equal(charter.legs[0].airlineAsExtracted, 'Laudamotion', 'and what the model said is kept for the record');
}

// --- one person, however their name is printed --------------------------------
// A given name can be more than one word. "Sameena Sajjad" + "Sayed" never
// matched her ticket, printed "SAMEENA SAJJAD SAYED", so the ticket came back as
// a second, unknown passenger with the same name.
{
  const { normalisePassengers } = require('../controllers/analyzerV2Controller');

  const ticketResponse = (passengers, legs) => buildAnalysisResponse({
    documentType: 'e_ticket',
    evidenceMode: 'documents',
    passengers,
    bookingReferences: [],
    legs
  });
  const ticketNumbersOf = (passenger) => passenger.tickets.map((ticket) => ticket.number);

  const sameena = ticketResponse(
    [{ id: 'passenger-1', firstName: 'Sameena Sajjad', lastName: 'Sayed' }],
    [leg({
      passengerNames: ['SAMEENA SAJJAD SAYED'],
      passengerTickets: [{ passengerName: 'SAMEENA SAJJAD SAYED', ticketNumber: '7245528980584', pnr: '' }]
    })]
  );
  assert.equal(sameena.passengers.length, 1, 'one person, one card');
  assert.deepEqual(ticketNumbersOf(sameena.passengers[0]), ['7245528980584'], 'and the ticket is hers');

  const perez = ticketResponse(
    [
      { id: 'passenger-1', firstName: 'Adrian Gary', lastName: 'Perez' },
      { id: 'passenger-2', firstName: 'Sylwia Monika', lastName: 'Perez' }
    ],
    [leg({
      passengerNames: ['PEREZ/ADRIAN GARY MR', 'Sylwia Perez'],
      passengerTickets: [
        { passengerName: 'PEREZ/ADRIAN GARY MR', ticketNumber: '7245528980584', pnr: '' },
        { passengerName: 'Sylwia Perez', ticketNumber: '7245528980585', pnr: '' }
      ]
    })]
  );
  assert.equal(perez.passengers.length, 2, 'no unknown passenger');
  assert.deepEqual(
    perez.passengers.map(ticketNumbersOf), [['7245528980584'], ['7245528980585']],
    'a title and a missing middle name do not matter, and the given name keeps a family apart'
  );

  // Someone not in the list, printed two ways on two flights, is one card.
  const stranger = ticketResponse([], [
    leg({
      passengerNames: ['DOE/JANE'],
      passengerTickets: [{ passengerName: 'DOE/JANE', ticketNumber: '7245528980584', pnr: '' }]
    }),
    onward({
      passengerNames: ['Jane Doe'],
      passengerTickets: [{ passengerName: 'Jane Doe', ticketNumber: '7245528980590', pnr: '' }]
    })
  ]);
  assert.equal(stranger.passengers.length, 1, 'one unknown person, one card');
  assert.equal(stranger.passengers[0].unmatched, true);
  assert.equal(stranger.passengers[0].tickets.length, 2);

  assert.equal(
    normalisePassengers([
      { firstName: 'Sameena Sajjad', lastName: 'Sayed' },
      { firstName: 'Sameena', lastName: 'Sajjad Sayed' },
      { firstName: 'SAYED', lastName: 'SAMEENA SAJJAD' }
    ]).length,
    1,
    'one person, split or ordered three ways, is one passenger'
  );
  assert.equal(
    normalisePassengers([
      { firstName: 'Adrian Gary', lastName: 'Perez' },
      { firstName: 'Sylwia Monika', lastName: 'Perez' }
    ]).length,
    2,
    'two people who share a surname are still two'
  );
  assert.equal(
    normalisePassengers([
      { firstName: 'Jovana', lastName: 'Ćirić' },
      { firstName: 'JOVANA', lastName: 'CIRIC' }
    ]).length,
    1,
    'accents are dropped - a boarding pass prints CIRIC for Ćirić'
  );

  // The same traveller in the name list and beside the ticket, printed two
  // ways, is one traveller on the flight - not two with different codes.
  const [flight] = buildItinerary([leg({
    passengerNames: ['SAYED/SAMEENA SAJJAD'],
    passengerTickets: [{ passengerName: 'Sameena Sajjad Sayed', ticketNumber: '7245528980584', pnr: '' }]
  })]).journeys[0].legs;
  assert.equal(flight.travellers.length, 1, 'one traveller, not two');
  assert.equal(flight.pnrIsSplit, false, 'so no false "separate PNRs"');
}

// --- the airline-list card behind each airline name ---------------------------
// Step 4a. Hovering an airline's name opens what airlines_codes.json says about
// it - what the old analyzer's claim-document list shows.
{
  const { claimLimitLabel } = require('../controllers/analyzerV2Controller');
  const flightIn = (legs) => buildAnalysisResponse({
    documentType: 'e_ticket', evidenceMode: 'documents', passengers: [], bookingReferences: [], legs
  }).booking.journeys[0].legs[0];

  // "Saudi Arabian Airlines" is not a name the file has, and Saudia is the
  // only airline flying SV, so the row says Saudia and the card is Saudia's.
  const saudia = flightIn([leg({
    flightNumber: 'SV1234', marketingAirline: 'Saudi Arabian Airlines', marketingAirlineIata: 'SV',
    operatingAirline: '', operatingAirlineIata: ''
  })]);
  assert.equal(saudia.marketingAirline, 'Saudia');
  assert.deepEqual(
    saudia.marketingAirlineDetails,
    {
      name: 'Saudia', iata: 'SV', icao: 'SVA', ticketPrefix: '065',
      requiredDocuments: 'Ticket number, Passport / ID', claimNote: '',
      ticketNumberCanReplacePnr: false, oneTimeSubmission: false, ceasedOperations: false,
      country: 'Saudi Arabia', claimLimit: 'N/A'
    },
    'the card carries what the old analyzer shows, from the same file'
  );
  assert.equal(saudia.operatingAirlineDetails, null, 'no operating airline, no second card');

  // A codeshare: each name opens its own airline.
  const codeshare = flightIn([leg({
    flightNumber: 'BA7061', operatingAirline: 'Iberia Airlines', operatingAirlineIata: 'IB'
  })]);
  assert.equal(codeshare.marketingAirlineDetails.name, 'British Airways');
  assert.equal(codeshare.marketingAirlineDetails.requiredDocuments, '', 'British Airways asks for nothing extra');
  assert.equal(codeshare.marketingAirlineDetails.claimLimit, '6 years', 'and is registered in the United Kingdom');
  assert.equal(codeshare.operatingAirlineDetails.icao, 'IBE', 'Iberia is found, though BA7061 is not its code');
  assert.equal(
    codeshare.operatingAirlineDetails.claimNote,
    'can proceed without ticket number / Not without passport number'
  );

  // An airline that has stopped flying still has its entry, and it says so.
  const ceased = flightIn([leg({ flightNumber: 'VX900', marketingAirline: 'Virgin America', operatingAirline: '' })]);
  assert.equal(ceased.marketingAirlineDetails.ceasedOperations, true);

  // A name the file does not have gets no card: "No documents required", which
  // the old analyzer shows for it, would be a guess.
  const unknown = flightIn([leg({ flightNumber: '7Q123', marketingAirline: 'Coral Travel', operatingAirline: '' })]);
  assert.equal(unknown.marketingAirline, 'Coral Travel');
  assert.equal(unknown.marketingAirlineDetails, null);

  assert.equal(claimLimitLabel('Germany'), '3 years');
  assert.equal(claimLimitLabel('Malta'), 'No Limit', 'a note that is not a number of years is shown as it is');
  assert.equal(claimLimitLabel('Sweden'), '2 Months - 10 years');
  assert.equal(claimLimitLabel(''), 'N/A');
}

// --- the trackers behind each flight ------------------------------------------
// Step 4c. Every flight carries the three tracker links, built from the flight
// number the engine settled on and the search codes the airline needs.
{
  const { buildTrackerLinks } = require('../utils/flightTrackerLinks');
  const flightIn = (legs) => buildAnalysisResponse({
    documentType: 'e_ticket', evidenceMode: 'documents', passengers: [], bookingReferences: [], legs
  }).booking.journeys[0].legs[0];

  const british = flightIn([leg({ flightNumber: 'BA0568' })]);
  assert.deepEqual(
    british.trackers,
    {
      airportInfo: 'https://airportinfo.live/flight/ba0568?d=2026-08-24',
      flightStats: 'https://www.flightstats.com/v2/historical-flight/BA/568/2026/8/24',
      flightera: 'https://www.flightera.net/en/flight/BA568/Aug-2026#flight_list',
      unavailable: ''
    },
    'AirportInfo takes the number as printed, the other two without its leading zero'
  );

  // French bee does not resolve on FlightStats under BF - the file says to
  // search B2F there - and the other two keep the code.
  const frenchBee = buildTrackerLinks('BF711', '2026-03-08');
  assert.match(frenchBee.flightStats, /historical-flight\/B2F\/711\//);
  assert.match(frenchBee.airportInfo, /flight\/bf711\?/);
  assert.match(frenchBee.flightera, /flight\/BF711\//);

  // Iberojet is one of the two airlines the file overrides on all three.
  const iberojet = buildTrackerLinks('E9101', '2026-03-08');
  assert.match(iberojet.airportInfo, /flight\/eve101\?/);
  assert.match(iberojet.flightStats, /historical-flight\/EVE\/101\//);
  assert.match(iberojet.flightera, /flight\/EVE101\//);

  // A flight with no date cannot be looked up, and says so rather than
  // carrying a link to the wrong day.
  const undated = flightIn([leg({ departureDate: '', arrivalDate: '' })]);
  assert.deepEqual(
    undated.trackers,
    { airportInfo: '', flightStats: '', flightera: '', unavailable: 'NO_FULL_DATE' }
  );

  // Nor can a partial the engine kept alive, or a row that printed two flight
  // numbers, or a flight the document never numbered.
  assert.equal(buildTrackerLinks('BA568', '05MAR').unavailable, 'NO_FULL_DATE');
  assert.equal(buildTrackerLinks('BA494/AA7041', '2026-08-24').unavailable, 'FLIGHT_NUMBER_UNCLEAR');
  assert.equal(buildTrackerLinks('', '2026-08-24').unavailable, 'FLIGHT_NUMBER_UNCLEAR');
}

// --- what a distance is worth -------------------------------------------------
// Step 4d. Hovering a distance shows EC261 Article 7's amount for it - and, on
// one flight of a connection, the journey figure that is the actual claim.
{
  const { compensationFor } = require('../utils/ec261Compensation');

  // The three bands, on their boundaries.
  assert.equal(compensationFor({ distanceKm: 1500, fromCountry: 'Spain', toCountry: 'Spain' }).amount, 250);
  assert.equal(compensationFor({ distanceKm: 1501, fromCountry: 'Spain', toCountry: 'Spain' }).amount, 400);
  assert.equal(compensationFor({ distanceKm: 3500, fromCountry: 'Brazil', toCountry: 'Chile' }).amount, 400);
  assert.equal(compensationFor({ distanceKm: 3501, fromCountry: 'Brazil', toCountry: 'Chile' }).amount, 600);

  // Article 7 caps a flight that stays inside the Community: Paris to Réunion
  // is more than 9000 km and is still 400.
  const reunion = compensationFor({ distanceKm: 9346, fromCountry: 'France', toCountry: 'Reunion' });
  assert.equal(reunion.amount, 400);
  assert.equal(reunion.band, 'INTRA_EU_LONG_HAUL');
  assert.equal(reunion.intraEu, true);

  // No distance, no amount - and no distance on the screen to hover either.
  assert.equal(compensationFor({ distanceKm: null, fromCountry: 'Spain', toCountry: 'Spain' }), null);

  // Every distance the screen prints carries its own amount: each flight's,
  // and the journey's end to end.
  const iberia = (from, to, flightNumber) => leg({
    flightNumber,
    marketingAirline: 'Iberia Airlines', marketingAirlineIata: 'IB',
    operatingAirline: 'Iberia Airlines', operatingAirlineIata: 'IB',
    departureIata: from, arrivalIata: to, departureCity: from, arrivalCity: to
  });

  const connecting = buildAnalysisResponse({
    documentType: 'e_ticket', evidenceMode: 'documents', passengers: [], bookingReferences: [],
    legs: [iberia('OPO', 'MAD', 'IB0550'), iberia('MAD', 'GRU', 'IB0267')]
  }).booking.journeys[0];

  assert.equal(connecting.compensation.amount, 600, 'Porto to Sao Paulo, end to end');
  assert.equal(connecting.compensation.band, 'LONG_HAUL');
  assert.equal(connecting.legs[0].compensation.amount, 250, 'Porto to Madrid, on its own');
  assert.equal(connecting.legs[1].compensation.amount, 600, 'Madrid to Sao Paulo');
  assert.equal(connecting.legs[0].compensation.currency, 'EUR');

  const direct = buildAnalysisResponse({
    documentType: 'e_ticket', evidenceMode: 'documents', passengers: [], bookingReferences: [], legs: [leg()]
  }).booking.journeys[0];
  assert.equal(direct.compensation.amount, 250, 'London to Lyon, and both ends are in the EU');
}

// --- extraordinary circumstances, marked on the airport they hit --------------
// Step 4b reads the EOC records from the database, so it runs outside the
// engine and takes the lookup as an argument. The fake below answers the way
// eocService.findEOCEvents does: an event is recorded against an airport code
// or a country, on one day - or from its start, for an ongoing issue.
async function eocCheckAssertions() {
  const { checkAirportsForEoc, eocLookupsFor } = require('../controllers/analyzerV2Controller');

  const strikeInRome = {
    _id: 'strike', category: 'Strike', date: '2026-08-07',
    event: 'Air traffic control strike', location: 'FCO', decision: 'REJECT'
  };
  const italianAirspace = {
    _id: 'airspace', category: 'Ongoing issue', date: '2026-07-01',
    event: 'Airspace restrictions', location: 'Italy', decision: 'REJECT',
    lifecycle: { startDate: '2026-07-01', endDate: '', note: '' }
  };

  const airportsAsked = [];
  const findEvents = async ({ date, originIata, originCountry }) => {
    airportsAsked.push(`${originIata} ${date}`);
    const events = [strikeInRome, italianAirspace].filter((record) =>
      [originIata, originCountry].includes(record.location)
      && (/ongoing/i.test(record.category) ? record.date <= date : record.date === date));
    return { eocFound: events.length > 0, events };
  };

  const tripReply = (legs) => buildAnalysisResponse({
    documentType: 'e_ticket', evidenceMode: 'documents', passengers: [], bookingReferences: [], legs
  });
  const ita = {
    marketingAirline: 'ITA Airways', marketingAirlineIata: 'AZ',
    operatingAirline: 'ITA Airways', operatingAirlineIata: 'AZ'
  };

  // Toronto to Rome on the day of the strike, landing the next morning, then
  // on to Catania that day.
  const reply = tripReply([
    leg({
      ...ita, flightNumber: 'AZ651',
      departureIata: 'YYZ', departureCity: 'Toronto', departureCountry: 'Canada',
      arrivalIata: 'FCO', arrivalCity: 'Rome', arrivalCountry: 'Italy',
      departureDate: '2026-08-07', arrivalDate: '2026-08-08'
    }),
    leg({
      ...ita, flightNumber: 'AZ1731',
      departureIata: 'FCO', departureCity: 'Rome', departureCountry: 'Italy',
      arrivalIata: 'CTA', arrivalCity: 'Catania', arrivalCountry: 'Italy',
      departureDate: '2026-08-08', arrivalDate: '2026-08-08'
    })
  ]);

  assert.equal(eocLookupsFor(reply).length, 4, 'Rome is looked up twice, once for each day');
  await checkAirportsForEoc(reply, findEvents);
  assert.equal(airportsAsked.length, 4, 'and each airport and day only once');

  const [journey] = reply.booking.journeys;
  const [toRome, toCatania] = journey.legs;
  const ids = (events) => events.map((event) => event.id);

  assert.deepEqual(ids(toRome.departureEoc), [], 'nothing in Toronto');
  assert.deepEqual(ids(toRome.arrivalEoc), ['strike', 'airspace'], 'Rome, on the day of the strike');
  assert.deepEqual(ids(toCatania.departureEoc), ['airspace'], 'the next day the strike is over');
  assert.deepEqual(ids(toCatania.arrivalEoc), ['airspace'], 'an event recorded for a country marks each of its airports');
  assert.deepEqual(ids(journey.origin.eoc), [], 'the heading marks Toronto as the first flight does');
  assert.deepEqual(ids(journey.finalDestination.eoc), ['airspace'], 'and Catania as the last flight does');

  assert.deepEqual(
    toRome.arrivalEoc[1],
    {
      id: 'airspace', category: 'Ongoing issue', event: 'Airspace restrictions', location: 'Italy',
      decision: 'REJECT', ongoing: true, startDate: '2026-07-01', endDate: '', closureNote: ''
    },
    'an ongoing issue carries when it started'
  );
  assert.equal(toRome.arrivalEoc[0].startDate, '', 'a one-off event does not');

  // The records are kept by day, so a flight with no full date has nothing to
  // be matched against.
  const undated = tripReply([leg({ departureDate: '', arrivalDate: '' })]);
  assert.deepEqual(eocLookupsFor(undated), [], 'a flight with no date is not looked up');
  await checkAirportsForEoc(undated, findEvents);
  assert.deepEqual(undated.booking.journeys[0].legs[0].departureEoc, [], 'and nothing is marked');

  // If the records cannot be read, nothing is marked and the reply says so, so
  // a specialist does not take an unmarked airport for a clear one.
  const unreadable = tripReply([leg()]);
  const realConsoleError = console.error;
  console.error = () => {};
  try {
    await checkAirportsForEoc(unreadable, async () => { throw new Error('database unreachable'); });
  } finally {
    console.error = realConsoleError;
  }
  assert.deepEqual(unreadable.booking.journeys[0].legs[0].arrivalEoc, []);
  assert.ok(
    unreadable.warnings.some((warning) => warning.code === 'EOC_CHECK_FAILED'),
    'a check that could not run is a warning, not a clear result'
  );
}

eocCheckAssertions().then(() => {
  console.log('analyzerV2: all assertions passed');
});
