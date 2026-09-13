import { logTrackerSearch } from '../../../api/trackerOverrides.js';
import { TRACKERS } from './TrackerCircles.jsx';

/**
 * The trackers for a whole journey with connections, as a row of round buttons
 * under the heading's AIR line: AirportInfo, FlightStats and Flightera.
 *
 * One click on a tracker opens that tracker for EVERY flight in the journey,
 * one tab per flight, in the order the journey flies them - so the first flight
 * is in the first tab. There is deliberately no "all three trackers" button
 * here: three trackers times every flight is more tabs than anyone reads.
 *
 * The links are the ones the server already built for each flight (Step 4c),
 * so a tab opened here is the same page the flight's own row opens. A flight
 * that cannot be looked up (no full date, two numbers in one row) is skipped
 * and named in the button's title; when no flight can be, the buttons dim.
 *
 * Opening several tabs from one click is where a browser's popup blocker may
 * step in - the same as the single-flight "all three" button - until the site
 * is allowed to open windows.
 */
export default function JourneyTrackers({ legs }) {
  const flights = Array.isArray(legs) ? legs : [];
  if (flights.length === 0) return null;

  const lookable = flights.filter((leg) => leg.trackers && !leg.trackers.unavailable);
  const skipped = flights.filter((leg) => !lookable.includes(leg));

  const flightList = lookable.map((leg) => leg.flightNumber).join(', ');
  const skippedNote = skipped.length > 0
    ? ` (${skipped.map((leg) => leg.flightNumber || 'a flight').join(', ')} cannot be looked up)`
    : '';

  if (lookable.length === 0) {
    const reason = 'No flight in this journey can be looked up';

    return (
      <span className="av2-trackers">
        {TRACKERS.map((tracker) => (
          <span
            key={tracker.key}
            className="av2-tracker av2-tracker--off"
            role="img"
            aria-label={`${tracker.label} unavailable: ${reason}`}
            title={`${tracker.label} - ${reason}`}
          >
            <img alt="" src={tracker.icon} />
          </span>
        ))}
      </span>
    );
  }

  const openEveryFlight = (tracker) => {
    lookable.forEach((leg) => {
      window.open(leg.trackers[tracker.key], '_blank', 'noopener');
      // One record per flight, as if each had been opened from its own row.
      logTrackerSearch({ flightNumber: leg.flightNumber, date: leg.departureDate, trackers: [tracker.key] });
    });
  };

  return (
    <span className="av2-trackers">
      {TRACKERS.map((tracker) => (
        <button
          key={tracker.key}
          className="av2-tracker"
          type="button"
          onClick={() => openEveryFlight(tracker)}
          aria-label={`Open ${tracker.label} for ${flightList}${skippedNote}`}
          title={`${tracker.label} - ${flightList}${skippedNote}`}
        >
          <img alt="" src={tracker.icon} />
        </button>
      ))}
    </span>
  );
}
