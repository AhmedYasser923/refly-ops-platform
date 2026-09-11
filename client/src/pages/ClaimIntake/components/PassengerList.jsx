import { useState } from 'react';
import EditButton from './EditButton.jsx';
import { editKey, passengerLabel } from '../claimIntakeUtils.js';

const FIELDS = [
  { field: 'firstName', label: 'First name', placeholder: 'As printed on the ticket' },
  { field: 'lastName', label: 'Last name', placeholder: 'As printed on the ticket' }
];

function PassengerRow({ passenger, index, value, onChange }) {
  const name = passengerLabel({
    firstName: value(passenger, 'firstName'),
    lastName: value(passenger, 'lastName')
  });

  // A passenger we could not read — or one the traveller just added — opens
  // itself, because there is nothing to read and everything to type.
  const [editing, setEditing] = useState(() => FIELDS.some(({ field }) => !value(passenger, field)));

  return (
    <li className="ci-passenger">
      <span className="ci-passenger__index" aria-hidden="true">{index + 1}</span>
      <div className="ci-passenger__body">
        <div className="ci-passenger__head">
          <p className="ci-passenger__name">{name}</p>
          <EditButton
            editing={editing}
            label={`the name ${name}`}
            onClick={() => setEditing((current) => !current)}
          />
        </div>

        {editing && (
          <div className="ci-fields">
            {FIELDS.map(({ field, label, placeholder }) => {
              const id = `${passenger.id}-${field}`;
              const current = value(passenger, field);

              return (
                <div className={`ci-field${current ? '' : ' is-empty'}`} key={field}>
                  <label className="ci-field__label" htmlFor={id}>{label}</label>
                  <input
                    className="ci-field__input"
                    id={id}
                    onChange={(event) => onChange(editKey(passenger.id, field), event.target.value)}
                    placeholder={placeholder}
                    type="text"
                    value={current}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </li>
  );
}

export default function PassengerList({ passengers, value, onChange, onAddPassenger }) {
  return (
    <section className="ci-card">
      <header className="ci-card__header">
        <h2 className="ci-card__title">Who was travelling?</h2>
        <p className="ci-card__lead">
          Check the names match the ID each passenger travelled with, and add anyone we missed.
        </p>
      </header>

      {passengers.length === 0 && (
        <p className="ci-card__empty">We couldn&apos;t read any passenger names. Add them below.</p>
      )}

      <ul className="ci-passengers">
        {passengers.map((passenger, index) => (
          <PassengerRow
            index={index}
            key={passenger.id}
            onChange={onChange}
            passenger={passenger}
            value={value}
          />
        ))}
      </ul>

      <button className="ci-button ci-button--ghost" onClick={onAddPassenger} type="button">
        + Add another passenger
      </button>
    </section>
  );
}
