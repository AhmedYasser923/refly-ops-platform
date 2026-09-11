import {
  formatPassengerName,
  formatPrintedName,
  formatTicketNumber
} from '../analyzerV2Utils.js';

/**
 * Who travelled, and the tickets issued to each of them.
 *
 * WHY TICKETS LIVE HERE AND NOT ON THE FLIGHT ROWS
 *   A ticket number is one document covering several coupons - it belongs to a
 *   person, not to a flight. On the Swiss case, ten boarding passes carry only
 *   six distinct numbers, because one ticket covers two legs. Printing it per
 *   row would repeat thirteen digits ten times to say six things, and would
 *   lose the part that matters: which legs share a ticket.
 *
 *   Read down a passenger instead and the reissue history is obvious - one
 *   ticket for the trip as sold, then a new one for each rebooking.
 */
export default function PassengersPanel({ passengers }) {
  if (!passengers || passengers.length === 0) {
    return (
      <section className="av2-passengers" aria-label="Passengers">
        <h2 className="av2-section-title">Passengers</h2>
        <p className="av2-summary__none">No passengers could be read.</p>
      </section>
    );
  }

  return (
    <section className="av2-passengers" aria-label="Passengers">
      <h2 className="av2-section-title">
        {passengers.length === 1 ? 'Passenger' : 'Passengers'}
      </h2>

      <ul className="av2-passengers__list">
        {passengers.map((passenger) => {
          const tickets = passenger.tickets || [];

          return (
            <li key={passenger.id} className="av2-passenger">
              <div className="av2-passenger__identity">
                <span className="av2-passenger__name">
                  {formatPassengerName(passenger)}
                </span>
                {/* The printed form is what gets pasted into airline systems. */}
                <span className="av2-passenger__printed">
                  {formatPrintedName(passenger)}
                </span>
                {passenger.unmatched && (
                  <span className="av2-chip av2-chip--warning">
                    Not in passenger list
                  </span>
                )}
              </div>

              {tickets.length > 0 ? (
                <ul className="av2-tickets">
                  {tickets.map((ticket, index) => (
                    <li key={ticket.id} className="av2-ticket">
                      <span className="av2-ticket__number">
                        {formatTicketNumber(ticket.number)}
                      </span>
                      <span className="av2-ticket__issuer">
                        {ticket.issuedBy ? ticket.issuedBy.name : ''}
                      </span>
                      <span className="av2-ticket__legs">
                        {(ticket.flightNumbers || []).join(' · ')}
                      </span>
                      {/* Every ticket after the first exists because the one
                          before it was reissued. Saying so turns a list of
                          numbers into the booking's history. */}
                      {index > 0 && (
                        <span className="av2-ticket__reissued">reissued</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="av2-summary__none">No ticket number on these documents</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
