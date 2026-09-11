'use strict';

// Run directly: node backend/tests/itineraryService.test.js
//
// The engine lives inside backend/controllers/claimIntakeController.js, laid
// out in the order a request runs through it. It is still pure — legs in,
// structure out — so it needs no server, no model and no database to test.
//
// Every case here is dates-only. There is no clock in the engine, so a flight is
// described by where it goes and on what day, and same-day order comes from the
// airports chaining plus the order the documents listed them in.

const assert = require('node:assert/strict');
const { buildItinerary, FLAGS, REPLACEMENT_REASONS } = require('../controllers/claimIntakeController');

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

  // The one connection in the booking (Lisbon-Zurich-Belgrade) was sold under a
  // single reference, so nothing here looks separately booked — with or without
  // ignorePnr. The three different locators on these passes belong to the
  // replacement flights, which are no longer compared to anything.
  assert.ok(!warnings.some((w) => w.code === FLAGS.SPLIT_PNR_CONNECTION));
  assert.equal(journeys[0].connections[0].samePnr, null, 'boarding-pass PNRs are not compared at all');
  assert.equal(buildItinerary(passes).journeys[0].connections[0].samePnr, true, 'and the booking is one reference');
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

console.log('itineraryService: all assertions passed');
