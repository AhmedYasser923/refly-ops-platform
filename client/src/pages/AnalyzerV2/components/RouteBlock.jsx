import AirportCode from './AirportCode.jsx';
import RouteDistance from './RouteDistance.jsx';
import TrackerCircles from './TrackerCircles.jsx';
import { formatCityAndCountry, withAirportSuffix } from '../analyzerV2Utils.js';

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
 * A place may carry `eoc`, the extraordinary circumstances at that airport;
 * its code then turns red and pulses (see AirportCode).
 *
 * The distance carries `compensation`, what EC261 pays for it - see
 * RouteDistance, which opens it on hover.
 *
 * When the block stands for ONE flight, `flight` carries it - its number, its
 * date and its tracker links - and the buttons for those trackers sit under the
 * AIR line (see TrackerCircles). A heading over several flights passes nothing,
 * because a tracker is asked about one flight.
 *
 * Built from spans so the journey heading can hold it inside its <h3>.
 */
export default function RouteBlock({
  from, to, distanceKm, compensation = null, flight = null, variant = 'flight'
}) {
  const className = variant === 'journey' ? 'av2-route av2-route--journey' : 'av2-route';

  return (
    <span className={className}>
      <RoutePoint place={from} />
      <span className="av2-route__line">
        <RouteDistance distanceKm={distanceKm} compensation={compensation} />
        <span className="av2-route__air" aria-hidden="true">AIR</span>
        <TrackerCircles flight={flight} />
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
      <AirportCode iata={place?.iata} events={place?.eoc} />
      <span className="av2-route__name">{withAirportSuffix(place?.airportName || place?.city)}</span>
      <small className="av2-route__place">{formatCityAndCountry(place)}</small>
    </span>
  );
}
