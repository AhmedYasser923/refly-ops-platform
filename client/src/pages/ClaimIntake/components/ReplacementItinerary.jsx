import FlightRow from './FlightRow.jsx';
import { formatDate, routeText, shortPlace } from '../claimIntakeUtils.js';

const REASON_TEXT = {
  MISSED_CONNECTION: 'after it was missed',
  REBOOKED: 'after it was rebooked'
};

// One missed flight is not always replaced by one flight. When the airline
// reroutes, a single leg is replaced by a whole new routing — ZRH → BEG becomes
// ZRH → AMS → BEG — and the second flight of that routing replaced nothing on
// its own. Grouped under the flight they stand in for, it reads as one decision
// the airline made rather than three unrelated flights.
export default function ReplacementItinerary({ group, value, onChange, onRemove }) {
  const { insteadOf } = group;
  const from = shortPlace(insteadOf?.from);
  const to = shortPlace(insteadOf?.to);
  const reason = REASON_TEXT[insteadOf?.reason];
  const rerouted = group.isReroute ? routeText(group.places) : '';

  return (
    <div className="ci-replacement">
      {insteadOf && (
        <header className="ci-replacement__header">
          <p className="ci-replacement__label">
            Instead of {insteadOf.flightNumber || 'your booked flight'}
          </p>
          <p className="ci-replacement__origin">
            {[from && to ? `${from} → ${to}` : '', formatDate(insteadOf.date), reason]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {rerouted && (
            <p className="ci-replacement__route">
              You were sent <strong>{rerouted}</strong> instead.
            </p>
          )}
        </header>
      )}

      {group.legs.map((leg, index) => (
        <FlightRow
          index={index}
          key={leg.id}
          leg={leg}
          onChange={onChange}
          onRemove={onRemove}
          // The group heading already says what this stands in for; repeating it
          // on the first flight is noise. A flight that replaced a *sibling*
          // still says so.
          rootLegId={insteadOf?.legId}
          value={value}
        />
      ))}
    </div>
  );
}
