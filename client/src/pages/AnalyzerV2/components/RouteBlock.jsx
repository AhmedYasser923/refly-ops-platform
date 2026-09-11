import { formatCityAndCountry, formatDistance, withAirportSuffix } from '../analyzerV2Utils.js';

/**
 * The route between two airports, laid out exactly as the old analyzer's
 * flight card lays it out: at each end the code, big, then the airport's name,
 * then "City, Country"; between them the distance over a dashed line with AIR
 * on it.
 *
 * Used by the journey heading for the journey's two ends, and by a flight row
 * for that one flight, so the two always read the same. (A direct trip's row
 * leaves it out - see FlightRow.) Both ends are one RoutePoint rather than two
 * copies: in the old analyzer the origin and destination blocks were
 * near-identical duplicates of each other.
 *
 * `variant="journey"` is the journey heading's version: the whole trip end to
 * end, on a tinted panel, so it reads as the summary and not as one more flight.
 * The flights keep the plain block - the old analyzer's look, unchanged.
 *
 * Built from spans so the journey heading can hold it inside its <h3>.
 */
export default function RouteBlock({ from, to, distanceKm, variant = 'flight' }) {
  const distance = formatDistance(distanceKm);
  const className = variant === 'journey' ? 'av2-route av2-route--journey' : 'av2-route';

  return (
    <span className={className}>
      <RoutePoint place={from} />
      <span className="av2-route__line">
        {distance && <span className="av2-route__distance">{distance}</span>}
        <span className="av2-route__air" aria-hidden="true">AIR</span>
      </span>
      <RoutePoint place={to} />
    </span>
  );
}

/**
 * One end of the route. The name falls back to "<City> Airport" when the
 * document named no airport - the old analyzer's own fallback.
 */
function RoutePoint({ place }) {
  return (
    <span className="av2-route__point">
      <strong className="av2-route__code">{place?.iata || '???'}</strong>
      <span className="av2-route__name">{withAirportSuffix(place?.airportName || place?.city)}</span>
      <small className="av2-route__place">{formatCityAndCountry(place)}</small>
    </span>
  );
}
