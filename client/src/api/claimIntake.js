const parseJsonResponse = async (response) => {
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.message || payload.error || 'Something went wrong. Please try again.');
  }

  return payload;
};

// Manual entry runs the same deterministic build as an upload, minus the model.
export const buildManualItinerary = async ({ legs, passengers, signal }) => {
  const response = await fetch('/api/claim-intake/itinerary', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ legs, passengers }),
    signal
  });

  return parseJsonResponse(response);
};

export const extractClaimIntake = async ({ files, signal }) => {
  const body = new FormData();

  files.forEach((file) => {
    body.append('document', file);
  });

  const response = await fetch('/api/claim-intake/extract', {
    method: 'POST',
    credentials: 'same-origin',
    body,
    signal
  });

  return parseJsonResponse(response);
};
