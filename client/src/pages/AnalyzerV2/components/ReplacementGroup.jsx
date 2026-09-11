import FlightRow from './FlightRow.jsx';
import {
  formatDateShort,
  formatPlace,
  formatReplacementReason
} from '../analyzerV2Utils.js';

/**
 * The flights the passenger was moved onto, grouped under the booked flight
 * each group stands in for.
 *
 * WHY GROUPED RATHER THAN LISTED FLAT
 *   A reroute is one decision that can produce several flights. When Zurich to
 *   Belgrade was missed, the passenger was put on Zurich to Amsterdam AND
 *   Amsterdam to Belgrade - two flights, one rebooking. Listing them flat makes
 *   a specialist reconstruct that link by eye every time; grouping them states
 *   it once, in the heading.
 */
export default function ReplacementGroup({ itinerary }) {
  const legs = Array.isArray(itinerary.legs) ? itinerary.legs : [];
  const insteadOf = itinerary.insteadOf;

  return (
    <article className="av2-replacement">
      {insteadOf && (
        <header className="av2-replacement__header">
          <span className="av2-replacement__label">Instead of</span>
          <span className="av2-replacement__original">
            <strong>{insteadOf.flightNumber || 'a booked flight'}</strong>
            {' '}
            {formatPlace(insteadOf.from)} → {formatPlace(insteadOf.to)}
            {insteadOf.date && <span className="av2-replacement__date">
              {' '}on {formatDateShort(insteadOf.date)}
            </span>}
          </span>
          <span className="av2-replacement__reason">
            {formatReplacementReason(insteadOf.reason)}
          </span>
        </header>
      )}

      <ul className="av2-flights">
        {legs.map((leg) => (
          // The heading already established that everything here is a
          // replacement, so the per-row chip would only repeat it.
          <FlightRow key={leg.id} leg={leg} suppressFlags={['REPLACEMENT']} />
        ))}
      </ul>
    </article>
  );
}
