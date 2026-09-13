import { useEffect, useRef, useState } from 'react';

/**
 * The year of a flight whose document did not print one, as a button that
 * opens a list of years.
 *
 * Picking a year does not change anything here. It asks the page to rebuild
 * the analysis with that year (AnalyzerV2Page's changeYear), and the server
 * moves every assumed year with it - keeping a December flight and a January
 * return a year apart in either direction - then re-runs the trackers and the
 * EOC check. This only offers the choice, because a year decides the order of
 * the flights and the client never decides that.
 *
 * FlightRow renders it only where the year was assumed. A year the document
 * printed is plain text: the paper said it.
 *
 * The list runs from next year back ten years, which covers the longest claim
 * limit a specialist works with (Sweden's ten years). A year outside that is
 * still shown, and listed, if that is what the flight currently carries.
 */
const YEARS_BACK = 10;
const YEARS_AHEAD = 1;

export default function YearPicker({ year, flightLabel, onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

  const thisYear = new Date().getFullYear();
  const years = Array.from(
    { length: YEARS_BACK + YEARS_AHEAD + 1 },
    (_, offset) => thisYear + YEARS_AHEAD - offset
  );
  if (!years.includes(year)) years.push(year);
  years.sort((first, second) => second - first);

  // Closes on a click anywhere else and on Escape, like any other menu.
  useEffect(() => {
    if (!open) return undefined;

    const closeOnOutsideClick = (event) => {
      if (!wrapperRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const choose = (chosenYear) => {
    setOpen(false);
    if (chosenYear !== year) onChange(chosenYear);
  };

  return (
    <span className="av2-year" ref={wrapperRef}>
      <button
        type="button"
        className="av2-year__button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Year ${year}, not printed on the document. Change the year for ${flightLabel}`}
        title="Year not printed on the document - click to change it"
      >
        {year}
      </button>

      {open && (
        <ul className="av2-year__list" role="listbox" aria-label="Choose a year">
          {years.map((listedYear) => (
            <li key={listedYear} role="option" aria-selected={listedYear === year}>
              <button
                type="button"
                className={`av2-year__option${listedYear === year ? ' av2-year__option--current' : ''}`}
                onClick={() => choose(listedYear)}
              >
                {listedYear}
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
