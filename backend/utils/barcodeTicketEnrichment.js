'use strict';

const { airlinesCodesData } = require('./dataLoader');

const TICKET_NUMBER_LENGTH = 13;
const MAX_CANDIDATES_RETURNED = 8;
const MIN_FLIGHT_YEAR = 2020;

function uniqueAirlines(rows) {
  const seen = new Set();
  const result = [];

  for (const row of rows || []) {
    if (!row) continue;
    const key = [
      row.name || '',
      row.iata || '',
      row.icao || '',
      row.country || '',
      row.ticketPrefix || '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      name: row.name || '',
      iata: row.iata && row.iata.toLowerCase() !== 'na' ? row.iata : '',
      icao: row.icao && row.icao.toLowerCase() !== 'na' ? row.icao : '',
      country: row.country || '',
      ticketPrefix: row.ticketPrefix || '',
    });
  }

  return result;
}

const airlinesByTicketPrefix = (() => {
  const map = new Map();
  for (const airline of airlinesCodesData) {
    const prefix = String(airline.ticketPrefix || '').trim();
    if (!/^\d{3}$/.test(prefix)) continue;
    if (!map.has(prefix)) map.set(prefix, []);
    map.get(prefix).push(airline);
  }
  for (const [prefix, rows] of map.entries()) {
    map.set(prefix, uniqueAirlines(rows));
  }
  return map;
})();

const airlinesByIata = (() => {
  const map = new Map();
  for (const airline of airlinesCodesData) {
    const iata = String(airline.iata || '').trim().toUpperCase();
    if (!iata || iata === 'NA') continue;
    if (!map.has(iata)) map.set(iata, []);
    map.get(iata).push(airline);
  }
  for (const [iata, rows] of map.entries()) {
    map.set(iata, uniqueAirlines(rows));
  }
  return map;
})();

function normalizeCarrier(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeTicketNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInYear(year) {
  return isLeapYear(year) ? 366 : 365;
}

function dateFromDayOfYear(year, dayOfYear) {
  const day = Number(dayOfYear);
  if (!Number.isInteger(day) || day < 1 || day > daysInYear(year)) return '';

  const date = new Date(Date.UTC(year, 0, day));
  return date.toISOString().slice(0, 10);
}

function monthDayFromDate(value) {
  const match = String(value || '').trim().match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}-${match[2]}` : '';
}

function buildDateCandidates(parsed, options = {}) {
  const julianDate = String(parsed?.julianDate || '').trim();
  if (!/^\d{3}$/.test(julianDate)) return null;

  const startYear = Number(options.startYear) || MIN_FLIGHT_YEAR;
  const currentYear = new Date().getUTCFullYear();
  const endYear = Number(options.endYear) || Math.max(currentYear, startYear);
  const visibleMonthDay = monthDayFromDate(parsed.flightDate);
  const allCandidates = [];

  for (let year = startYear; year <= endYear; year += 1) {
    const date = dateFromDayOfYear(year, julianDate);
    if (!date) continue;
    allCandidates.push({
      year,
      date,
      monthDay: date.slice(5),
    });
  }

  const filteredCandidates = visibleMonthDay
    ? allCandidates.filter(candidate => candidate.monthDay === visibleMonthDay)
    : allCandidates;
  const candidates = filteredCandidates.length > 0 ? filteredCandidates : allCandidates;

  return {
    julianDate,
    visibleMonthDay,
    rangeStart: startYear,
    rangeEnd: endYear,
    narrowedByVisibleDate: Boolean(visibleMonthDay && filteredCandidates.length > 0),
    candidates,
    possibleYears: candidates.map(candidate => candidate.year),
    allCandidates,
    warning: visibleMonthDay && filteredCandidates.length === 0
      ? `Displayed date does not match barcode day ${julianDate} for ${startYear}-${endYear}.`
      : '',
  };
}

function isPlausibleTicketNumber(value) {
  return /^\d{13}$/.test(value) &&
    !value.startsWith('000') &&
    new Set(value).size > 1;
}

function ticketPrefixKnown(value) {
  return airlinesByTicketPrefix.has(value.slice(0, 3));
}

function upsertCandidate(candidates, rawValue, source, baseScore) {
  const value = normalizeTicketNumber(rawValue);
  if (!isPlausibleTicketNumber(value)) return;

  const prefix = value.slice(0, 3);
  const issuerAirlines = airlinesByTicketPrefix.get(prefix) || [];
  const existing = candidates.get(value);

  if (existing) {
    existing.score = Math.max(existing.score, baseScore);
    if (!existing.sources.includes(source)) existing.sources.push(source);
    return;
  }

  candidates.set(value, {
    value,
    prefix,
    issuerAirlines,
    knownPrefix: issuerAirlines.length > 0,
    score: baseScore,
    sources: [source],
  });
}

function addRunWindows(candidates, run, source) {
  if (run.length === TICKET_NUMBER_LENGTH) {
    upsertCandidate(candidates, run, source, 35);
    return;
  }

  let knownWindowFound = false;
  for (let index = 0; index <= run.length - TICKET_NUMBER_LENGTH; index += 1) {
    const window = run.slice(index, index + TICKET_NUMBER_LENGTH);
    if (!ticketPrefixKnown(window)) continue;
    knownWindowFound = true;
    upsertCandidate(candidates, window, `${source}:known-prefix-window`, 42);
  }

  if (!knownWindowFound && run.length <= 16) {
    upsertCandidate(candidates, run.slice(0, TICKET_NUMBER_LENGTH), `${source}:fallback-leading-13`, 12);
  }
}

function collectTicketCandidates(result) {
  const candidates = new Map();
  const parsed = result?.parsed || {};
  const rawTexts = [
    result?.raw,
    parsed.conditionalRaw,
    parsed.raw,
  ].filter(Boolean).map(String);

  if (parsed.eTicketNumber) {
    upsertCandidate(candidates, parsed.eTicketNumber, 'parsed-e-ticket', 75);
  }

  for (const text of rawTexts) {
    for (const match of text.matchAll(/(?<!\d)(\d{13})(?!\d)/g)) {
      upsertCandidate(candidates, match[1], 'exact-13-digit-run', 55);
    }

    for (const match of text.matchAll(/(?<!\d)(\d(?:[\s-]?\d){12})(?!\d)/g)) {
      if (/\D/.test(match[1])) {
        upsertCandidate(candidates, match[1], 'separator-normalized-13', 48);
      }
    }

    for (const match of text.matchAll(/\d{13,32}/g)) {
      addRunWindows(candidates, match[0], 'numeric-run');
    }

    for (const match of text.matchAll(/(?:\d[\s-]*){13,24}/g)) {
      const compacted = normalizeTicketNumber(match[0]);
      if (compacted.length < TICKET_NUMBER_LENGTH) continue;
      addRunWindows(candidates, compacted, 'separator-normalized-run');
    }
  }

  return Array.from(candidates.values());
}

function sourceBonus(candidate) {
  let bonus = 0;
  if (candidate.sources.includes('parsed-e-ticket')) bonus += 55;
  if (candidate.sources.includes('exact-13-digit-run')) bonus += 25;
  if (candidate.sources.includes('separator-normalized-13')) bonus += 18;
  if (candidate.sources.some(source => source.includes('known-prefix-window'))) bonus += 15;
  if (candidate.sources.some(source => source.includes('fallback-leading-13'))) bonus -= 18;
  return bonus;
}

function scoreCandidate(candidate, operatingCarrier) {
  let score = candidate.score + sourceBonus(candidate);

  if (candidate.knownPrefix) score += 90;

  if (
    operatingCarrier &&
    candidate.issuerAirlines.some(airline => normalizeCarrier(airline.iata) === operatingCarrier)
  ) {
    score += 25;
  }

  return score;
}

function extractionConfidence(candidate, operatingCarrier) {
  if (!candidate) return '';

  const issuerMatchesCarrier = operatingCarrier &&
    candidate.issuerAirlines.some(airline => normalizeCarrier(airline.iata) === operatingCarrier);

  if (candidate.knownPrefix && (candidate.sources.includes('parsed-e-ticket') || issuerMatchesCarrier)) {
    return 'high';
  }

  if (candidate.knownPrefix || candidate.sources.includes('parsed-e-ticket') || candidate.sources.includes('exact-13-digit-run')) {
    return 'medium';
  }

  return 'low';
}

function chooseTicketCandidate(candidates, operatingCarrier) {
  return candidates
    .map(candidate => ({
      ...candidate,
      score: scoreCandidate(candidate, operatingCarrier),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (Number(b.knownPrefix) !== Number(a.knownPrefix)) return Number(b.knownPrefix) - Number(a.knownPrefix);
      return b.sources.length - a.sources.length;
    })[0];
}

function resolveOperatingAirline(code, ticketPrefix) {
  const candidates = airlinesByIata.get(code) || [];
  if (candidates.length === 0) return null;

  const matchingPrefix = ticketPrefix
    ? candidates.find(airline => airline.ticketPrefix === ticketPrefix)
    : null;

  if (matchingPrefix) return { ...matchingPrefix, candidates };
  if (candidates.length === 1) return { ...candidates[0], candidates };
  return { code, candidates };
}

function compactCandidate(candidate) {
  return {
    value: candidate.value,
    prefix: candidate.prefix,
    knownPrefix: candidate.knownPrefix,
    issuerAirlines: candidate.issuerAirlines,
    sources: candidate.sources,
    score: candidate.score,
  };
}

function enrichBarcodeResult(result) {
  if (!result?.success) return result;

  const parsed = result.parsed && typeof result.parsed === 'object' ? { ...result.parsed } : {};
  const dateCandidates = buildDateCandidates(parsed);
  if (dateCandidates) {
    parsed.dateCandidates = dateCandidates;
  }

  const operatingCarrier = normalizeCarrier(parsed.operatingCarrier);
  const candidates = collectTicketCandidates({ ...result, parsed });
  const selected = chooseTicketCandidate(candidates, operatingCarrier);

  if (selected) {
    const confidence = extractionConfidence(selected, operatingCarrier);
    parsed.eTicketNumber = selected.value;
    parsed.ticketPrefix = selected.prefix;
    parsed.ticketIssuer = {
      prefix: selected.prefix,
      airlines: selected.issuerAirlines,
      matchFound: selected.knownPrefix,
    };

    parsed.ticketExtraction = {
      confidence,
      sources: selected.sources,
      candidates: candidates
        .map(candidate => ({
          ...candidate,
          score: scoreCandidate(candidate, operatingCarrier),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_CANDIDATES_RETURNED)
        .map(compactCandidate),
    };

    if (!selected.knownPrefix) {
      parsed.ticketExtraction.warning = `Ticket prefix ${selected.prefix} is not in airline data.`;
    } else if (
      operatingCarrier &&
      selected.issuerAirlines.length > 0 &&
      !selected.issuerAirlines.some(airline => normalizeCarrier(airline.iata) === operatingCarrier)
    ) {
      parsed.ticketExtraction.warning = 'Ticketing airline prefix differs from the operating carrier.';
    }
  } else {
    parsed.ticketExtraction = {
      confidence: '',
      sources: [],
      candidates: [],
    };
  }

  if (operatingCarrier) {
    const operatingAirline = resolveOperatingAirline(operatingCarrier, selected?.prefix);
    if (operatingAirline) {
      parsed.operatingAirline = operatingAirline;
    }
  }

  result.parsed = parsed;
  return result;
}

/**
 * The airline that issued a ticket, from its three-digit prefix.
 * "7245528980584" -> Swiss, because 724 is Swiss's ticketing prefix.
 *
 * Returns null for an unknown prefix, and for the handful of prefixes that map
 * to more than one carrier - a guess there is worse than saying nothing.
 */
function airlineForTicketPrefix(ticketNumber) {
  const digits = normalizeTicketNumber(ticketNumber);
  if (digits.length < 3) return null;

  const airlines = airlinesByTicketPrefix.get(digits.slice(0, 3));
  if (!airlines || airlines.length !== 1) return null;

  return { iata: airlines[0].iata || '', name: airlines[0].name || '' };
}

module.exports = {
  buildDateCandidates,
  collectTicketCandidates,
  enrichBarcodeResult,
  // Exported for the analyzer v2 controller, which validates the ticket numbers
  // read off a document rather than decoded from a barcode. Same rules, so the
  // definition of "a real ticket number" stays in one place.
  isPlausibleTicketNumber,
  normalizeTicketNumber,
  airlineForTicketPrefix,
};
