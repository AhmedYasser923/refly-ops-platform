import { routeText, storyNarrative } from '../claimIntakeUtils.js';

// The booked route against the flown one, with any airport that only exists
// because of the disruption called out. Seeing "ZRH → BEG" become
// "ZRH → AMS → BEG" says more than any sentence can. Only ever rendered when
// the two actually differ — see ReviewStep.
function RouteDiff({ story }) {
  const addedStops = story.outcome.addedStops || [];

  return (
    <div className="ci-story__routes">
      <div className="ci-story__route">
        <span className="ci-story__route-label">Booked</span>
        <span className="ci-story__route-value">{routeText(story.booked.places)}</span>
      </div>
      <div className="ci-story__route ci-story__route--actual">
        <span className="ci-story__route-label">Flown</span>
        <span className="ci-story__route-value">
          {(story.flown.places || []).map((place, index) => {
            const name = place.city || place.iata;
            if (!name) return null;
            const added = addedStops.includes(place.iata);

            return (
              <span key={`${place.iata}-${index}`}>
                {index > 0 && <span className="ci-story__arrow"> → </span>}
                <span className={added ? 'ci-story__stop is-added' : 'ci-story__stop'}>{name}</span>
              </span>
            );
          })}
        </span>
      </div>
    </div>
  );
}

// A plain description of what happened. No summing-up line, and no times —
// the engine has none to give.
export default function JourneyStory({ story }) {
  const narrative = storyNarrative(story);
  if (!narrative) return null;

  return (
    <section className="ci-story">
      <h4 className="ci-story__title">What happened</h4>

      <RouteDiff story={story} />

      {narrative.plan && <p className="ci-story__plan">{narrative.plan}</p>}

      <ol className="ci-story__events">
        {narrative.events.map((event, index) => (
          <li className="ci-story__event" key={event.id}>
            <span className="ci-story__step" aria-hidden="true">{index + 1}</span>
            <span className="ci-story__text">{event.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
