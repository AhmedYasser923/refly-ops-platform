import {
  describeEvent,
  formatDaysLater,
  formatPlaceRoute
} from '../analyzerV2Utils.js';

/**
 * "What happened" - the booked route against the flown route, then the ordered
 * list of decisions that turned one into the other.
 *
 * WHY IT IS GATED
 *   It renders only when `story.changedRoute` is true. A straightforward
 *   rebooking onto a later flight on the SAME route is already fully described
 *   by the flight rows themselves; narrating it as well just says the same
 *   thing twice in different words. The diff earns its place only when the
 *   shape of the trip actually changed.
 *
 * WHY THERE IS NO VERDICT LINE
 *   It describes, it does not assess. The old analyzer printed things like
 *   ">=3h - likely EC261 eligible" into the card, which is a legal conclusion
 *   dressed as a caption. Eligibility is coming back as its own clearly-labelled
 *   section - see orientation/analyzer-v2.md - and not as a sentence buried in
 *   a narrative.
 */
export default function DisruptionStory({ story }) {
  if (!story || !story.changedRoute) return null;

  const events = Array.isArray(story.events) ? story.events : [];
  const daysLate = formatDaysLater(story.outcome?.daysLate);
  const extraStops = story.outcome?.extraStopCount || 0;

  return (
    <section className="av2-story" aria-label="What happened">
      <h4 className="av2-story__title">What happened</h4>

      <dl className="av2-story__diff">
        <div className="av2-story__diff-row">
          <dt>Booked</dt>
          <dd>{formatPlaceRoute(story.booked?.places)}</dd>
        </div>
        <div className="av2-story__diff-row av2-story__diff-row--flown">
          <dt>Flown</dt>
          <dd>{formatPlaceRoute(story.flown?.places)}</dd>
        </div>
      </dl>

      {events.length > 0 && (
        <ol className="av2-story__events">
          {events.map((event) => (
            <li key={event.id}>{describeEvent(event)}</li>
          ))}
        </ol>
      )}

      {(daysLate || extraStops > 0) && (
        <p className="av2-story__outcome">
          {[
            extraStops > 0 && `${extraStops} extra ${extraStops === 1 ? 'stop' : 'stops'}`,
            daysLate && `arrived ${daysLate}`
          ].filter(Boolean).join(', ')}
          .
        </p>
      )}
    </section>
  );
}
