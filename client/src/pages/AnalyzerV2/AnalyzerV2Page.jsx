import { useEffect, useRef, useState } from 'react';
import { analyzeDocuments, rebuildWithYear } from '../../api/analyzerV2.js';
import ResultsPanel from './components/ResultsPanel.jsx';
import UploadPanel from './components/UploadPanel.jsx';
import './AnalyzerV2Page.css';

const TIMER_TICK_MS = 250;

/**
 * Ticket Analyzer v2 - the specialist rebuild.
 *
 * There is no step machine here. The passenger-facing intake tool walks a
 * stranger through start -> method -> upload -> review because it is talking to
 * someone who has never seen it before; a specialist works dozens of cases a
 * day and wants the upload and the answer on one screen.
 *
 * All state that matters lives in this one component. The panels below are
 * presentational, which keeps "what the model read" in a single place - the
 * distinction that will matter as soon as inline correction lands.
 */
export default function AnalyzerV2Page() {
  const [files, setFiles] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [rebuilding, setRebuilding] = useState(false);

  const abortRef = useRef(null);
  const rebuildAbortRef = useRef(null);
  const timerRef = useRef(null);

  // An in-flight request must not outlive the page, and a stray interval must
  // not keep ticking after it. All are cleaned up together.
  useEffect(() => () => {
    abortRef.current?.abort();
    rebuildAbortRef.current?.abort();
    clearInterval(timerRef.current);
  }, []);

  const addFiles = (incoming) => {
    setError('');
    setFiles((current) => [...current, ...incoming].slice(0, 10));
  };

  const removeFile = (indexToRemove) => {
    setFiles((current) => current.filter((_, index) => index !== indexToRemove));
  };

  const clearAll = () => {
    abortRef.current?.abort();
    rebuildAbortRef.current?.abort();
    setFiles([]);
    setResult(null);
    setError('');
  };

  const runAnalysis = async () => {
    if (files.length === 0) {
      setError('Add at least one document first.');
      return;
    }

    abortRef.current?.abort();
    rebuildAbortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setAnalyzing(true);
    setError('');
    setResult(null);
    setElapsedSeconds(0);

    const startedAt = Date.now();
    timerRef.current = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, TIMER_TICK_MS);

    try {
      const payload = await analyzeDocuments({ files, signal: controller.signal });
      setResult(payload);
    } catch (requestError) {
      // An abort is the user clearing or leaving, not a failure to report.
      if (requestError.name !== 'AbortError') {
        setError(requestError.message || 'Analysis failed. Please try again.');
      }
    } finally {
      clearInterval(timerRef.current);
      setAnalyzing(false);
    }
  };

  // A specialist picked a different year on one flight. The server rebuilds the
  // whole trip from the facts the first run read - every assumed year moves with
  // it, and the trackers and the EOC check follow - so nothing is recomputed
  // here. A newer pick cancels an older one still on its way.
  const changeYear = async (legId, year) => {
    if (!result?.extraction) return;

    rebuildAbortRef.current?.abort();
    const controller = new AbortController();
    rebuildAbortRef.current = controller;

    setRebuilding(true);
    setError('');

    try {
      const rebuilt = await rebuildWithYear({
        extraction: result.extraction,
        yearPin: { legId, year },
        signal: controller.signal
      });
      // Nothing was spent on a rebuild, so the footer keeps the original run's
      // time, cost and model.
      setResult((previous) => ({
        ...rebuilt,
        processingTimeMs: previous?.processingTimeMs,
        costUSD: previous?.costUSD,
        model: previous?.model
      }));
    } catch (requestError) {
      if (requestError.name !== 'AbortError') {
        setError(requestError.message || 'The year could not be changed. Please try again.');
      }
    } finally {
      if (rebuildAbortRef.current === controller) setRebuilding(false);
    }
  };

  return (
    <div className="analyzer-v2">
      <header className="av2-header">
        <h1 className="av2-header__title">Ticket Analyzer v2</h1>
        <p className="av2-header__subtitle">
          Upload the documents on a case. The server reconstructs the booking,
          the flights that were not taken, and what replaced them.
        </p>
      </header>

      <UploadPanel
        files={files}
        onFilesAdded={addFiles}
        onFileRemoved={removeFile}
        onClear={clearAll}
        onAnalyze={runAnalysis}
        analyzing={analyzing}
        elapsedSeconds={elapsedSeconds}
      />

      {error && (
        <p className="av2-error" role="alert">{error}</p>
      )}

      {result && (
        <>
          <ResultsPanel result={result} onChangeYear={changeYear} rebuilding={rebuilding} />

          {/* Cost and model are shown because this is a staff tool and the
              person running it is choosing how to spend the budget. The
              passenger-facing intake deliberately hides both. */}
          <footer className="av2-runmeta">
            {typeof result.processingTimeMs === 'number' && (
              <span>{(result.processingTimeMs / 1000).toFixed(1)}s</span>
            )}
            {typeof result.costUSD === 'number' && (
              <span>${result.costUSD.toFixed(4)}</span>
            )}
            {result.model && <span>{result.model}</span>}
          </footer>
        </>
      )}
    </div>
  );
}
