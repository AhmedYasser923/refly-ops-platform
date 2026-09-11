import { useState } from 'react';
import EditButton from './EditButton.jsx';
import {
  LEG_FLAG_LABELS,
  editKey,
  formatDate,
  insteadOfLabel,
  routeOfLeg
} from '../claimIntakeUtils.js';

// Three fields is the whole form for a flight. There is no time here: the
// engine has none, and asking a passenger to transcribe a clock off a boarding
// pass was the single biggest source of wrong answers.
const BASE_FIELDS = [
  { field: 'marketingAirline', label: 'Airline', placeholder: 'e.g. Iberia', type: 'text' },
  { field: 'flightNumber', label: 'Flight number', placeholder: 'e.g. IB0550', type: 'text' },
  { field: 'departureDate', label: 'Date', placeholder: '', type: 'date' }
];

// Only asked for when we could not read them — otherwise the route is a
// heading, not a form field.
const ROUTE_FIELDS = [
  { field: 'departureIata', label: 'From', placeholder: 'Airport code', type: 'text' },
  { field: 'arrivalIata', label: 'To', placeholder: 'Airport code', type: 'text' }
];

// Rows the passenger added by hand can be taken away again; rows read from a
// document cannot. Removing an extracted flight is a claim-shaping decision,
// and the disruption questions are where it belongs — not a small x here.
const isAdded = (leg) => String(leg.id).startsWith('leg-added-');

export default function FlightRow({ leg, index, value, onChange, onRemove, rootLegId }) {
  const from = value(leg, 'departureIata');
  const to = value(leg, 'arrivalIata');
  const fields = from && to ? BASE_FIELDS : [...ROUTE_FIELDS, ...BASE_FIELDS];
  const canRemove = Boolean(onRemove) && isAdded(leg);

  // A flight we could not read fully opens itself. Nobody should have to hunt
  // for the field that needs them.
  const [editing, setEditing] = useState(() => fields.some(({ field }) => !value(leg, field)));

  const date = value(leg, 'departureDate');
  const airline = value(leg, 'marketingAirline');
  const flightNumber = value(leg, 'flightNumber');

  // Inside a replacement group the heading already names the flight being stood
  // in for. Only a flight that replaced a sibling needs to say so itself.
  const instead = leg.insteadOf && leg.insteadOf.legId === rootLegId
    ? ''
    : insteadOfLabel(leg.insteadOf);
  const chips = (leg.flags || []).filter((flag) => LEG_FLAG_LABELS[flag]);

  const summary = [airline, flightNumber].filter(Boolean).join(' · ');

  return (
    <article className={`ci-flight${leg.flown === false ? ' is-not-flown' : ''}`}>
      <header className="ci-flight__head">
        <span className="ci-flight__number" aria-hidden="true">{index + 1}</span>
        <div className="ci-flight__title">
          <p className="ci-flight__route">
            {routeOfLeg({
              departureIata: from,
              departureCity: leg.departureCity,
              arrivalIata: to,
              arrivalCity: leg.arrivalCity
            })}
          </p>
          {date && <p className="ci-flight__date">{formatDate(date)}</p>}
        </div>
        <EditButton
          editing={editing}
          label={`this flight, ${routeOfLeg({ departureIata: from, arrivalIata: to })}`}
          onClick={() => setEditing((current) => !current)}
        />
        {canRemove && (
          <button
            aria-label="Remove this flight"
            className="ci-flight__remove"
            onClick={() => onRemove(leg.id)}
            type="button"
          >
            ×
          </button>
        )}
      </header>

      {(leg.flown === false || instead || chips.length > 0) && (
        <div className="ci-chips">
          {leg.flown === false && <span className="ci-chip ci-chip--muted">Not flown</span>}
          {instead && <span className="ci-chip">{instead}</span>}
          {chips.map((flag) => (
            <span className="ci-chip ci-chip--attention" key={flag}>{LEG_FLAG_LABELS[flag]}</span>
          ))}
        </div>
      )}

      {editing ? (
        <div className="ci-fields">
          {fields.map(({ field, label, placeholder, type }) => {
            const id = `${leg.id}-${field}`;
            const current = value(leg, field);

            return (
              <div className={`ci-field${current ? '' : ' is-empty'}`} key={field}>
                <label className="ci-field__label" htmlFor={id}>{label}</label>
                <input
                  className="ci-field__input"
                  id={id}
                  onChange={(event) => onChange(editKey(leg.id, field), event.target.value)}
                  placeholder={placeholder}
                  type={type}
                  value={current}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <p className="ci-flight__summary">{summary || 'Flight details missing'}</p>
      )}
    </article>
  );
}
