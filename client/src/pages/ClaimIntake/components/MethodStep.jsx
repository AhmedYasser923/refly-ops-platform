// Upload is listed first and described as the quick path, because it is: the
// passenger hands over a document they already have instead of transcribing
// airport codes off it. But typing it in is a first-class route, not a fallback
// for when extraction fails — some people do not have the document to hand, and
// some would simply rather type.
export default function MethodStep({ tripShape, onChoose, onBack }) {
  const flights = tripShape === 'direct' ? 'flight' : 'flights';

  return (
    <div className="ci-step">
      <button className="ci-back" onClick={onBack} type="button">
        <span aria-hidden="true">‹</span> Back
      </button>

      <header className="ci-step__header">
        <h1 className="ci-step__title">How would you like to add your {flights}?</h1>
        <p className="ci-step__lead">
          Either way you get to check everything before anything is submitted.
        </p>
      </header>

      <div className="ci-choices">
        <button className="ci-choice" onClick={() => onChoose('upload')} type="button">
          <span className="ci-choice__icon" aria-hidden="true">
            <svg fill="none" height="24" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="24">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" x2="12" y1="3" y2="15" />
            </svg>
          </span>
          <span className="ci-choice__body">
            <span className="ci-choice__title">
              Upload your booking
              <span className="ci-choice__badge">Quickest</span>
            </span>
            <span className="ci-choice__lead">
              A booking confirmation, e-ticket or boarding pass. We read the {flights} off it
              so you don&apos;t have to type anything.
            </span>
          </span>
          <span className="ci-choice__chevron" aria-hidden="true">›</span>
        </button>

        <button className="ci-choice" onClick={() => onChoose('manual')} type="button">
          <span className="ci-choice__icon" aria-hidden="true">
            <svg fill="none" height="24" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="24">
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
              <path d="M14 6l4 4" />
            </svg>
          </span>
          <span className="ci-choice__body">
            <span className="ci-choice__title">Type them in myself</span>
            <span className="ci-choice__lead">
              Airline, flight number and date for each flight. Takes a minute or two.
            </span>
          </span>
          <span className="ci-choice__chevron" aria-hidden="true">›</span>
        </button>
      </div>
    </div>
  );
}
