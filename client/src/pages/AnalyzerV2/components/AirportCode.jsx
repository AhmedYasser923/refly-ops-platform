import { useId, useState } from 'react';
import { formatDate } from '../analyzerV2Utils.js';

/**
 * An airport's code, big, as the route block prints it. When an extraordinary
 * circumstance (a strike, a storm, a closed airspace) hit that airport on the
 * day of the flight, the code is red and pulsing, and hovering it opens a card
 * with the events.
 *
 * The events come from the server (Step 4b in analyzerV2Controller.js), which
 * decided which airport each one belongs to. This only shows them.
 *
 * A marked code takes focus, so the card also opens from the keyboard, and
 * Escape closes it. Built from spans, like the route block, so it can sit
 * inside the journey heading's <h3>.
 */
export default function AirportCode({ iata, events }) {
  const [cardOpen, setCardOpen] = useState(false);
  const cardId = useId();
  const code = iata || '???';

  if (!Array.isArray(events) || events.length === 0) {
    return <strong className="av2-route__code">{code}</strong>;
  }

  return (
    <span
      className="av2-route__eoc"
      onMouseEnter={() => setCardOpen(true)}
      onMouseLeave={() => setCardOpen(false)}
    >
      <strong
        className="av2-route__code av2-route__code--eoc"
        tabIndex={0}
        aria-describedby={cardId}
        onFocus={() => setCardOpen(true)}
        onBlur={() => setCardOpen(false)}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === 'Escape') setCardOpen(false);
        }}
      >
        {code}
      </strong>
      <EocCard id={cardId} events={events} hidden={!cardOpen} />
    </span>
  );
}

/**
 * The events at one airport, listed the way the old analyzer's EOC panel
 * lists them: category, event, location and decision, plus when an ongoing
 * issue started and whether it has ended.
 */
function EocCard({ id, events, hidden }) {
  return (
    <span id={id} role="tooltip" className="av2-eoc-card" hidden={hidden}>
      <span className="av2-eoc-card__body">
        <span className="av2-eoc-card__title">
          {events.length > 1
            ? `${events.length} extraordinary circumstances`
            : 'Extraordinary circumstance'}
        </span>
        {events.map((event) => (
          <span key={event.id} className="av2-eoc-card__event">
            <EocField label="Category" value={event.category} />
            <EocField label="Event" value={event.event} />
            <EocField label="Location" value={event.location} />
            <EocField label="Decision" value={event.decision} />
            {event.ongoing && (
              <>
                <EocField label="Started" value={formatDate(event.startDate) || 'Unknown'} />
                <EocField
                  label="Status"
                  value={event.endDate ? `Ended ${formatDate(event.endDate)}` : 'Still ongoing'}
                />
                {event.closureNote && <EocField label="Closure note" value={event.closureNote} />}
              </>
            )}
          </span>
        ))}
      </span>
    </span>
  );
}

function EocField({ label, value }) {
  return (
    <>
      <span className="av2-eoc-card__label">{label}</span>
      <span className="av2-eoc-card__value">{value || '—'}</span>
    </>
  );
}
