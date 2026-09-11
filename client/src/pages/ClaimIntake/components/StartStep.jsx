// The first question, and the only one asked before we have any facts.
//
// Note what this answer is NOT used for: the engine derives `journey.isDirect`
// from the airports and never takes the passenger's word for it. What the
// answer does is shape the next screen — how many flight rows manual entry
// starts with — and give the review screen something to check itself against.
// If someone says "one flight" and their documents show three, that is worth
// saying out loud rather than quietly overruling them.
const OPTIONS = [
  {
    shape: 'direct',
    title: 'One flight',
    lead: 'You flew straight there, with no change of plane.',
    icon: (
      <svg aria-hidden="true" fill="none" height="22" viewBox="0 0 32 22" width="32">
        <circle cx="4" cy="11" fill="currentColor" r="3.2" />
        <path d="M8 11h16" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
        <circle cx="28" cy="11" fill="currentColor" r="3.2" />
      </svg>
    )
  },
  {
    shape: 'connecting',
    title: 'More than one flight',
    lead: 'You changed planes on the way — one or more connections.',
    icon: (
      <svg aria-hidden="true" fill="none" height="22" viewBox="0 0 32 22" width="32">
        <circle cx="4" cy="11" fill="currentColor" r="3.2" />
        <path d="M8 11h5" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
        <circle cx="16" cy="11" fill="currentColor" r="3.2" />
        <path d="M19 11h5" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
        <circle cx="28" cy="11" fill="currentColor" r="3.2" />
      </svg>
    )
  }
];

export default function StartStep({ onChoose }) {
  return (
    <div className="ci-step">
      <header className="ci-step__header">
        <h1 className="ci-step__title">Tell us about your trip</h1>
        <p className="ci-step__lead">
          Start with the trip you booked, not what went wrong — we&apos;ll come to that.
        </p>
      </header>

      <div className="ci-choices">
        {OPTIONS.map(({ shape, title, lead, icon }) => (
          <button className="ci-choice" key={shape} onClick={() => onChoose(shape)} type="button">
            <span className="ci-choice__icon" aria-hidden="true">{icon}</span>
            <span className="ci-choice__body">
              <span className="ci-choice__title">{title}</span>
              <span className="ci-choice__lead">{lead}</span>
            </span>
            <span className="ci-choice__chevron" aria-hidden="true">›</span>
          </button>
        ))}
      </div>
    </div>
  );
}
