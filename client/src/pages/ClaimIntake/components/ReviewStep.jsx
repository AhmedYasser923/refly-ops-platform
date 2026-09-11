import FlightRow from './FlightRow.jsx';
import JourneyStory from './JourneyStory.jsx';
import ReplacementItinerary from './ReplacementItinerary.jsx';
import PassengerList from './PassengerList.jsx';
import {
  journeyLabel,
  journeyRoleLabel,
  journeysSummary,
  stopLabel
} from '../claimIntakeUtils.js';

// The screen is two lists and nothing else: the trip as it was booked, and the
// flights the passenger was moved onto instead. That is the shape a passenger
// already thinks in, and it is the split the next step's questions branch on.
export default function ReviewStep({
  extraction,
  passengers,
  bookingFlights,
  replacementItineraries,
  addedReplacementFlights,
  value,
  onChange,
  onAddPassenger,
  onAddFlight,
  onRemoveFlight,
  onStartOver,
  tripShape
}) {
  // `warnings` still arrives on the payload and is still derived — it just is
  // not banner material. A passenger opening this screen wants to see their
  // trip, not a stack of amber boxes above it. What each warning was for now
  // lives where it belongs: a date we could not read opens its own row with the
  // field highlighted, and an assumed year is visible in the date itself.
  const { bookingReferences = [], evidenceMode } = extraction;
  const journeys = extraction.booking?.journeys || [];

  // Boarding passes tell us what happened, not how the trip was booked. Their
  // record locators are per-airline and mean nothing to the passenger.
  const boardingPassesOnly = evidenceMode === 'boarding_passes';

  const story = journeys.map((journey) => journey.story).find((entry) => entry?.changedRoute);
  const showRole = journeys.length > 1;
  const hasReplacements = replacementItineraries.length > 0 || addedReplacementFlights.length > 0;

  // The passenger told us the shape of their trip before we had seen anything.
  // The engine works it out from the airports and that is what is shown — but
  // when the two disagree, say so rather than quietly overruling them. Either
  // we read the document wrong or they answered too quickly, and both are worth
  // a second look before the questions start.
  const bookedLegs = journeys.reduce((total, journey) => total + journey.legs.length, 0);
  const shapeMismatch = (tripShape === 'direct' && bookedLegs > 1)
    || (tripShape === 'connecting' && bookedLegs === 1);

  return (
    <div className="ci-step">
      <header className="ci-step__header">
        <h1 className="ci-step__title">Is this your trip?</h1>
        <p className="ci-step__lead">
          We read this from your documents. Check it over and fix anything that is wrong.
          Nothing is submitted yet.
        </p>
      </header>

      {shapeMismatch && (
        <p className="ci-notice">
          {tripShape === 'direct'
            ? `You said this was one flight, but we found ${bookedLegs}. Check the flights below — remove any that are not yours.`
            : 'You said this trip had connections, but we only found one flight. Check below and add anything we missed.'}
        </p>
      )}

      <PassengerList
        onAddPassenger={onAddPassenger}
        onChange={onChange}
        passengers={passengers}
        value={value}
      />

      {/* Only when the trip changed shape. A straight rebooking is already told
          by the two lists below, and saying it twice teaches people to skip
          both. */}
      {story && <JourneyStory story={story} />}

      <section className="ci-card">
        <header className="ci-card__header">
          <h2 className="ci-card__title">Your original booking</h2>
          <p className="ci-card__lead">
            {journeys.length > 1
              ? `The flights you booked — ${journeysSummary(journeys).toLowerCase()}.`
              : 'The flights you booked.'}
          </p>
        </header>

        {journeys.map((journey, index) => {
          const role = showRole ? journeyRoleLabel(journey, index) : '';
          const stops = stopLabel(journey);
          const legs = bookingFlights(journey);
          // On a direct journey the flight row already says the route — a
          // heading above it saying the same thing is just noise.
          const heading = journey.isDirect ? '' : journeyLabel(journey);

          return (
            <div className="ci-group" key={journey.id}>
              {(role || heading) && (
                <header className="ci-group__header">
                  {role && <p className="ci-group__role">{role}</p>}
                  {heading && <h3 className="ci-group__title">{heading}</h3>}
                  {stops && <p className="ci-group__meta">{stops}</p>}
                </header>
              )}

              {legs.map((leg, legIndex) => (
                <FlightRow
                  index={legIndex}
                  key={leg.id}
                  leg={leg}
                  onChange={onChange}
                  onRemove={onRemoveFlight}
                  value={value}
                />
              ))}
            </div>
          );
        })}

        <button className="ci-button ci-button--ghost" onClick={() => onAddFlight('booking')} type="button">
          + Add a flight we missed
        </button>
      </section>

      {hasReplacements && (
        <section className="ci-card ci-card--replacements">
          <header className="ci-card__header">
            <h2 className="ci-card__title">Replacement flights</h2>
            <p className="ci-card__lead">
              The flights you were moved onto after something went wrong.
            </p>
          </header>

          {replacementItineraries.map((group) => (
            <ReplacementItinerary
              group={group}
              key={group.id}
              onChange={onChange}
              onRemove={onRemoveFlight}
              value={value}
            />
          ))}

          {addedReplacementFlights.map((leg, index) => (
            <FlightRow
              index={index}
              key={leg.id}
              leg={leg}
              onChange={onChange}
              onRemove={onRemoveFlight}
              value={value}
            />
          ))}

          <button className="ci-button ci-button--ghost" onClick={() => onAddFlight('replacement')} type="button">
            + Add a flight we missed
          </button>
        </section>
      )}

      {!hasReplacements && (
        <section className="ci-card">
          <header className="ci-card__header">
            <h2 className="ci-card__title">Were you put on a different flight?</h2>
            <p className="ci-card__lead">
              We did not find one in your documents. If you were moved onto another flight,
              add it here.
            </p>
          </header>
          <button className="ci-button ci-button--ghost" onClick={() => onAddFlight('replacement')} type="button">
            + Add a replacement flight
          </button>
        </section>
      )}

      {!boardingPassesOnly && bookingReferences.length > 0 && (
        <section className="ci-card">
          <header className="ci-card__header">
            <h2 className="ci-card__title">Booking references</h2>
          </header>
          <ul className="ci-refs">
            {bookingReferences.map((reference) => (
              <li className="ci-ref" key={reference.value}>
                <code className="ci-ref__value">{reference.value}</code>
                {reference.carrier && <span className="ci-ref__carrier">{reference.carrier}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="ci-actions ci-actions--split">
        <button className="ci-button ci-button--ghost" onClick={onStartOver} type="button">
          Start again
        </button>
        <button className="ci-button ci-button--primary" disabled type="button">
          Yes, this is right
        </button>
      </div>
      <p className="ci-footnote">
        The next step — what went wrong with your flight — isn&apos;t built yet.
      </p>
    </div>
  );
}
