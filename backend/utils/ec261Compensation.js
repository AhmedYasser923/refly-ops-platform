'use strict';

// =============================================================================
// WHAT A CLAIM IS WORTH, BY DISTANCE
// =============================================================================
//
// Article 7 of EC261/2004 sets the compensation by distance alone:
//   EUR 250  flights of 1500 km or less
//   EUR 400  intra-Community flights of more than 1500 km, and every other
//            flight between 1500 and 3500 km
//   EUR 600  everything else
//
// The same three bands the old analyzer computes (ticketController.js, where it
// is one line), so both tools put the same number on the same flight.
//
// THIS IS THE AMOUNT, NOT AN ENTITLEMENT. Whether EC261 applies at all - a long
// enough delay, a departure from the EU or an EU carrier flying into it, no
// extraordinary circumstance - is a separate question. This file does not
// answer it, and nothing built on it may look as though it has.
// =============================================================================

const { isEUCountry } = require('../services/ec261Service');

const SHORT_HAUL_KM = 1500;
const LONG_HAUL_KM = 3500;

/**
 * The compensation band for one distance, or null when the distance is unknown.
 *
 * A distance is unknown only when an airport is missing from the coordinates
 * file - which is the same reason the screen would have no distance to hover -
 * so the countries are known whenever the amount is.
 *
 * `band` is a code. The words belong to the client; see analyzerV2Utils.js.
 *
 * @param {number} distanceKm  Great-circle kilometres, as the route block shows.
 * @param {string} fromCountry Country of the departure airport, from
 *   airports_data.json and never from the model - a band is a decision, and a
 *   decision may not rest on a value that changes between runs.
 * @param {string} toCountry   Country of the arrival airport, likewise.
 */
function compensationFor({ distanceKm, fromCountry, toCountry }) {
  if (!Number.isFinite(distanceKm)) return null;

  const intraEu = isEUCountry(fromCountry) && isEUCountry(toCountry);
  const band = (amount, code) => ({ amount, currency: 'EUR', band: code, intraEu, distanceKm });

  if (distanceKm <= SHORT_HAUL_KM) return band(250, 'SHORT_HAUL');
  if (distanceKm <= LONG_HAUL_KM) return band(400, 'MEDIUM_HAUL');

  // Over 3500 km the Regulation caps a flight inside the Community at 400:
  // Paris to Réunion is more than 9000 km and is still EUR 400.
  if (intraEu) return band(400, 'INTRA_EU_LONG_HAUL');

  return band(600, 'LONG_HAUL');
}

module.exports = {
  compensationFor,
  SHORT_HAUL_KM,
  LONG_HAUL_KM
};
