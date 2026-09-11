import { useCallback, useMemo, useRef, useState } from 'react';
import { buildManualItinerary, extractClaimIntake } from '../../api/claimIntake.js';
import StartStep from './components/StartStep.jsx';
import MethodStep from './components/MethodStep.jsx';
import ManualStep from './components/ManualStep.jsx';
import UploadStep from './components/UploadStep.jsx';
import ReviewStep from './components/ReviewStep.jsx';
import { MAX_FILES, applyLegEdits, resolveValue } from './claimIntakeUtils.js';
import './ClaimIntakePage.css';

// 'questions' and 'summary' land after 'review'.
const STEPS = ['start', 'method', 'manual', 'upload', 'extracting', 'review'];

const emptyPassenger = (index) => ({
  id: `passenger-added-${index}`,
  firstName: '',
  lastName: ''
});

// A flight the passenger types or adds by hand. The honest answer to
// "extraction that works for every document" is a screen where a bad reading is
// still one tap from correct, so nothing here is ever a dead end.
const emptyFlight = (index) => ({
  id: `leg-added-${index}`,
  flightNumber: '',
  marketingAirline: '',
  departureIata: '',
  departureCity: '',
  arrivalIata: '',
  arrivalCity: '',
  departureDate: '',
  flown: true,
  flags: [],
  insteadOf: null
});

export default function ClaimIntakePage({ isActive = true }) {
  const [step, setStep] = useState('start');
  // What the passenger said their trip was. Never overrides what the documents
  // show — it shapes the manual form and lets the review screen flag a mismatch.
  const [tripShape, setTripShape] = useState('');
  const [files, setFiles] = useState([]);
  const [extraction, setExtraction] = useState(null);
  // Corrections are kept apart from what the model read, so "extracted" and
  // "confirmed by the passenger" never blur together.
  const [edits, setEdits] = useState({});
  const [addedPassengers, setAddedPassengers] = useState([]);
  const [addedFlights, setAddedFlights] = useState([]);
  const [manualFlights, setManualFlights] = useState([]);
  const [error, setError] = useState('');
  const abortRef = useRef(null);
  const nextId = useRef(0);

  const newFlight = useCallback(() => {
    nextId.current += 1;
    return emptyFlight(nextId.current);
  }, []);

  const addFiles = useCallback((incoming) => {
    setError('');
    setFiles((current) => [...current, ...incoming].slice(0, MAX_FILES));
  }, []);

  const removeFile = useCallback((index) => {
    setFiles((current) => current.filter((_, i) => i !== index));
  }, []);

  const changeField = useCallback((key, value) => {
    setEdits((current) => ({ ...current, [key]: value }));
  }, []);

  const addPassenger = useCallback(() => {
    setAddedPassengers((current) => [...current, emptyPassenger(current.length + 1)]);
  }, []);

  const addFlight = useCallback((section) => {
    setAddedFlights((current) => [...current, { ...newFlight(), section }]);
  }, [newFlight]);

  // Only ever called for a flight the passenger added or typed themselves.
  const removeFlight = useCallback((id) => {
    setAddedFlights((current) => current.filter((flight) => flight.id !== id));
    setManualFlights((current) => current.filter((flight) => flight.id !== id));
  }, []);

  const resetResult = useCallback(() => {
    setExtraction(null);
    setEdits({});
    setAddedPassengers([]);
    setAddedFlights([]);
  }, []);

  const startOver = useCallback(() => {
    abortRef.current?.abort();
    setStep('start');
    setTripShape('');
    setFiles([]);
    setManualFlights([]);
    setError('');
    resetResult();
  }, [resetResult]);

  const chooseShape = useCallback((shape) => {
    setTripShape(shape);
    setStep('method');
  }, []);

  const chooseMethod = useCallback((method) => {
    setError('');

    if (method === 'upload') {
      setStep('upload');
      return;
    }

    // A connecting trip starts with two rows because that is the minimum it can
    // be; a direct one starts with the single flight it is.
    const rows = tripShape === 'connecting' ? [newFlight(), newFlight()] : [newFlight()];
    setManualFlights(rows);
    setAddedPassengers([emptyPassenger(1)]);
    setStep('manual');
  }, [tripShape, newFlight]);

  const submitUpload = useCallback(async () => {
    if (files.length === 0) return;

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setStep('extracting');
    setError('');

    try {
      const result = await extractClaimIntake({ files, signal: abortRef.current.signal });
      resetResult();
      setExtraction(result);
      setStep('review');
    } catch (err) {
      if (err.name === 'AbortError') return;
      setError(err.message);
      setStep('upload');
    }
  }, [files, resetResult]);

  const submitManual = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setError('');

    try {
      const result = await buildManualItinerary({
        legs: applyLegEdits(manualFlights, edits),
        passengers: applyLegEdits(addedPassengers, edits),
        signal: abortRef.current.signal
      });
      resetResult();
      setExtraction(result);
      setStep('review');
    } catch (err) {
      if (err.name === 'AbortError') return;
      setError(err.message);
    }
  }, [manualFlights, addedPassengers, edits, resetResult]);

  const passengers = useMemo(
    () => [...(extraction?.passengers || []), ...addedPassengers],
    [extraction, addedPassengers]
  );

  const value = useCallback(
    (entity, field) => resolveValue(edits, entity, field),
    [edits]
  );

  // Flights the passenger adds appear at the end of the list they were added to.
  const bookingFlights = useCallback(
    (journey) => {
      const isLast = extraction?.booking?.journeys?.at(-1)?.id === journey.id;
      const extras = isLast ? addedFlights.filter((flight) => flight.section === 'booking') : [];
      return [...journey.legs, ...extras];
    },
    [extraction, addedFlights]
  );

  const addedReplacementFlights = useMemo(
    () => addedFlights.filter((flight) => flight.section === 'replacement'),
    [addedFlights]
  );

  const hasFlights = extraction && !extraction.noFlightData;

  return (
    <div className="ci-root">
      <div className="ci-shell">
        {step === 'start' && <StartStep onChoose={chooseShape} />}

        {step === 'method' && (
          <MethodStep onBack={() => setStep('start')} onChoose={chooseMethod} tripShape={tripShape} />
        )}

        {step === 'manual' && (
          <ManualStep
            error={error}
            flights={manualFlights}
            onAddFlight={() => setManualFlights((current) => [...current, newFlight()])}
            onAddPassenger={addPassenger}
            onBack={() => setStep('method')}
            onChange={changeField}
            onRemoveFlight={removeFlight}
            onSubmit={submitManual}
            passengers={addedPassengers}
            tripShape={tripShape}
            value={value}
          />
        )}

        {(step === 'upload' || step === 'extracting') && (
          <UploadStep
            active={isActive && step === 'upload'}
            busy={step === 'extracting'}
            error={error}
            files={files}
            onAddFiles={addFiles}
            onBack={() => setStep('method')}
            onRemoveFile={removeFile}
            onSubmit={submitUpload}
          />
        )}

        {step === 'review' && !hasFlights && (
          <div className="ci-step">
            <header className="ci-step__header">
              <h1 className="ci-step__title">We couldn&apos;t find any flights</h1>
              <p className="ci-step__lead">
                That document didn&apos;t contain flight details we could read. Try your booking
                confirmation email or a boarding pass, or type the flights in yourself.
              </p>
            </header>
            <div className="ci-actions">
              <button className="ci-button ci-button--primary" onClick={startOver} type="button">
                Start again
              </button>
            </div>
          </div>
        )}

        {step === 'review' && hasFlights && (
          <ReviewStep
            addedReplacementFlights={addedReplacementFlights}
            bookingFlights={bookingFlights}
            extraction={extraction}
            onAddFlight={addFlight}
            onAddPassenger={addPassenger}
            onChange={changeField}
            onRemoveFlight={removeFlight}
            onStartOver={startOver}
            passengers={passengers}
            replacementItineraries={extraction.replacementItineraries || []}
            tripShape={tripShape}
            value={value}
          />
        )}
      </div>
    </div>
  );
}

export { STEPS };
