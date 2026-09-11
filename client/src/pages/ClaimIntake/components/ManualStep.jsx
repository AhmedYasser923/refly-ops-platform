import FlightRow from './FlightRow.jsx';
import PassengerList from './PassengerList.jsx';

// Typing your own flights uses the very same row component as reviewing
// extracted ones. An empty row has no airports, so FlightRow already shows the
// From/To fields and opens itself — nothing here needs a second form.
export default function ManualStep({
  tripShape,
  passengers,
  flights,
  value,
  onChange,
  onAddPassenger,
  onAddFlight,
  onRemoveFlight,
  onSubmit,
  onBack,
  busy,
  error
}) {
  const ready = flights.some((leg) => value(leg, 'departureIata') || value(leg, 'flightNumber'));

  return (
    <div className="ci-step">
      <button className="ci-back" onClick={onBack} type="button">
        <span aria-hidden="true">‹</span> Back
      </button>

      <header className="ci-step__header">
        <h1 className="ci-step__title">Your flights</h1>
        <p className="ci-step__lead">
          {tripShape === 'direct'
            ? 'Add the flight you booked.'
            : 'Add each flight in the order you flew them, including any you did not end up taking.'}
        </p>
      </header>

      {error && <p className="ci-error">{error}</p>}

      <PassengerList
        onAddPassenger={onAddPassenger}
        onChange={onChange}
        passengers={passengers}
        value={value}
      />

      <section className="ci-card">
        <header className="ci-card__header">
          <h2 className="ci-card__title">Flights</h2>
          <p className="ci-card__lead">Airline, flight number and date for each one.</p>
        </header>

        {flights.map((leg, index) => (
          <FlightRow
            index={index}
            key={leg.id}
            leg={leg}
            onChange={onChange}
            onRemove={flights.length > 1 ? onRemoveFlight : undefined}
            value={value}
          />
        ))}

        <button className="ci-button ci-button--ghost" onClick={onAddFlight} type="button">
          + Add another flight
        </button>
      </section>

      <div className="ci-actions">
        <button
          className="ci-button ci-button--primary"
          disabled={!ready || busy}
          onClick={onSubmit}
          type="button"
        >
          {busy ? 'Working…' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
