import { logTrackerSearch } from '../../../api/trackerOverrides.js';
import { formatDate, formatTrackerUnavailable } from '../analyzerV2Utils.js';

/**
 * The flight trackers for one flight, as a row of round icon buttons under the
 * AIR line: all three at once, then AirportInfo, FlightStats and Flightera.
 *
 * The links come from the server (Step 4c in analyzerV2Controller.js), which
 * knows the search code each tracker wants for the airline. This only opens
 * them, and tells the usage log which one was opened - the same record the
 * Flight Search tool writes, so a search made here counts the same way.
 *
 * The three are real links, so a specialist can middle-click or ctrl-click them
 * and a single click is never caught by a popup blocker. Only "all three" opens
 * windows itself, which is the one place a browser may ask.
 *
 * A flight with no full date, or with two flight numbers printed in one row,
 * cannot be looked up: the same row renders dimmed, saying why.
 */
const TRACKERS = [
  { key: 'airportInfo', label: 'AirportInfo', icon: '/images/tracker-airportinfo.ico' },
  { key: 'flightStats', label: 'FlightStats', icon: '/images/tracker-flightstats.png' },
  { key: 'flightera', label: 'Flightera', icon: '/images/tracker-flightera.png' }
];

const SEARCH_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

export default function TrackerCircles({ flight }) {
  const trackers = flight?.trackers;
  if (!trackers) return null;

  // "BA568 on Mon, 24 Aug 2026" - so every button says which flight it opens.
  const flightLabel = [flight.flightNumber, formatDate(flight.date)].filter(Boolean).join(' on ');

  if (trackers.unavailable) {
    const reason = formatTrackerUnavailable(trackers.unavailable);

    return (
      <span className="av2-trackers">
        <span className="av2-tracker av2-tracker--all av2-tracker--off" aria-hidden="true" title={reason}>
          {SEARCH_ICON}
        </span>
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

  const logSearch = (keys) => logTrackerSearch({
    flightNumber: flight.flightNumber,
    date: flight.date,
    trackers: keys
  });

  const openAll = () => {
    TRACKERS.forEach((tracker) => window.open(trackers[tracker.key], '_blank', 'noopener'));
    logSearch(TRACKERS.map((tracker) => tracker.key));
  };

  return (
    <span className="av2-trackers">
      <button
        className="av2-tracker av2-tracker--all"
        type="button"
        onClick={openAll}
        aria-label={`Open all three trackers for ${flightLabel}`}
        title={`All three trackers - ${flightLabel}`}
      >
        {SEARCH_ICON}
      </button>
      {TRACKERS.map((tracker) => (
        <a
          key={tracker.key}
          className="av2-tracker"
          href={trackers[tracker.key]}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => logSearch([tracker.key])}
          aria-label={`${tracker.label} for ${flightLabel}`}
          title={`${tracker.label} - ${flightLabel}`}
        >
          <img alt="" src={tracker.icon} />
        </a>
      ))}
    </span>
  );
}
