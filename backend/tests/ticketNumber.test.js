'use strict';

// Run directly: node backend/tests/ticketNumber.test.js
//
// The corpus behind backend/utils/ticketNumber.js.
//
// An e-ticket number is three digits of airline ticketing prefix plus ten of
// serial. Reading that structure is what lets the coupon be separated from the
// number; the rule it replaced only counted digits, and so it threw away every
// Royal Air Maroc ticket, because that airline prints the coupon glued on with
// no separator.
//
// THE RULE: TEST THE STRUCTURE, NOT ONE AIRLINE'S HABIT. Every case below is
// pinned to a prefix that airlines_codes.json really carries, so the table says
// what the algorithm does rather than what one document happened to look like.

const assert = require('node:assert/strict');
const { readPrintedTicketNumber } = require('../utils/ticketNumber');

// 147 Royal Air Maroc · 724 Swiss · 115 Air Serbia · 126 Garuda Indonesia.
// 900 is deliberately absent from the file - it is the "prefix we do not know".
const UNKNOWN_PREFIX = '900';

function reads(printed, expectedNumber, expectedCoupon = '') {
  const ticket = readPrintedTicketNumber(printed);
  assert.ok(ticket, `${JSON.stringify(printed)} should read as a ticket number`);
  assert.equal(ticket.number, expectedNumber, `${JSON.stringify(printed)} -> number`);
  assert.equal(ticket.couponNumber, expectedCoupon, `${JSON.stringify(printed)} -> coupon`);
}

function rejects(printed, why) {
  assert.equal(readPrintedTicketNumber(printed), null,
    `${JSON.stringify(printed)} should be rejected: ${why}`);
}

// --- thirteen digits is a whole ticket number ------------------------------------------
reads('7245528980584', '7245528980584');
reads('1472737428284', '1472737428284');
reads('1152146558404', '1152146558404');

// The prefix locates the END of a longer run. It is not a whitelist: the file
// holds 267 prefixes and there are more airlines than that, so a bare thirteen
// digits is taken whether we recognise the first three or not.
reads(`${UNKNOWN_PREFIX}2737428284`, '9002737428284');

// --- printed spacing and separators are not part of the number ---------------------------
reads('724 5528 980584', '7245528980584');
reads('126 2146558404', '1262146558404');
reads('ETKT 1472737428284', '1472737428284');
reads('  7245528980584  ', '7245528980584');

// --- the coupon comes off, however the airline prints it -----------------------------------
// Royal Air Maroc glues it on and zero-pads it; most airlines hyphenate it.
reads('147273742828401', '1472737428284', '01');
reads('147273742828402', '1472737428284', '02');
reads('7242339474582-5', '7242339474582', '5');
reads('7242339474582 - 5', '7242339474582', '5');
// Coupon numbers run past four across a conjunction ticket set, so the trailing
// digits are bounded by LENGTH and never by value - a rule about what a coupon
// may contain would be a guess, which is the thing the prefix removes.
reads('724552898058412', '7245528980584', '12');

// --- and the same ticket reads identically from any of its coupons ---------------------------
// This is the whole reason the coupon is separated: identity. Two legs of one
// journey print the same ticket with different coupons, and if the suffix stays
// they look like two tickets.
assert.equal(
  readPrintedTicketNumber('147273742828401').number,
  readPrintedTicketNumber('147273742828402').number,
  'two coupons of one ticket give one number'
);

// --- what is not a ticket number ----------------------------------------------------------------
rejects('', 'nothing printed');
rejects(null, 'nothing printed');
rejects('12345', 'too short');
rejects('724552898', 'too short even with a known prefix');
rejects('1P1SJF', 'a booking reference, not a ticket');
rejects('0000000000000', 'thirteen zeroes is a placeholder');
rejects('7245528980584123', 'three trailing digits is a second number, not a coupon');
rejects('72455289805841234', 'and four certainly is');

// The case the algorithm genuinely cannot solve, and must not pretend to: a run
// longer than thirteen whose first three digits are not a prefix we hold. There
// is no way to know where the number ends, so nothing is invented - Step 8b then
// shows the printed digits on the row, and the fix is to add that airline's
// ticketPrefix to airlines_codes.json.
rejects(`${UNKNOWN_PREFIX}273742828401`, 'unknown prefix, so the cut point is unknowable');

console.log('ticketNumber: all assertions passed');
