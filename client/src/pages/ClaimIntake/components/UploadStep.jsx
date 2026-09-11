import { useEffect, useRef, useState } from 'react';
import { MAX_FILES, acceptedFiles, formatFileSize } from '../claimIntakeUtils.js';

const UploadIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

const FileIcon = ({ isPdf }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {isPdf ? (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6" />
      </>
    ) : (
      <>
        <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
      </>
    )}
  </svg>
);

export default function UploadStep({ active, files, busy, error, onAddFiles, onBack, onRemoveFile, onSubmit }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!active) return undefined;

    const paste = (event) => {
      const items = event.clipboardData?.items;
      if (!items) return;

      const pasted = [];
      Array.from(items).forEach((item) => {
        if (!item.type.startsWith('image/') && item.type !== 'application/pdf') return;

        const file = item.getAsFile();
        if (!file) return;

        const extension = file.type.split('/')[1] || 'png';
        pasted.push(new File([file], `Pasted-${Date.now()}.${extension}`, { type: file.type }));
      });

      if (pasted.length > 0) onAddFiles(pasted);
    };

    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, [active, onAddFiles]);

  const openPicker = () => inputRef.current?.click();

  const pickFiles = (event) => {
    const picked = acceptedFiles(event.target.files);
    if (picked.length > 0) onAddFiles(picked);
    event.target.value = '';
  };

  const drop = (event) => {
    event.preventDefault();
    setDragging(false);
    const dropped = acceptedFiles(event.dataTransfer.files);
    if (dropped.length > 0) onAddFiles(dropped);
  };

  const isFull = files.length >= MAX_FILES;

  return (
    <div className="ci-step">
      {onBack && !busy && (
        <button className="ci-back" onClick={onBack} type="button">
          <span aria-hidden="true">‹</span> Back
        </button>
      )}

      <header className="ci-step__header">
        <h1 className="ci-step__title">Let&apos;s find your flights</h1>
        <p className="ci-step__lead">
          Upload your booking confirmation or boarding pass and we&apos;ll read your flight details for
          you.
        </p>
      </header>

      <div
        className={`ci-dropzone${dragging ? ' is-dragging' : ''}${isFull ? ' is-full' : ''}`}
        onClick={isFull ? undefined : openPicker}
        onDragLeave={() => setDragging(false)}
        onDragOver={(event) => {
          event.preventDefault();
          if (!isFull) setDragging(true);
        }}
        onDrop={isFull ? undefined : drop}
        onKeyDown={(event) => {
          if (isFull) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openPicker();
          }
        }}
        role="button"
        tabIndex={isFull ? -1 : 0}
      >
        <span className="ci-dropzone__icon"><UploadIcon /></span>
        <span className="ci-dropzone__title">
          {isFull ? `That's the maximum of ${MAX_FILES} documents` : 'Drag a file here, or click to choose'}
        </span>
        <span className="ci-dropzone__hint">PDF, JPG or PNG · up to {MAX_FILES} documents</span>
        <input
          ref={inputRef}
          accept="image/*,application/pdf"
          className="ci-dropzone__input"
          multiple
          onChange={pickFiles}
          type="file"
        />
      </div>

      {files.length > 0 && (
        <ul className="ci-filelist">
          {files.map((file, index) => (
            <li className="ci-filelist__item" key={`${file.name}-${index}`}>
              <span className="ci-filelist__icon"><FileIcon isPdf={file.type === 'application/pdf'} /></span>
              <span className="ci-filelist__name">{file.name}</span>
              <span className="ci-filelist__size">{formatFileSize(file.size)}</span>
              <button
                aria-label={`Remove ${file.name}`}
                className="ci-filelist__remove"
                onClick={() => onRemoveFile(index)}
                type="button"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="ci-error" role="alert">{error}</p>}

      <div className="ci-actions">
        <button
          className="ci-button ci-button--primary"
          disabled={files.length === 0 || busy}
          onClick={onSubmit}
          type="button"
        >
          {busy ? 'Reading your document…' : 'Find my flights'}
        </button>
      </div>
    </div>
  );
}
