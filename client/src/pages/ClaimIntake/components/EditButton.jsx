// A pencil, plus the word. The icon alone is compact but ambiguous to someone
// who does not already know the convention, and this screen is aimed at people
// filing a claim rather than people who use apps all day.
function PencilIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="15" viewBox="0 0 16 16" width="15">
      <path
        d="M2.6 11.3 10.9 3a1.9 1.9 0 0 1 2.7 2.7l-8.3 8.3-3.4.7.7-3.4Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
      <path d="M9.5 4.4 12.2 7.1" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  );
}

function TickIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="15" viewBox="0 0 16 16" width="15">
      <path
        d="M3.4 8.6 6.4 11.6 12.6 4.8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export default function EditButton({ label, editing, onClick }) {
  return (
    <button
      aria-label={editing ? `Finish editing ${label}` : `Edit ${label}`}
      className={`ci-edit${editing ? ' is-editing' : ''}`}
      onClick={onClick}
      type="button"
    >
      <span className="ci-edit__icon">{editing ? <TickIcon /> : <PencilIcon />}</span>
      <span className="ci-edit__text">{editing ? 'Done' : 'Edit'}</span>
    </button>
  );
}
