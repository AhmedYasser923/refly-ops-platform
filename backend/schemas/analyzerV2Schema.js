'use strict';

const { SchemaType } = require('@google/generative-ai');

// Extraction schema for the specialist analyzer.
// Deliberately flat: the AI reports only what is printed on the document.
// Journey grouping, connection detection, replacement detection, and every
// other conclusion belong to backend/controllers/analyzerV2Controller.js.
//
// This is a straight port of backend/schemas/claimIntakeSchema.js, which is in
// turn descended from backend/schemas/ticketResponseSchema.js. The two-field
// date approach (raw as printed, plus ISO) is what keeps partial dates alive
// instead of being dropped, and it has survived a lot of real documents.
//
// Times are absent FOR NOW. They are the least reliable field on a travel
// document, and the engine derives the itinerary from dates alone. When times
// return they arrive as a display-only field that the engine never reads -
// see the gotchas in orientation/analyzer-v2.md.
//
// Convention: a missing value is an empty string.

const ANALYZER_V2_SCHEMA = {
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
          marketingAirline: { type: SchemaType.STRING, description: 'The AIRLINE that sold the ticket, as its name is printed. A tour operator, travel agency or booking site (e.g. "Coral Travel", "Kiwi.com") is NOT an airline. If no airline name is printed, output an empty string - never work it out from the flight number; the server looks it up.' },
          marketingAirlineIata: { type: SchemaType.STRING, description: 'Two-character IATA code. Empty string if absent.' },
          operatingAirline: { type: SchemaType.STRING, description: 'Airline actually flying the aircraft, as its name is printed. Same as marketing unless the document says "operated by". Empty string if no airline is printed - never work it out from the flight number.' },
          operatingAirlineIata: { type: SchemaType.STRING, description: 'Two-character IATA code. Empty string if absent.' },
          pnr: {
            type: SchemaType.STRING,
            description: 'Booking reference for THIS leg\'s operating carrier. If the document shows "AA/SNMAUJ, BA/7IQHOL" and this leg is operated by British Airways, output "7IQHOL". NEVER copy a PNR across different carriers. Empty string if absent.'
          },
          departureIata: { type: SchemaType.STRING, description: 'Three-letter airport code. Empty string if absent.' },
          // Name and country are display-only: the journey heading prints them.
          // Flights are matched and chained on the codes, never on these.
          departureAirportName: { type: SchemaType.STRING, description: 'FULL official name of the departure airport, e.g. "Istanbul Airport", "John F. Kennedy International Airport". Never the IATA code, never just the city. Empty string if unknown.' },
          departureCity: { type: SchemaType.STRING, description: 'The city the departure airport serves, as one English name, e.g. "Istanbul". Not the airport\'s name, and not the local and English names run together. Empty string if unknown.' },
          departureCountry: { type: SchemaType.STRING, description: 'Country the departure airport is in, in English, e.g. "Turkey". Empty string if unknown.' },
          rawExtractedDate: {
            type: SchemaType.STRING,
            description: 'The flight date EXACTLY as printed on the document, in whatever form it appears: "05MAR", "25 Mar 2026", "05/mar./2026", "22 mars 2026". Never the issue or booking date.'
          },
          departureDate: {
            type: SchemaType.STRING,
            description: 'The same date converted to YYYY-MM-DD. If the document shows only day and month with no year anywhere, output the partial exactly as printed instead — NEVER guess a year, and NEVER output an empty string when a date is visible.'
          },
          arrivalIata: { type: SchemaType.STRING, description: 'Three-letter airport code. Empty string if absent.' },
          arrivalAirportName: { type: SchemaType.STRING, description: 'FULL official name of the arrival airport, e.g. "Copenhagen Airport". Never the IATA code, never just the city. Empty string if unknown.' },
          arrivalCity: { type: SchemaType.STRING, description: 'The city the arrival airport serves, as one English name, e.g. "Copenhagen". Not the airport\'s name, and not the local and English names run together. Empty string if unknown.' },
          arrivalCountry: { type: SchemaType.STRING, description: 'Country the arrival airport is in, in English, e.g. "Denmark". Empty string if unknown.' },
          arrivalDate: { type: SchemaType.STRING, description: 'YYYY-MM-DD, or the partial as printed. Same day as departure unless the document shows the flight lands on a later day. Empty string if unknown.' },
          passengerNames: {
            type: SchemaType.ARRAY,
            description: 'Full names of the passengers travelling on this specific leg, matching the passengers array.',
            items: { type: SchemaType.STRING }
          },
          // One entry per passenger on this leg. This is the only place that can
          // express "the two travellers hold different codes on the same
          // flight", which the flat `pnr` above cannot - see the MULTI-CARRIER
          // PNR and TICKET NUMBER rules in the prompt.
          passengerTickets: {
            type: SchemaType.ARRAY,
            description: 'One entry per passenger travelling on this leg, mapping that passenger to the exact ticket number and booking reference printed for THEM on THIS flight. Include an entry for every passenger even when the ticket number is missing.',
            items: {
              type: SchemaType.OBJECT,
              properties: {
                passengerName: {
                  type: SchemaType.STRING,
                  description: 'Name exactly as it appears in the passengers array.'
                },
                ticketNumber: {
                  type: SchemaType.STRING,
                  description: 'The 13-digit e-ticket number printed for this passenger, digits only, e.g. "7245528980584". Strip any trailing coupon suffix such as "-5". If the document labels a short alphanumeric code as an e-ticket number (some agents print the booking reference there), that is NOT a ticket number - output an empty string. Empty string if absent.'
                },
                pnr: {
                  type: SchemaType.STRING,
                  description: 'Booking reference printed for THIS passenger on THIS leg. Usually identical for everyone on the flight, but some agents issue one per traveller - when the document shows different codes per passenger, map each to the right person rather than picking one. Empty string if absent.'
                }
              },
              required: ['passengerName', 'ticketNumber', 'pnr']
            }
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
          'departureAirportName',
          'departureCity',
          'departureCountry',
          'rawExtractedDate',
          'departureDate',
          'arrivalIata',
          'arrivalAirportName',
          'arrivalCity',
          'arrivalCountry',
          'arrivalDate',
          'passengerNames',
          'passengerTickets',
          'documentIndex'
        ]
      }
    }
  },
  required: ['_chronology_scratchpad', 'documentType', 'passengers', 'bookingReferences', 'legs']
};

module.exports = ANALYZER_V2_SCHEMA;
