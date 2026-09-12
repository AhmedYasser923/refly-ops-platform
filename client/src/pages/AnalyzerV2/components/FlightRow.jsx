import AirlineName from './AirlineName.jsx';
import RouteBlock from './RouteBlock.jsx';
import {
  flagTone,
  formatDate,
  formatFlag
} from '../analyzerV2Utils.js';

/**
 * One flight, rendered the same way wherever it appears - inside the booking or
 * inside a replacement group.
 *
 * Deliberately one component for both. In the old analyzer the origin block and
 * the destination block were two near-identical 17-line copies of each other,
 * which is how they drifted apart. One row, one set of rules.
 *
 * Dense on purpose: this is a staff tool. Everything a specialist checks -
 * flight number, both carriers, route, date, PNR - is visible without a click.
 */
// Flags the engine raises that deliberately never become a chip.
//
//   REPLACED      says exactly what `flown: false` already says, and that
//                 renders the "Not flown" chip below. One fact, one chip.
//   ASSUMED_YEAR  fires on every leg of a document that printed a day and month
//                 but no year - which is most boarding passes - so it tags a
//                 whole itinerary at once and stops meaning anything. The
//                 warning above the results already names the year that was
//                 used and says to correct it, which is the actionable form.
//
// Both still exist on the leg data; they are just not worth a badge.
const NEVER_CHIPPED = ['REPLACED', 'ASSUMED_YEAR'];

export default function FlightRow({ leg, muted = false, suppressFlags = [], showRoute = true }) {
  const notFlown = leg.flown === false;

  // What the document printed where the pipeline kept nothing - see Step 8b.
  // Listed in full on the row rather than hidden behind a hover: this is the one
  // thing on the screen that says the tool got something wrong, and a specialist
  // cannot correct what they are not shown.
  const unreadable = Array.isArray(leg.unreadable) ? leg.unreadable : [];
  const dateWasUnreadable = unreadable.some((entry) => entry.field === 'date');

  // `suppressFlags` handles the contextual case: inside a replacement group the
  // heading has already said these are replacements, so the chip is noise.
  const hiddenFlags = new Set([...NEVER_CHIPPED, ...suppressFlags]);
  const flags = (Array.isArray(leg.flags) ? leg.flags : [])
    .filter((flag) => !hiddenFlags.has(flag));

  // Only worth showing when they differ. On the overwhelming majority of legs
  // the marketing and operating carrier are the same airline, and printing it
  // twice is noise that hides the codeshares that matter.
  const operatedByOther = Boolean(
    leg.operatingAirline &&
    leg.marketingAirline &&
    leg.operatingAirline !== leg.marketingAirline
  );

  const rowClassName = [
    'av2-flight',
    muted || notFlown ? 'av2-flight--muted' : ''
  ].filter(Boolean).join(' ');

  return (
    <li className={rowClassName}>
      <div className="av2-flight__header">
        <div className="av2-flight__id">
          <span className="av2-flight__number">{leg.flightNumber || '—'}</span>
          {/* Each name opens its airline's card on hover - see AirlineName. */}
          <AirlineName
            className="av2-flight__airline"
            name={leg.marketingAirline || 'Unknown airline'}
            details={leg.marketingAirlineDetails}
          />
          {operatedByOther && (
            <span className="av2-flight__operated">
              operated by{' '}
              <AirlineName name={leg.operatingAirline} details={leg.operatingAirlineDetails} />
            </span>
          )}
        </div>

        <div className="av2-flight__meta">
          {/* "No date" is only true when the document printed none. When it
              printed one we could not read, saying "No date" states the
              opposite of what the paper says. */}
          <span className={`av2-flight__date${dateWasUnreadable ? ' av2-flight__date--unreadable' : ''}`}>
            {formatDate(leg.departureDate) || (dateWasUnreadable ? 'Date unreadable' : 'No date')}
          </span>
          {leg.pnr && <span className="av2-flight__pnr">{leg.pnr}</span>}
        </div>
      </div>

      {/* The old analyzer's route layout - the same block the journey heading
          uses, here for this one flight. Left out when the heading already
          shows exactly these two airports: on a direct trip a second block
          would only repeat it. */}
      {showRoute && (
        <RouteBlock
          from={{
            iata: leg.departureIata,
            airportName: leg.departureAirportName,
            city: leg.departureCity,
            country: leg.departureCountry,
            eoc: leg.departureEoc
          }}
          to={{
            iata: leg.arrivalIata,
            airportName: leg.arrivalAirportName,
            city: leg.arrivalCity,
            country: leg.arrivalCountry,
            eoc: leg.arrivalEoc
          }}
          distanceKm={leg.distanceKm}
          compensation={leg.compensation}
          flight={{ flightNumber: leg.flightNumber, date: leg.departureDate, trackers: leg.trackers }}
        />
      )}

      {/* Normally every traveller on a flight shares one booking reference and
          it sits in the line above. When they genuinely differ there is no such
          code, so the individual ones are listed here instead.

          Shown inline rather than behind a disclosure: this is the anomaly on
          the screen, and a specialist checking a claim should not have to go
          looking for it. It stays rare - on the Kiwi case one segment in four. */}
      {leg.pnrIsSplit && (
        <ul className="av2-flight__split-pnrs">
          {leg.travellers.map((traveller) => (
            <li key={traveller.passengerName}>
              <span className="av2-flight__split-name">{traveller.passengerName}</span>
              <span className="av2-flight__split-code">{traveller.pnr || '—'}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Each line names the field, quotes what the document printed, and says
          plainly that we could not read it. The printed text is the whole point:
          "01Oct" on the screen turns a mystery into a two-second fix. */}
      {unreadable.length > 0 && (
        <ul className="av2-flight__unreadable">
          {unreadable.map((entry) => (
            <li key={`${entry.field}-${entry.printed}`}>
              <span className="av2-flight__unreadable-field">{entry.field}</span>
              <span className="av2-flight__unreadable-printed">{entry.printed}</span>
              <span className="av2-flight__unreadable-note">printed here, but we could not read it</span>
            </li>
          ))}
        </ul>
      )}

      {(notFlown || flags.length > 0) && (
        <ul className="av2-chips">
          {notFlown && <li className="av2-chip av2-chip--muted">Not flown</li>}
          {flags.map((flag) => (
            <li key={flag} className={`av2-chip av2-chip--${flagTone(flag)}`}>
              {formatFlag(flag)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
