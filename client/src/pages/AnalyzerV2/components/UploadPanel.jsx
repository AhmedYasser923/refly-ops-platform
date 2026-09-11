import { useRef, useState } from 'react';
import { formatFileSize } from '../analyzerV2Utils.js';

const ACCEPTED_TYPES = 'image/*,application/pdf';
const MAX_FILES = 10;

/**
 * File selection: drop, browse, review, analyse.
 *
 * The drop target is a real <button>, not a div wearing `role="button"`. The old
 * analyzer nests an <h2> and a file input inside its role="button" wrapper,
 * which is invalid to a screen reader - a button cannot contain a heading.
 * Here the button is the button, and the caption sits outside it.
 */
export default function UploadPanel({
  files,
  onFilesAdded,
  onFileRemoved,
  onClear,
  onAnalyze,
  analyzing,
  elapsedSeconds
}) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const acceptFiles = (fileList) => {
    const incoming = Array.from(fileList || []);
    if (incoming.length > 0) onFilesAdded(incoming);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    acceptFiles(event.dataTransfer?.files);
  };

  const atLimit = files.length >= MAX_FILES;

  return (
    <section className="av2-upload" aria-label="Upload documents">
      <div
        className={`av2-dropzone${dragging ? ' av2-dropzone--active' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <button
          type="button"
          className="av2-dropzone__button"
          onClick={() => inputRef.current?.click()}
          disabled={analyzing || atLimit}
        >
          Choose documents
        </button>

        <p className="av2-dropzone__hint">
          {atLimit
            ? `Limit of ${MAX_FILES} files reached.`
            : `or drop them here — images and PDFs, up to ${MAX_FILES} files`}
        </p>

        <input
          ref={inputRef}
          type="file"
          className="av2-dropzone__input"
          accept={ACCEPTED_TYPES}
          multiple
          onChange={(event) => {
            acceptFiles(event.target.files);
            // Lets the same file be picked again after being removed.
            event.target.value = '';
          }}
        />
      </div>

      {files.length > 0 && (
        <>
          <ul className="av2-filelist">
            {files.map((file, index) => (
              <li key={`${file.name}-${file.size}-${index}`} className="av2-filelist__item">
                <span className="av2-filelist__name">{file.name}</span>
                <span className="av2-filelist__size">{formatFileSize(file.size)}</span>
                <button
                  type="button"
                  className="av2-filelist__remove"
                  onClick={() => onFileRemoved(index)}
                  disabled={analyzing}
                  aria-label={`Remove ${file.name}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>

          <div className="av2-upload__actions">
            <button
              type="button"
              className="av2-button av2-button--primary"
              onClick={onAnalyze}
              disabled={analyzing}
            >
              {analyzing
                ? `Analysing… ${elapsedSeconds}s`
                : `Analyse ${files.length} ${files.length === 1 ? 'document' : 'documents'}`}
            </button>
            <button
              type="button"
              className="av2-button"
              onClick={onClear}
              disabled={analyzing}
            >
              Clear
            </button>
          </div>
        </>
      )}
    </section>
  );
}
