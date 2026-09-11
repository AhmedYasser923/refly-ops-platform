const parseJsonResponse = async (response) => {
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.message || payload.error || 'Something went wrong. Please try again.');
  }

  return payload;
};

// Uploads the documents on a case and returns the analysed trip.
//
// The reply is already the final shape: `booking.journeys` is the trip as it was
// sold, `replacementItineraries` is what the passenger was moved onto. The
// client does no interpretation of its own - see the note at the top of
// backend/controllers/analyzerV2Controller.js for why that split matters.
export const analyzeDocuments = async ({ files, signal }) => {
  const body = new FormData();

  files.forEach((file) => {
    body.append('document', file);
  });

  const response = await fetch('/api/analyzer-v2/analyze', {
    method: 'POST',
    credentials: 'same-origin',
    body,
    signal
  });

  return parseJsonResponse(response);
};
