'use strict';

// =============================================================================
// READING AN E-TICKET NUMBER OFF A DOCUMENT — THE ONE DOOR
// =============================================================================
//
// AN E-TICKET NUMBER HAS A STRUCTURE, AND THIS FILE READS IT RATHER THAN
// GUESSING AT IT:
//
//     147            2737428284           01
//     ^ 3 digits     ^ 10 digits          ^ the coupon, if the airline prints it
//     the airline's  the serial number
//     IATA ticketing
//     prefix
//
// Three plus ten is thirteen, always. The prefix is the airline's own - 147 is
// Royal Air Maroc, 724 is Swiss, 115 is Air Serbia - and airlines_codes.json
// carries 267 of them. That is what makes the split knowable instead of
// guessable: WHEN THE FIRST THREE DIGITS ARE A PREFIX WE RECOGNISE, WE KNOW
// EXACTLY WHERE THE TICKET NUMBER ENDS, and anything past digit thirteen is the
// coupon rather than part of the number.
//
// WHY IT IS A FILE OF ITS OWN
//
// The rule used to live in the prompt as "an e-ticket number is exactly 13
// digits; if it is not, output an empty string". Plenty of airlines print the
// coupon glued to the number with no separator - Royal Air Maroc prints
// "147273742828401" and "147273742828402" for coupons 01 and 02 of ticket
// 1472737428284 - so the model obeyed, blanked both, and the passenger panel
// said "No ticket number on these documents" about a document that prints it
// twice. A length rule cannot tell a malformed number from a well-formed one
// with a coupon on the end. The prefix can.
//
// The first fix attempted here was worse: chop the tail off any 14- or 15-digit
// run whose trailing digits looked like a coupon. That is a guess wearing a
// rule's clothes - it has no idea where the number actually ends, and it would
// happily cut a number in half. Read the structure instead.
//
// WHEN THE PREFIX IS NOT ONE WE KNOW
//
// A longer run whose prefix is missing from airlines_codes.json returns null,
// and Step 8b then shows the printed digits on the row as unreadable. That is
// the correct outcome twice over: nothing is invented, and the visible failure
// says precisely what to fix - add that airline's ticketPrefix to the file.
// =============================================================================

const {
  normalizeTicketNumber,
  isPlausibleTicketNumber,
  ticketPrefixKnown,
  airlineForTicketPrefix
} = require('./barcodeTicketEnrichment');

const TICKET_PREFIX_DIGITS = 3;
const TICKET_SERIAL_DIGITS = 10;
const TICKET_DIGITS = TICKET_PREFIX_DIGITS + TICKET_SERIAL_DIGITS;

// A coupon is printed as one or two characters - bare ("-5"), or zero-padded
// the way Royal Air Maroc does it ("01"). More than two trailing digits is not a
// coupon, it is a second number run into the first.
//
// Deliberately a bound on the LENGTH and not on the value. Coupon numbers run
// past four across a conjunction ticket set, and a rule about what a coupon may
// contain would be a guess about the trailing digits - the same guess the prefix
// exists to make unnecessary. The prefix says where the number ends; what
// follows it is the airline's business.
const MAX_COUPON_DIGITS = 2;

/**
 * WHAT IT DOES
 *   Reads whatever a document printed as an e-ticket number. Returns
 *   `{ number, couponNumber, issuedBy }`, or null when it is not one.
 *
 * WHY IT IS BUILT THIS WAY
 *   Three cases, in the order the structure decides them:
 *
 *   1. Exactly thirteen digits. That is a whole ticket number and it is taken,
 *      prefix recognised or not — airlines_codes.json holds 267 prefixes and
 *      there are more airlines than that in the world. The prefix is how we find
 *      the END of a longer run; it is not a whitelist for tickets.
 *
 *   2. Longer, with a prefix we recognise. Digits 1-13 are the ticket and the
 *      rest is the coupon. This is the case the file exists for.
 *
 *   3. Anything else. null, so Step 8b reports the printed digits rather than
 *      the screen claiming the document carried no ticket number.
 *
 *   A leading separator or space is irrelevant — "724 5528 980584" and
 *   "7245528980584" are the same ticket — so the digits are extracted first and
 *   every decision is made on those.
 *
 * @param {string} printedValue What the document showed.
 * @returns {{number: string, couponNumber: string, issuedBy: object|null}|null}
 */
function readPrintedTicketNumber(printedValue) {
  const digits = normalizeTicketNumber(printedValue);
  if (digits.length < TICKET_DIGITS) return null;

  const number = digits.slice(0, TICKET_DIGITS);
  const trailing = digits.slice(TICKET_DIGITS);

  if (trailing) {
    // Without a known prefix there is no way to know that digit 13 is where the
    // number ends, and cutting there anyway would be the guess this file exists
    // to avoid.
    if (!ticketPrefixKnown(digits)) return null;
    if (trailing.length > MAX_COUPON_DIGITS) return null;
  }

  if (!isPlausibleTicketNumber(number)) return null;

  return {
    number,
    couponNumber: trailing,
    // The airline whose prefix this is, or null when the file does not know it
    // or several airlines share it. Same lookup the ticket records use.
    issuedBy: airlineForTicketPrefix(number)
  };
}

module.exports = { readPrintedTicketNumber, TICKET_DIGITS };
