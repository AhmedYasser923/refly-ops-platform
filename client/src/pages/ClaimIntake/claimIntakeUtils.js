// Pure helpers for the claim intake flow. No imports from the ops tools.
//
// There is no time anywhere in here on purpose — the engine works in whole days
// and the passenger is never shown or asked for a clock.

export const MAX_FILES = 5;

// Human-readable flag copy. Anything not listed here is simply not shown —
// flags are added backend-side faster than the UI needs to explain them.
export const LEG_FLAG_LABELS = {
  MISSING_DATE: 'Date needed',
  MISSING_AIRPORT: 'Airport needed',
  AMBIGUOUS_FLIGHT_NUMBER: 'Check flight number'
};

export function formatDate(value) {
  if (!value) return '';

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

export function placeLabel(place) {
  if (!place) return '';
  if (place.city && place.iata) return `${place.city} (${place.iata})`;
  return place.city || place.iata || '';
}

// Short form for a flight row: the city if we have one, the code if not.
export function shortPlace(place) {
  if (!place) return '';
  return place.city || place.iata || '';
}

export function journeyLabel(journey) {
  const from = placeLabel(journey.origin) || 'Unknown';
  const to = placeLabel(journey.finalDestination) || 'Unknown';
  return `${from} → ${to}`;
}

export function stopLabel(journey) {
  if (journey.isDirect) return '';
  return journey.stopCount === 1 ? '1 stop' : `${journey.stopCount} stops`;
}

// What this journey is to the trip as a whole. A lone journey gets no label —
// there is nothing to tell it apart from.
const JOURNEY_ROLE_LABELS = {
  OUTBOUND: 'Outbound',
  RETURN: 'Return',
  ONWARD: 'Onward'
};

export function journeyRoleLabel(journey, index) {
  if (journey.role && JOURNEY_ROLE_LABELS[journey.role]) return JOURNEY_ROLE_LABELS[journey.role];
  return index === null || index === undefined ? '' : `Trip ${index + 1}`;
}

export function journeysSummary(journeys) {
  if (journeys.length < 2) return '';

  const roles = journeys.map((journey) => journey.role);
  if (journeys.length === 2 && roles[0] === 'OUTBOUND' && roles[1] === 'RETURN') {
    return 'Outbound and return';
  }
  return `${journeys.length} trips`;
}

export function passengerLabel(passenger) {
  const name = [passenger.firstName, passenger.lastName].filter(Boolean).join(' ').trim();
  return name || 'Unnamed passenger';
}

// ---------------------------------------------------------------------------
// What happened
// ---------------------------------------------------------------------------
//
// A plain description of a disrupted trip: the route as booked against the route
// as flown, then what changed, in order. No times — the engine has none — and no
// summing-up line. Every clause drops out when its data is missing rather than
// turning into a guess.

export function routeText(places) {
  return (places || []).map(shortPlace).filter(Boolean).join(' → ');
}

function flightText(brief) {
  return brief?.flightNumber || 'that flight';
}

// "In Zurich, ..." — where a disruption happened, when we know the place.
function atText(place) {
  const where = shortPlace(place);
  return where ? `In ${where}, ` : '';
}

function eventSentence(event) {
  const at = atText(event.at);
  const original = flightText(event.original);
  const replacement = flightText(event.replacement);
  const planned = shortPlace(event.original?.to) ? ` to ${shortPlace(event.original.to)}` : '';

  if (event.kind === 'REROUTE') {
    const via = shortPlace(event.replacement?.to)
      ? ` through ${shortPlace(event.replacement.to)}`
      : ' a different way';
    const cause = event.reason === 'MISSED_CONNECTION'
      ? `you missed your connection, so ${original}${planned} was not flown`
      : `${original}${planned} was not flown`;
    return `${at}${cause}. You were sent${via} instead, on ${replacement}.`;
  }

  const cause = event.reason === 'MISSED_CONNECTION'
    ? `you did not make ${original}${planned}`
    : `you were moved off ${original}${planned}`;
  return `${at}${cause}. You travelled on ${replacement} instead.`;
}

// Dates belong on the flights themselves, where they can be checked and
// corrected. Repeating them in the description only makes the sentences longer.
function planSentence(story) {
  const route = routeText(story.booked.places);
  return route ? `You were booked to fly ${route}.` : '';
}

export function storyNarrative(story) {
  if (!story) return null;

  return {
    plan: planSentence(story),
    events: (story.events || []).map((event) => ({
      id: event.id,
      kind: event.kind,
      text: eventSentence(event)
    }))
  };
}

// ---------------------------------------------------------------------------
// Flight rows
// ---------------------------------------------------------------------------

const REPLACEMENT_REASON_TEXT = {
  MISSED_CONNECTION: 'after it was missed',
  REBOOKED: 'after it was rebooked'
};

// "Instead of IB0267, after it was missed"
export function insteadOfLabel(insteadOf) {
  if (!insteadOf) return '';
  const flight = insteadOf.flightNumber || 'an earlier flight';
  const reason = REPLACEMENT_REASON_TEXT[insteadOf.reason];
  return reason ? `Instead of ${flight}, ${reason}` : `Instead of ${flight}`;
}

export function routeOfLeg(leg) {
  const from = shortPlace({ iata: leg.departureIata, city: leg.departureCity });
  const to = shortPlace({ iata: leg.arrivalIata, city: leg.arrivalCity });
  if (!from && !to) return 'New flight';
  return `${from || '?'} → ${to || '?'}`;
}

// ---------------------------------------------------------------------------
// Passenger corrections
// ---------------------------------------------------------------------------
//
// Corrections live apart from what the model read, so "extracted" and
// "confirmed by the passenger" never blur together. Entity ids are already
// unique and prefixed ("leg-1", "passenger-2"), so they key the edit map alone.

export function editKey(entityId, field) {
  return `${entityId}.${field}`;
}

export function resolveValue(edits, entity, field) {
  const key = editKey(entity.id, field);
  if (edits && key in edits) return edits[key];
  return entity[field] ?? '';
}

// Everything the passenger typed into a set of rows, as plain objects. Manual
// entry keeps its values in the same edit map as every other correction, so
// this is how they come back out to be sent.
export function applyLegEdits(entities, edits) {
  return entities.map((entity) => {
    const next = { ...entity };
    Object.keys(edits).forEach((key) => {
      const [id, field] = key.split('.');
      if (id === entity.id) next[field] = edits[key];
    });
    return next;
  });
}

// Merges the passenger's corrections back into the extracted payload.
export function applyEdits(extraction, edits) {
  const patch = (entity) => {
    const next = { ...entity };
    Object.keys(entity).forEach((field) => {
      const key = editKey(entity.id, field);
      if (key in edits) next[field] = edits[key];
    });
    return next;
  };

  return {
    ...extraction,
    passengers: (extraction.passengers || []).map(patch),
    booking: {
      journeys: (extraction.booking?.journeys || []).map((journey) => ({
        ...journey,
        legs: journey.legs.map(patch)
      }))
    },
    replacementFlights: (extraction.replacementFlights || []).map(patch)
  };
}

export function acceptedFiles(fileList) {
  return Array.from(fileList || []).filter(
    (file) => file.type.startsWith('image/') || file.type === 'application/pdf'
  );
}

export function formatFileSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
