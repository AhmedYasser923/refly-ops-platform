import { useId, useState } from 'react';

/**
 * An airline's name, as a flight row prints it. When airlines_codes.json has
 * the airline, the name is underlined with dots, and hovering it opens a card
 * with what the old analyzer's claim-document list shows: the airline's IATA
 * and ICAO codes, its ticket prefix, the documents it asks for with a claim,
 * and the country it is registered in with that country's claim limit.
 *
 * The details come from the server (Step 4a in analyzerV2Controller.js); this
 * only shows them. An airline the file does not have is plain text: no card
 * is better than one that guesses.
 *
 * Opens on hover and on keyboard focus, and Escape closes it, the same as the
 * EOC card on an airport code (AirportCode.jsx).
 */
export default function AirlineName({ name, details, className = '' }) {
  const [cardOpen, setCardOpen] = useState(false);
  const cardId = useId();

  if (!details) return <span className={className || undefined}>{name}</span>;

  return (
    <span
      className={[className, 'av2-airline'].filter(Boolean).join(' ')}
      onMouseEnter={() => setCardOpen(true)}
      onMouseLeave={() => setCardOpen(false)}
    >
      <span
        className="av2-airline__name"
        tabIndex={0}
        aria-describedby={cardId}
        onFocus={() => setCardOpen(true)}
        onBlur={() => setCardOpen(false)}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === 'Escape') setCardOpen(false);
        }}
      >
        {name}
      </span>
      <AirlineCard id={cardId} details={details} hidden={!cardOpen} />
    </span>
  );
}

/**
 * The airline's entry, laid out like one item of the old analyzer's "Claim
 * documents" list: the name with the country and its claim limit, the codes
 * as chips, then what to ask the passenger for.
 */
function AirlineCard({ id, details, hidden }) {
  const requirementsClassName = [
    'av2-airline-card__requirements',
    details.requiredDocuments ? '' : 'av2-airline-card__requirements--none'
  ].filter(Boolean).join(' ');

  return (
    <span id={id} role="tooltip" className="av2-airline-card" hidden={hidden}>
      <span className="av2-airline-card__body">
        <span className="av2-airline-card__top">
          <span className="av2-airline-card__name">{details.name}</span>
          {details.country && (
            <span className="av2-airline-card__country">
              {details.country} ({details.claimLimit})
            </span>
          )}
        </span>

        <span className="av2-airline-card__chips">
          {details.iata && (
            <span className="av2-airline-chip av2-airline-chip--code av2-airline-chip--iata">
              IATA {details.iata}
            </span>
          )}
          {details.icao && (
            <span className="av2-airline-chip av2-airline-chip--code av2-airline-chip--icao">
              ICAO {details.icao}
            </span>
          )}
          {details.ticketPrefix && (
            <span className="av2-airline-chip av2-airline-chip--code">
              Ticket prefix {details.ticketPrefix}
            </span>
          )}
          {details.ticketNumberCanReplacePnr && (
            <span className="av2-airline-chip av2-airline-chip--warning">Ticket # replaces PNR</span>
          )}
          {details.oneTimeSubmission && (
            <span className="av2-airline-chip av2-airline-chip--success">One-time submission</span>
          )}
          {details.ceasedOperations && (
            <span className="av2-airline-chip av2-airline-chip--muted">Ceased operations</span>
          )}
        </span>

        <span className="av2-airline-card__documents">
          <span className="av2-airline-card__label">Claim documents</span>
          <span className={requirementsClassName}>
            {details.requiredDocuments || 'No documents required'}
          </span>
        </span>

        {details.claimNote && <span className="av2-airline-card__note">{details.claimNote}</span>}
      </span>
    </span>
  );
}
