import { useId, useState } from 'react';
import { formatCompensation, formatDistance } from '../analyzerV2Utils.js';

/**
 * The distance over the AIR line. When the server priced it, the figure is
 * underlined and hovering or focusing it shows what that distance is worth.
 *
 * The amount comes from the server (Step 4d in analyzerV2Controller.js). This
 * only shows it.
 */
export default function RouteDistance({ distanceKm, compensation }) {
  const [cardOpen, setCardOpen] = useState(false);
  const cardId = useId();

  const distance = formatDistance(distanceKm);
  if (!distance) return null;
  if (!compensation) return <span className="av2-route__distance">{distance}</span>;

  return (
    <span
      className="av2-route__measure"
      onMouseEnter={() => setCardOpen(true)}
      onMouseLeave={() => setCardOpen(false)}
    >
      <span
        className="av2-route__distance av2-route__distance--payable"
        tabIndex={0}
        aria-describedby={cardId}
        onFocus={() => setCardOpen(true)}
        onBlur={() => setCardOpen(false)}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === 'Escape') setCardOpen(false);
        }}
      >
        {distance}
      </span>
      <span id={cardId} role="tooltip" className="av2-comp-card" hidden={!cardOpen}>
        <span className="av2-comp-card__amount">{formatCompensation(compensation)}</span>
      </span>
    </span>
  );
}
