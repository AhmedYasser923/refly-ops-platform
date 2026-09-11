import DisruptionStory from './DisruptionStory.jsx';
import FlightRow from './FlightRow.jsx';
import RouteBlock from './RouteBlock.jsx';
import {
  flagTone,
  formatDate,
  formatFlag,
  formatJourneyRole
} from '../analyzerV2Utils.js';

/**
 * One journey from the booking: its route, its flights, and - when the route
 * actually changed - what happened to it.
 *
 * A journey is the trip AS IT WAS SOLD. Flights the passenger never boarded
 * stay in this list, greyed and tagged, because they are still part of what the
 * airline contracted to provide. What they were moved onto instead lives in the
 * replacement section, not here.
 */
export default function JourneyCard({ journey }) {
  const legs = Array.isArray(journey.legs) ? journey.legs : [];
  const connections = Array.isArray(journey.connections) ? journey.connections : [];
  const flags = Array.isArray(journey.flags) ? journey.flags : [];

  // Most connections are unremarkable and say nothing worth printing. Only the
  // ones carrying a flag - separate bookings, an unplanned stop - get a line, so
  // a clean four-leg trip does not grow four empty notes underneath it.
  const flaggedConnections = connections.filter(
    (connection) => (connection.flags || []).length > 0
  );

  return (
    <article className="av2-journey">
      <header className="av2-journey__header">
        <div className="av2-journey__heading">
          <span className="av2-journey__role">{formatJourneyRole(journey.role)}</span>
        </div>

        <div className="av2-journey__facts">
          <span>{formatDate(journey.departureDate) || 'No date'}</span>
          <span aria-hidden="true">·</span>
          <span>
            {journey.isDirect
              ? 'Direct'
              : `${journey.stopCount} ${journey.stopCount === 1 ? 'stop' : 'stops'}`}
          </span>
        </div>

        {flags.length > 0 && (
          <ul className="av2-chips">
            {flags.map((flag) => (
              <li key={flag} className={`av2-chip av2-chip--${flagTone(flag)}`}>
                {formatFlag(flag)}
              </li>
            ))}
          </ul>
        )}

        {/* The journey's two ends in the old analyzer's route layout - the same
            block the flight rows below use for their own flights. */}
        <h3 className="av2-journey__route">
          <RouteBlock
            variant="journey"
            from={journey.origin}
            to={journey.finalDestination}
            distanceKm={journey.distanceKm}
          />
        </h3>
      </header>

      <ul className="av2-flights">
        {/* A direct trip's one flight has the heading's two airports, so its
            row drops the route block rather than print it a second time. */}
        {legs.map((leg) => (
          <FlightRow key={leg.id} leg={leg} showRoute={!journey.isDirect} />
        ))}
      </ul>

      {flaggedConnections.length > 0 && (
        <ul className="av2-journey__connection-notes">
          {flaggedConnections.map((connection) => (
            <li key={`${connection.fromLegId}-${connection.toLegId}`}>
              <strong>{connection.atCity || connection.atIata}</strong>
              {connection.flags.map((flag) => (
                <span key={flag} className={`av2-chip av2-chip--${flagTone(flag)}`}>
                  {formatFlag(flag)}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}

      <DisruptionStory story={journey.story} />
    </article>
  );
}