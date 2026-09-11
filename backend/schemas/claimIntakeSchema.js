'use strict';

const { SchemaType } = require('@google/generative-ai');

// Slim passenger-facing extraction schema.
// Deliberately flat: the AI reports only what is printed on the document.
// Journey grouping, connection detection, replacement detection, and every
// other conclusion belong to backend/controllers/claimIntakeController.js.
//
// The date and status fields deliberately mirror backend/schemas/ticketResponseSchema.js
// — that shape is battle-tested, and the two-field date approach (raw as printed
// plus ISO) is what keeps partial dates alive instead of being dropped.
//
// Times are deliberately absent. They are the least reliable thing on a travel
// document and nothing downstream uses them, so asking for them only creates
// error surface — see backend/controllers/claimIntakeController.js.
//
// Convention: a missing value is an empty string.

const CLAIM_INTAKE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    _chronology_scratchpad: {
      type: SchemaType.STRING,
      description: 'MENTAL WORKSPACE: Before filling anything else, write out a flat chronological timeline of every flight found across all documents. Note which documents describe the same flight (merge them), and note any airport the passenger departs from more than once (that means a flight was not taken and another replaced it). Work through this first, then fill the rest of the JSON.'
    },
    documentType: {
      type: SchemaType.STRING,
      description: 'One of: boarding_pass | booking_confirmation | e_ticket | itinerary | unknown'
    },
    passengers: {
      type: SchemaType.ARRAY,
      description: 'Every distinct traveller found across all uploaded documents. Do not repeat the same person.',
      items: {
        type: SchemaType.OBJECT,
        properties: {
          firstName: { type: SchemaType.STRING, description: 'Given name as printed. Empty string if absent.' },
          lastName: { type: SchemaType.STRING, description: 'Surname as printed. Empty string if absent.' }
        },
        required: ['firstName', 'lastName']
      }
    },
    bookingReferences: {
      type: SchemaType.ARRAY,
      description: 'Every booking reference / PNR printed anywhere on the documents.',
      items: {
        type: SchemaType.OBJECT,
        properties: {
          value: { type: SchemaType.STRING, description: 'The code itself, uppercase, without any carrier prefix.' },
          carrier: { type: SchemaType.STRING, description: 'Airline the code belongs to when labelled (e.g. "BA/7IQHOL" -> "BA"). Empty string if unlabelled.' }
        },
        required: ['value', 'carrier']
      }
    },
    legs: {
      type: SchemaType.ARRAY,
      description: 'One entry per distinct physical flight the passenger held a ticket for, including flights they did not end up taking.',
      items: {
        type: SchemaType.OBJECT,
        properties: {
          flightNumber: { type: SchemaType.STRING, description: 'Carrier code + number with no spaces or hyphens, e.g. "IB0267", "6E2". Empty string if absent.' },
          flightStatus: {
            type: SchemaType.STRING,
            description: 'One of: Cancelled | Unused / Missed Connection | Replacement Flight | Rescheduled | Flown | Scheduled. See the FLIGHT STATUS RULES in the prompt. The server re-derives this, so report only what the documents actually support.'
          },
          marketingAirline: { type: SchemaType.STRING, description: 'Airline that sold the ticket. Empty string if absent.' },
          marketingAirlineIata: { type: SchemaType.STRING, description: 'Two-character IATA code. Empty string if absent.' },
          operatingAirline: { type: SchemaType.STRING, description: 'Airline actually flying the aircraft. Same as marketing unless the document says "operated by". Empty string if absent.' },
          operatingAirlineIata: { type: SchemaType.STRING, description: 'Two-character IATA code. Empty string if absent.' },
          pnr: {
            type: SchemaType.STRING,
            description: 'Booking reference for THIS leg\'s operating carrier. If the document shows "AA/SNMAUJ, BA/7IQHOL" and this leg is operated by British Airways, output "7IQHOL". NEVER copy a PNR across different carriers. Empty string if absent.'
          },
          departureIata: { type: SchemaType.STRING, description: 'Three-letter airport code. Empty string if absent.' },
          departureCity: { type: SchemaType.STRING },
          rawExtractedDate: {
            type: SchemaType.STRING,
            description: 'The flight date EXACTLY as printed on the document, in whatever form it appears: "05MAR", "25 Mar 2026", "05/mar./2026", "22 mars 2026". Never the issue or booking date.'
          },
          departureDate: {
            type: SchemaType.STRING,
            description: 'The same date converted to YYYY-MM-DD. If the document shows only day and month with no year anywhere, output the partial exactly as printed instead — NEVER guess a year, and NEVER output an empty string when a date is visible.'
          },
          arrivalIata: { type: SchemaType.STRING, description: 'Three-letter airport code. Empty string if absent.' },
          arrivalCity: { type: SchemaType.STRING },
          arrivalDate: { type: SchemaType.STRING, description: 'YYYY-MM-DD, or the partial as printed. Same day as departure unless the document shows the flight lands on a later day. Empty string if unknown.' },
          passengerNames: {
            type: SchemaType.ARRAY,
            description: 'Full names of the passengers travelling on this specific leg, matching the passengers array.',
            items: { type: SchemaType.STRING }
          },
          documentIndex: {
            type: SchemaType.NUMBER,
            description: 'Zero-based index of the uploaded document this leg was read from.'
          }
        },
        required: [
          'flightNumber',
          'flightStatus',
          'marketingAirline',
          'marketingAirlineIata',
          'operatingAirline',
          'operatingAirlineIata',
          'pnr',
          'departureIata',
          'departureCity',
          'rawExtractedDate',
          'departureDate',
          'arrivalIata',
          'arrivalCity',
          'arrivalDate',
          'passengerNames',
          'documentIndex'
        ]
      }
    }
  },
  required: ['_chronology_scratchpad', 'documentType', 'passengers', 'bookingReferences', 'legs']
};

module.exports = CLAIM_INTAKE_SCHEMA;
