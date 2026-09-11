import JourneyCard from './JourneyCard.jsx';
import PassengersPanel from './PassengersPanel.jsx';
import ReplacementGroup from './ReplacementGroup.jsx';

/**
 * Everything the analysis produced, in the order a specialist reads it:
 * who and what reference, then the trip as sold, then what actually happened.
 *
 * This component only arranges. Every judgement it displays was made on the
 * server - there is deliberately no logic here that could disagree with the
 * engine, because two places deciding the same thing is how the old tool ended
 * up telling a specialist one story and the EC261 calculator another.
 */
export default function ResultsPanel({ result }) {
  const journeys = result.booking?.journeys || [];
  const replacementItineraries = result.replacementItineraries || [];
  const passengers = result.passengers || [];
  const bookingReferences = result.bookingReferences || [];
  const flightsWithoutReference = result.flightsWithoutBookingReference || [];
  const warnings = result.warnings || [];

  if (result.noFlightData) {
    return (
      <div className="av2-empty">
        <h3>No flights found</h3>
        <p>
          The upload worked, but nothing in these documents looked like a flight.
          Check that the right files were attached.
        </p>
      </div>
    );
  }

  return (
    <div className="av2-results">
      {warnings.length > 0 && (
        <ul className="av2-warnings" aria-label="Warnings">
          {warnings.map((warning) => (
            <li key={warning.code} className="av2-warning">
              {warning.message}
            </li>
          ))}
        </ul>
      )}

      <PassengersPanel passengers={passengers} />

      <section className="av2-summary" aria-label="Booking summary">
        <div className="av2-summary__block av2-summary__block--wide">
          <h3 className="av2-summary__title">
            {bookingReferences.length === 1 ? 'Booking reference' : 'Booking references'}
          </h3>
          {bookingReferences.length > 0 ? (
            <ul className="av2-summary__list">
              {bookingReferences.map((reference) => (
                <li key={reference.value} className="av2-reference">
                  <span className="av2-summary__code">{reference.value}</span>
                  {reference.carrier && (
                    <span className="av2-summary__carrier">{reference.carrier}</span>
                  )}
                  {/* Which flights this code actually opens. A bare list of
                      codes against a five-flight trip says nothing about which
                      one to quote when calling an airline. */}
                  <span className="av2-reference__legs">
                    {reference.flightNumbers.length > 0
                      ? reference.flightNumbers.join(' · ')
                      : 'not matched to a flight'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="av2-summary__none">None found</p>
          )}

          {/* Silence here would read as "nothing to report" when it means the
              opposite: these flights have no locator to look up at all. */}
          {flightsWithoutReference.length > 0 && (
            <p className="av2-summary__note">
              No reference printed for {flightsWithoutReference.join(', ')}.
            </p>
          )}
        </div>

        <div className="av2-summary__block">
          <h3 className="av2-summary__title">Read from</h3>
          <p className="av2-summary__evidence">
            {result.evidenceMode === 'boarding_passes'
              ? 'Boarding passes only'
              : 'Booking documents'}
          </p>
          {/* Precisely what ignorePnr does, and nothing more. It stops the
              references being used to decide whether a CONNECTION was booked
              separately - on boarding passes each airline prints its own code,
              so comparing them would invent split-booking warnings. The codes
              themselves are still read, still shown, and still what a
              specialist quotes to the airline. Saying "ignored" beside a list
              of them was both wrong and confusing. */}
          {result.evidenceMode === 'boarding_passes' && (
            <p className="av2-summary__note">
              Not used to group flights — each airline prints its own.
            </p>
          )}
        </div>
      </section>

      <section aria-label="Original booking">
        <h2 className="av2-section-title">Original booking</h2>
        {journeys.length > 0 ? (
          journeys.map((journey) => (
            <JourneyCard key={journey.id} journey={journey} />
          ))
        ) : (
          <p className="av2-summary__none">No booked journey could be reconstructed.</p>
        )}
      </section>

      {replacementItineraries.length > 0 && (
        <section aria-label="Replacement flights">
          <h2 className="av2-section-title">Replacement flights</h2>
          {replacementItineraries.map((itinerary) => (
            <ReplacementGroup key={itinerary.id} itinerary={itinerary} />
          ))}
        </section>
      )}
    </div>
  );
}
