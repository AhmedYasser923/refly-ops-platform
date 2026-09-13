'use strict';

const airportsDatabase = require('../airports_data.json');
const Announcement     = require('../models/Announcement');
const EmailTemplate    = require('../models/EmailTemplate');
const catchAsync = require('../utils/catchAsync');
const AppError   = require('../utils/appError');
const logUsage   = require('../utils/logUsage');
const { calculateCost } = require('../utils/pricing');
const genAI = require('../utils/geminiClient');
const MODELS = require('../config/models');
const flightStatusService = require('../services/flightStatusService');
const eocService = require('../services/eocService');

const EmailReference   = require('../models/EmailReference');

const MAX_REFERENCES = 3;
const MAX_REFERENCE_WORDS = 2000;
const ANNOUNCEMENT_MODEL = 'gemini-3.1-flash-lite';

// ---------------------------------------------------------------------------
// Template state builder — creates an optimized lookup structure
// ---------------------------------------------------------------------------

function buildEmailTemplateState(docs) {
  const byKey = {};

  docs.forEach(t => {
    const key = String(t.key || '').trim();
    if (!key) return;
    byKey[key] = {
      key,
      text: t.text || '',
      type: t.type,
      label: t.label || key,
      combineWithDocuments: !!t.combineWithDocuments,
    };
  });

  return {
    byKey,
    templates: Object.values(byKey),
  };
}

async function getEmailTemplateState() {
  const docs = await EmailTemplate.find().lean();
  return buildEmailTemplateState(docs);
}

async function getEmailTemplateList() {
  const state = await getEmailTemplateState();
  return state.templates;
}

// ---------------------------------------------------------------------------
// Template CRUD helpers
// ---------------------------------------------------------------------------

function buildTemplateDocument(body) {
  const key = String(body.key || '').trim();
  const label = String(body.label || '').trim();
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const type = body.type || 'document-request';
  const combineWithDocuments = type === 'special-case' ? !!body.combineWithDocuments : false;

  return { key, label: label || key, text, type, combineWithDocuments };
}

function buildTemplateUpdate(body) {
  const update = {};
  if (body.text !== undefined) update.text = String(body.text || '').trim();
  if (body.label !== undefined) update.label = String(body.label || '').trim();

  if (body.type !== undefined) {
    update.type = body.type;
    update.combineWithDocuments = body.type === 'special-case' ? !!body.combineWithDocuments : false;
  } else if (body.combineWithDocuments !== undefined) {
    update.combineWithDocuments = !!body.combineWithDocuments;
  }

  return update;
}

// ---------------------------------------------------------------------------
// Outro builder — AI-drafted footer appended to document-request emails.
// The body up to (but not including) the footer is given as context so the
// outro only mentions actions actually requested. The three legacy outros are
// passed as style references; the model must adapt, not copy verbatim.
// ---------------------------------------------------------------------------

async function combineClickHereBullets(bullets, model) {
  const indices = [];
  bullets.forEach((b, i) => {
    if (/click here/i.test(b)) indices.push(i);
  });
  if (indices.length < 2) return { bullets, result: null };

  const toMerge = indices.map(i => bullets[i]).join('\n');
  const prompt = `You are a claims specialist at ReFly, a flight compensation company writing to a passenger.

Below are multiple bullet points that each reference the same "click here" upload link. Merge them into ONE bullet that asks the passenger to click the link once and upload all the listed items in a single place.

Rules:
- Output ONLY the merged bullet text. Do not include a leading "• " marker, no quotes, no greeting, no extra commentary.
- Use the phrase "click here" exactly once.
- Preserve every distinct item/document mentioned across the originals. Do not invent new requirements.
- Keep it warm, concise, and professional. One sentence if possible.

Bullets to merge:
---
${toMerge}
---`;
  const result = await geminiQueue.run(() => model.generateContent(prompt));
  const merged = result.response.text().trim().replace(/^•\s*/, '').replace(/^"|"$/g, '');

  const firstIdx = indices[0];
  const skip = new Set(indices.slice(1));
  const newBullets = bullets
    .map((b, i) => (i === firstIdx ? `• ${merged}` : skip.has(i) ? null : b))
    .filter(b => b !== null);

  return { bullets: newBullets, result };
}

async function generateOutro(emailBody, model) {
  const prompt = `You are a claims specialist at ReFly, a flight compensation company writing to a passenger.

Below is the body of a flight-compensation claim email up to (but not including) the closing footer. Write the closing footer paragraph that fits THIS specific email.

Reference examples of footer tone and style (use them as style guidance only — do NOT copy if they do not match what the email is actually requesting):

Example A (email contains a "click here" upload link AND requests one or more documents/items, regardless of whether each bullet mentions the link):
"Please upload all requested documents through the link above at your earliest convenience. If you experience any technical issues with the upload link, you may instead reply directly to this email with the documents attached. Once we receive these items, our legal team will continue processing your compensation claim."

Example B (email contains a "click here" link but only requests a signature or single action tied to that link — no other documents):
"Please complete the requested action through the link above at your earliest convenience. Once we receive your submission, our legal team will continue processing your compensation claim."

Example C (email has no upload link and asks the passenger to reply with documents or information):
"Please reply directly to this email with the requested documents and information at your earliest convenience. Once we receive them, our legal team will continue processing your compensation claim."

Rules:
- Output ONLY the footer paragraph itself. No bullets, no greeting, no sign-off, no quotation marks.
- Match the actions the email body actually requests. Never invent requirements not mentioned in the body.
- If the body contains a "click here" upload link, treat that link as the primary channel for ALL requested documents — do NOT split documents between "upload through the link" and "reply with the rest". Mention replying-by-email only as a fallback ("if the upload link does not work"), not as a parallel requirement.
- If the body contains a "click here" link tied only to a single action like signing (no other documents requested), just point to the link without offering the reply fallback.
- If there is no "click here" link, ask the passenger to reply directly with the requested items.
- If the body requests sensitive personal documents (passport, national ID, driver's license, boarding pass, bank details, or similar identity/financial documents) AND the upload link is being used, briefly reassure the passenger that the upload link is secure and encrypted — phrase this naturally inside the footer, not as a separate disclaimer. Skip this reassurance when no sensitive documents are requested or when there is no upload link.
- End with what happens next on ReFly's side (the legal team continues processing the claim).
- Keep it warm, concise, and professional. One paragraph.

Email body:
---
${emailBody}
---`;
  const result = await geminiQueue.run(() => model.generateContent(prompt));
  return { text: result.response.text().trim().replace(/^"|"$/g, ''), result };
}

const { geminiQueue, isQuotaError } = require('../utils/geminiQueue');
// ---------------------------------------------------------------------------
// Shared AI translation helper
// ---------------------------------------------------------------------------

async function translateText(text, language, model) {
  const prompt = `You are a professional multilingual translator and flight compensation specialist.\n\nTranslate the following email content into ${language}.\n\nIMPORTANT: Output ONLY the translated content. No subject line, no explanatory text, no metadata.\n\n---\n${text}\n---`;
  const result = await geminiQueue.run(() => model.generateContent(prompt));
  return { text: result.response.text().trim(), result };
}

// ---------------------------------------------------------------------------
// Reference context helper — fetches saved references for AI prompts
// ---------------------------------------------------------------------------

async function getReferenceContext() {
  const refs = await EmailReference.find().sort({ createdAt: -1 }).limit(MAX_REFERENCES).lean();
  if (!refs.length) return '';

  let totalWords = 0;
  const included = [];
  for (const ref of refs) {
    const words = ref.content.split(/\s+/).length;
    if (totalWords + words > MAX_REFERENCE_WORDS) break;
    totalWords += words;
    included.push(`--- ${ref.title} ---\n${ref.content}`);
  }

  if (!included.length) return '';
  return `\n\nHere are reference communications for tone and style context:\n${included.join('\n\n')}\n\n`;
}

const EocRecord            = require('../models/EocRecord');
const EocOngoingOverride   = require('../models/EocOngoingOverride');
const { syncEocFromSheet } = require('../utils/syncEoc');
const {
  buildOngoingOverrideDocument,
  buildOngoingOverrideKey,
  isValidYmd,
} = require('../utils/eocOverrideKey');

// --- Shared data helpers (jurisdiction + airline docs) ---
const {
  jurisdictionData,
  airlinesCodesData: airlineCodesDatabase,
  getJurisdictionLimit,
  getAirlineDocInfo,
} = require('../utils/dataLoader');

// Build the flat { "country": value } map the frontend JS (tools.js) expects.
// This is computed once at startup from jurisdiction_data.json so the frontend
// never needs its own hardcoded copy.
const jurisdictionLimitsForClient = Object.fromEntries(
  jurisdictionData.map(entry => [
    entry.country,
    entry.note ? entry.note : entry.years, // preserve display strings like "2 Months - 10"
  ])
);

const normalizeStr = s =>
  (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// ---------------------------------------------------------------------------
// EOC CHECKER
// ---------------------------------------------------------------------------

exports.checkEOC = async (req, res, next) => {
  try {
    const result = await eocService.findEOCEvents(req.query);
    res.json(result);
  } catch (error) {
    next(error);
  }
};

exports.listEOCRecords = catchAsync(async (req, res) => {
  const result = await eocService.listEOCRecords(req.query);
  res.json(result);
});

function validateOngoingOverrideBody(body, requireEndDate) {
  if (body.category && !/ongoing/i.test(String(body.category))) {
    throw new AppError('Only ongoing EOC issues can be closed or reopened.', 400);
  }

  const doc = buildOngoingOverrideDocument(body);
  if (!isValidYmd(doc.startDate)) {
    throw new AppError('A valid ongoing issue start date is required.', 400);
  }
  if (!doc.locationKey || !doc.eventKey || !doc.decisionKey) {
    throw new AppError('Ongoing issue location, event, and decision are required.', 400);
  }

  const endDate = String(body.endDate || '').trim();
  if (requireEndDate) {
    if (!isValidYmd(endDate)) {
      throw new AppError('A valid end date is required.', 400);
    }
    if (endDate < doc.startDate) {
      throw new AppError('End date cannot be before the ongoing issue start date.', 400);
    }
  }

  return { doc, endDate };
}

function serializeEocOverride(doc) {
  const override = doc?.toObject ? doc.toObject() : doc;

  return {
    startDate: override.startDate,
    location: override.location,
    event: override.event,
    decision: override.decision,
    endDate: override.endDate || '',
    note: override.note || '',
    closedAt: override.closedAt || null,
    closedByName: override.closedByName || '',
    reopenedAt: override.reopenedAt || null,
  };
}

exports.closeEocOngoingIssue = catchAsync(async (req, res) => {
  const { doc, endDate } = validateOngoingOverrideBody(req.body, true);
  const note = String(req.body.note || '').trim();
  const filter = buildOngoingOverrideKey(doc);

  const override = await EocOngoingOverride.findOneAndUpdate(
    filter,
    {
      $set: {
        ...doc,
        endDate,
        note,
        closedBy: req.user._id,
        closedByName: req.user.name || '',
        closedByEmail: req.user.email || '',
        closedAt: new Date(),
        reopenedAt: null,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  res.json({ success: true, override: serializeEocOverride(override) });
});

exports.reopenEocOngoingIssue = catchAsync(async (req, res) => {
  const { doc } = validateOngoingOverrideBody(req.body, false);
  const note = String(req.body.note || '').trim();
  const filter = buildOngoingOverrideKey(doc);

  const override = await EocOngoingOverride.findOneAndUpdate(
    filter,
    {
      $set: {
        ...doc,
        endDate: '',
        note,
        closedBy: null,
        closedByName: '',
        closedByEmail: '',
        closedAt: null,
        reopenedAt: new Date(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  res.json({ success: true, override: serializeEocOverride(override) });
});

// AIRPORT SEARCH
// ---------------------------------------------------------------------------

exports.searchAirports = (req, res, next) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q || q.length < 2) return res.json([]);

    const exactMatches      = [];
    const startsWithMatches = [];
    const includesMatches   = [];

    airportsDatabase.forEach(a => {
      const iata = (a.iata || '').toLowerCase();
      const city = (a.city || '').toLowerCase();
      const name = (a.name || '').toLowerCase();

      if (iata === q)                                     exactMatches.push(a);
      else if (iata.startsWith(q) || city.startsWith(q)) startsWithMatches.push(a);
      else if (iata.includes(q) || city.includes(q) || name.includes(q)) includesMatches.push(a);
    });

    res.json([...exactMatches, ...startsWithMatches, ...includesMatches].slice(0, 8));
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// FLIGHT STATUS (Cirium) — identical logic to ticketController
// ---------------------------------------------------------------------------

exports.checkFlightStatus = async (req, res, next) => {
  const result = await flightStatusService.getFlightStatus(req.query);
  res.json(result);
};

// DOCUMENT CHECKER
// ---------------------------------------------------------------------------

exports.checkDocs = catchAsync(async (req, res, next) => {
  const query = normalizeStr(req.query.airline || '');
  if (!query) return res.status(400).json({ error: 'Airline name is required' });

  const dbMatch = airlineCodesDatabase.find(a =>
    normalizeStr(a.name) === query ||
    (a.iata && a.iata.toLowerCase() !== 'na' && a.iata.toLowerCase() === query)
  );
  const displayAirline = dbMatch ? dbMatch.name : query;

  // getAirlineDocInfo returns "No documents required" when there's no specific entry
  const docInfo = getAirlineDocInfo(dbMatch ? dbMatch.name : query);
  const hasDocs = docInfo.reqs !== 'No documents required';

  res.status(200).json({
    airline: displayAirline,
    hasDocs,
    reqs: docInfo.reqs,
    ticketPrefix: docInfo.ticketPrefix,
    ticketNumberCanReplacePnr: docInfo.ticketNumberCanReplacePnr,
    claimNote: docInfo.claimNote,
    oneTimeSubmission: docInfo.oneTimeSubmission,
    ceasedOperations: docInfo.ceasedOperations,
    // Read from the matched entry directly rather than added to
    // getAirlineDocInfo, which also feeds the old ticket analyzer.
    directFlightOperator: Boolean(dbMatch?.directFlightOperator),
    fastTrack: Boolean(dbMatch?.fastTrack),
    pnrFormat: String(dbMatch?.pnrFormat || ''),
    iata:    dbMatch?.iata    || 'N/A',
    icao:    dbMatch?.icao    || 'N/A',
    country: dbMatch?.country || 'N/A',
  });

  logUsage(req, {
    operationType: 'doc_check',
    metadata: { airline: displayAirline, hasDocs }
  });
});

// ---------------------------------------------------------------------------
// AIRLINE SEARCH
// ---------------------------------------------------------------------------

exports.searchAirlines = catchAsync(async (req, res, next) => {
  const query = normalizeStr(req.query.q || '');
  if (!query || query.length < 2) return res.json([]);

  const results = [];
  for (const airline of airlineCodesDatabase) {
    const iataMatch = airline.iata && airline.iata.toLowerCase() !== 'na' && airline.iata.toLowerCase().includes(query);
    if (normalizeStr(airline.name).includes(query) || iataMatch) {
      results.push({ name: airline.name, iata: airline.iata });
    }
    if (results.length >= 10) break;
  }
  res.status(200).json(results);
});

// ---------------------------------------------------------------------------
// IATA LOOKUP
// ---------------------------------------------------------------------------

exports.lookupIATA = (req, res, next) => {
  try {
    const q = normalizeStr(req.query.q || '');
    if (!q || q.length < 2) return res.json([]);

    const activeExact = [], activeStartsWith = [], activeIncludes = [];
    const inactiveExact = [], inactiveStartsWith = [], inactiveIncludes = [];

    airlineCodesDatabase.forEach(a => {
      const iata = (a.iata || '').toLowerCase();
      const icao = (a.icao || '').toLowerCase();
      const name = normalizeStr(a.name);
      const isActive = a.active === 'Y';
      const bucket = isActive
        ? { exact: activeExact, sw: activeStartsWith, inc: activeIncludes }
        : { exact: inactiveExact, sw: inactiveStartsWith, inc: inactiveIncludes };

      if (iata === q || icao === q || name === q)                       bucket.exact.push(a);
      else if (iata.startsWith(q) || icao.startsWith(q) || name.startsWith(q)) bucket.sw.push(a);
      else if (iata.includes(q) || icao.includes(q) || name.includes(q))     bucket.inc.push(a);
    });

    const results = [
      ...activeExact, ...activeStartsWith, ...activeIncludes,
      ...inactiveExact, ...inactiveStartsWith, ...inactiveIncludes,
    ].slice(0, 8);

    res.json(results);

    logUsage(req, {
      operationType: 'iata_lookup',
      metadata: { query: q, resultCount: results.length }
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// TRACKER OVERRIDES - per-tracker alternative search codes for airlines whose
// IATA doesn't resolve on external trackers. Driven by `trackerSearchCodes`
// in airlines_codes.json, e.g.
//   PU  -> { flightStats: "PU*" }            // asterisk only works on FlightStats
//   E9  -> { airportInfo: "EVE", flightStats: "EVE", flightera: "EVE" }  // ICAO everywhere
// ---------------------------------------------------------------------------

const VALID_TRACKER_KEYS = new Set(['airportInfo', 'flightStats', 'flightera']);

const trackerOverridesMap = Object.fromEntries(
  airlineCodesDatabase
    .filter(a => a.trackerSearchCodes && typeof a.trackerSearchCodes === 'object' && a.iata && a.iata.toLowerCase() !== 'na')
    .map(a => {
      const codes = Object.fromEntries(
        Object.entries(a.trackerSearchCodes)
          .filter(([k, v]) => VALID_TRACKER_KEYS.has(k) && typeof v === 'string' && v.trim())
          .map(([k, v]) => [k, v.trim()])
      );
      return [a.iata.toUpperCase(), { name: a.name, codes }];
    })
    .filter(([, entry]) => Object.keys(entry.codes).length > 0)
);

exports.getTrackerOverrides = (req, res) => {
  res.json(trackerOverridesMap);
};

exports.logEc261Calc = catchAsync(async (req, res) => {
  const origin = String(req.body.origin || '').trim().slice(0, 8);
  const destination = String(req.body.destination || '').trim().slice(0, 8);
  const distanceKm = Number(req.body.distanceKm);
  const compensation = String(req.body.compensation || '').trim().slice(0, 32);
  const band = String(req.body.band || '').trim().slice(0, 48);

  if (!origin || !destination) return res.json({ success: true, logged: false });

  await logUsage(req, {
    operationType: 'ec261_calc',
    metadata: {
      origin,
      destination,
      distanceKm: Number.isFinite(distanceKm) ? distanceKm : null,
      compensation: compensation || null,
      band: band || null
    }
  });

  res.json({ success: true, logged: true });
});

exports.logJurisdictionCheck = catchAsync(async (req, res) => {
  const country = String(req.body.country || '').trim().slice(0, 64);
  if (!country) return res.json({ success: true, logged: false });

  await logUsage(req, {
    operationType: 'jurisdiction_check',
    metadata: { country }
  });

  res.json({ success: true, logged: true });
});

exports.logTrackerSearch = catchAsync(async (req, res) => {
  const flightNumber = String(req.body.flightNumber || '').trim().slice(0, 16);
  const date = String(req.body.date || '').trim().slice(0, 10);
  const trackers = Array.isArray(req.body.trackers)
    ? req.body.trackers.map((value) => String(value).trim()).filter(Boolean).slice(0, 12)
    : [];

  if (!flightNumber || !trackers.length) {
    return res.json({ success: true, logged: false });
  }

  await logUsage(req, {
    operationType: 'tracker_search',
    metadata: { flightNumber, date, trackers, trackerCount: trackers.length }
  });

  res.json({ success: true, logged: true });
});

// ---------------------------------------------------------------------------
// SMART EMAIL BUILDER
// ---------------------------------------------------------------------------

function collectGeminiUsage(results) {
  const totals = results.reduce((acc, r) => {
    const meta = r?.response?.usageMetadata || {};
    acc.iTok += meta.promptTokenCount || 0;
    acc.oTok += meta.candidatesTokenCount || 0;
    acc.tTok += meta.thoughtsTokenCount || 0;
    return acc;
  }, { iTok: 0, oTok: 0, tTok: 0 });

  return totals;
}

function logGeminiUsage(req, results, operationType, modelName, metadata = {}) {
  const totals = collectGeminiUsage(results);
  const { iTok, oTok, tTok } = totals;
  const costUSD = calculateCost(modelName, {
    promptTokenCount: iTok,
    candidatesTokenCount: oTok,
    thoughtsTokenCount: tTok,
  }).costUSD;
  logUsage(req, {
    operationType,
    model: modelName,
    inputTokens: iTok,
    outputTokens: oTok + tTok,
    costUSD,
    metadata
  });
}

function logAiUsage(req, results, language, opType) {
  logGeminiUsage(
    req,
    results,
    opType || 'email_translation',
    MODELS.emailBuilder,
    language ? { language } : {}
  );
}

function stripCodeFence(value) {
  return String(value || '').trim().replace(/^```[\w-]*\s*/, '').replace(/\s*```$/, '').trim();
}

function stripAnnouncementHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanAnnouncementLabel(value) {
  const label = stripAnnouncementHtml(value)
    .replace(/^["']|["']$/g, '')
    .replace(/[.]+$/g, '')
    .trim();

  return label && label.length <= 40 ? label : 'General';
}

function announcementSource(doc) {
  return {
    id: String(doc._id),
    subject: doc.subject,
    date: doc.date,
    announcer: doc.announcer
  };
}

function fallbackAnnouncementAnswer(answer = "Sorry, I couldn't generate an answer.") {
  return {
    answer,
    sources: [],
    supersededIds: [],
    contradictions: [],
    noMatch: true
  };
}

function normalizeAnnouncementAskPayload(payload, announcements) {
  if (!payload || typeof payload !== 'object') {
    return fallbackAnnouncementAnswer();
  }

  const byId = new Map(announcements.map((a) => [String(a._id), a]));
  const toKnownId = (value) => {
    const id = typeof value === 'string' ? value : (value?.id || value?._id);
    const normalized = String(id || '').trim();
    return byId.has(normalized) ? normalized : '';
  };
  const uniqueKnownIds = (values) => [...new Set((Array.isArray(values) ? values : []).map(toKnownId).filter(Boolean))];

  const noMatch = payload.noMatch === true;
  const sourceIds = noMatch ? [] : uniqueKnownIds(payload.sources);
  const sources = sourceIds.map((id) => announcementSource(byId.get(id)));
  const supersededIds = uniqueKnownIds(payload.supersededIds);
  const contradictions = (Array.isArray(payload.contradictions) ? payload.contradictions : [])
    .map((item) => ({
      summary: String(item?.summary || '').trim(),
      ids: uniqueKnownIds(item?.ids)
    }))
    .filter((item) => item.summary || item.ids.length);
  const answer = String(payload.answer || '').trim();

  if (!answer) return fallbackAnnouncementAnswer();
  if (noMatch) {
    return {
      answer,
      sources: [],
      supersededIds: [],
      contradictions: [],
      noMatch: true
    };
  }
  if (!noMatch && !sources.length) return fallbackAnnouncementAnswer();

  return {
    answer,
    sources,
    supersededIds,
    contradictions,
    noMatch
  };
}

exports.generateEmail = catchAsync(async (req, res, next) => {
  const templateState = await getEmailTemplateState();
  const { byKey } = templateState;
  const { mode, language, selectedTemplates = [], customNote, useWrapper, placeholderValues } = req.body;

  if (!mode) return next(new AppError('Please provide the email mode', 400));
  if (mode !== 'request') return next(new AppError('Invalid mode', 400));
  if (!selectedTemplates.length && !customNote?.trim()) {
    return next(new AppError('Please select at least one template or add a custom note', 400));
  }

  const isEnglish = language === 'English';
  const model = genAI.getGenerativeModel({ model: MODELS.emailBuilder });
  let generationResult = null;
  let translationResult = null;
  let outroResult = null;
  let mergeResult = null;

  const sortedSelected = [...selectedTemplates].sort((a, b) => {
    if (a === 'Signed Power of Attorney') return -1;
    if (b === 'Signed Power of Attorney') return 1;
    return 0;
  });

  const normalizePlaceholderName = name => String(name || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  const formatPlaceholderValue = (key, value) => {
    const val = String(value || '').trim();
    if (!val) return '';
    if (normalizePlaceholderName(key) === 'amount' && !/\u20ac/.test(val)) {
      const amount = val
        .replace(/^(eur|euro)\s*/i, '')
        .replace(/\s*(eur|euro)$/i, '')
        .trim();
      return `\u20ac${amount}`;
    }
    return val;
  };

  const applyPlaceholders = text => {
    if (!placeholderValues || typeof placeholderValues !== 'object') return text;
    return text.replace(/\{([^}]+)\}/g, (_, key) => {
      const val = formatPlaceholderValue(key, placeholderValues[key.trim()]);
      return val || `{${key}}`;
    });
  };

  const makeBullet = key => {
    const t = byKey[key];
    if (!t) return '';
    let text = t.text.replace(/\[link\]/g, 'click here');
    text = applyPlaceholders(text);
    return `• ${text}`;
  };

  // Categorize selected templates by type
  const rejectionKeys = sortedSelected.filter(k => byKey[k]?.type === 'rejection');
  const docRequestKeys = sortedSelected.filter(k => byKey[k]?.type === 'document-request');
  const specialStandaloneKeys = sortedSelected.filter(k =>
    byKey[k]?.type === 'special-case' && !byKey[k]?.combineWithDocuments
  );
  const specialCombinableKeys = sortedSelected.filter(k =>
    byKey[k]?.type === 'special-case' && byKey[k]?.combineWithDocuments
  );

  // Process custom note via AI
  let customNoteBullet = null;
  if (customNote?.trim()) {
    const referenceContext = await getReferenceContext();
    const noteRewritePrompt = `You are a claims specialist at ReFly, a flight compensation company writing to a passenger.${referenceContext}\n\nRewrite the following note as a warm, professional sentence for a flight compensation claim email. Tone: human and considerate — the passenger may be in a stressful situation. Phrase it as a polite request or question, not a command. No filler phrases. No bullet point, no greeting, no sign-off. Output only the rewritten sentence.\n\n"${customNote.trim()}"`;
    try {
      generationResult = await geminiQueue.run(() => model.generateContent(noteRewritePrompt));
    } catch (err) {
      if (isQuotaError(err)) return next(new AppError('AI service is temporarily at capacity. Please try again in a moment.', 503));
      return next(new AppError(`Email generation failed: ${err.message}`, 502));
    }
    customNoteBullet = `• ${generationResult.response.text().trim()}`;
  }

  // Build email sections
  const sections = [];

  const rejectionText = rejectionKeys
    .filter(k => byKey[k])
    .map(k => byKey[k].text)
    .join('\n\n');
  if (rejectionText) sections.push(rejectionText);

  const standaloneBullets = specialStandaloneKeys.filter(k => byKey[k]).map(makeBullet);
  if (standaloneBullets.length) sections.push(standaloneBullets.join('\n\n'));

  let wrappedBullets = [
    ...specialCombinableKeys.filter(k => byKey[k]).map(makeBullet),
    ...docRequestKeys.filter(k => byKey[k]).map(makeBullet),
    ...(customNoteBullet ? [customNoteBullet] : [])
  ];

  if (wrappedBullets.length) {
    try {
      const merged = await combineClickHereBullets(wrappedBullets, model);
      wrappedBullets = merged.bullets;
      mergeResult = merged.result;
    } catch (err) {
      if (isQuotaError(err)) return next(new AppError('AI service is temporarily at capacity. Please try again in a moment.', 503));
      return next(new AppError(`Email generation failed: ${err.message}`, 502));
    }

    const hasDocRequests = docRequestKeys.length > 0;
    const addOutro = hasDocRequests || (customNoteBullet && useWrapper);
    const bulletsText = wrappedBullets.join('\n\n');
    let docSection = bulletsText;
    if (addOutro) {
      try {
        const r = await generateOutro(bulletsText, model);
        outroResult = r.result;
        docSection = `${bulletsText}\n\n${r.text}`;
      } catch (err) {
        if (isQuotaError(err)) return next(new AppError('AI service is temporarily at capacity. Please try again in a moment.', 503));
        return next(new AppError(`Email generation failed: ${err.message}`, 502));
      }
    }
    sections.push(docSection);
  }

  const englishBody = sections.join('\n\n');

  // Translate if needed
  let email, englishTranslation = null;
  if (!isEnglish) {
    try {
      const tr = await translateText(englishBody, language, model);
      translationResult = tr.result;
      email = tr.text;
      englishTranslation = englishBody;
    } catch (err) {
      if (isQuotaError(err)) return next(new AppError('AI service is temporarily at capacity. Please try again in a moment.', 503));
      return next(new AppError(`Translation failed: ${err.message}`, 502));
    }
  } else {
    email = englishBody;
  }

  logAiUsage(req, [generationResult, mergeResult, outroResult, translationResult], language);
  res.status(200).json({ success: true, email, englishTranslation });
});

// ---------------------------------------------------------------------------
// TRANSLATE EMAIL — standalone translation endpoint for live sync
// ---------------------------------------------------------------------------

exports.translateEmail = catchAsync(async (req, res, next) => {
  const { text, language } = req.body;
  if (!text?.trim()) return next(new AppError('text is required', 400));
  if (!language) return next(new AppError('language is required', 400));

  const model = genAI.getGenerativeModel({ model: MODELS.emailBuilder });
  try {
    const tr = await translateText(text, language, model);
    logAiUsage(req, [tr.result], language, 'email_translation_sync');
    res.json({ success: true, translated: tr.text });
  } catch (err) {
    if (isQuotaError(err)) return next(new AppError('AI service is temporarily at capacity. Please try again in a moment.', 503));
    return next(new AppError(`Translation failed: ${err.message}`, 502));
  }
});

// ---------------------------------------------------------------------------
// REFINE EMAIL SECTION — AI refinement with magic wand
// ---------------------------------------------------------------------------

exports.refineEmailSection = catchAsync(async (req, res, next) => {
  const { section, context, language } = req.body;
  if (!section?.trim()) return next(new AppError('section is required', 400));

  const model = genAI.getGenerativeModel({ model: MODELS.emailBuilder });
  const referenceContext = await getReferenceContext();

  const prompt = `You are a claims specialist at ReFly, a flight compensation company writing to a passenger.${referenceContext}\n\nGiven the following full email for context:\n---\n${context || ''}\n---\n\nRefine ONLY the following paragraph to be warm, professional, and contextually appropriate for a flight compensation claim email. Maintain consistency with the surrounding email tone. Output only the refined paragraph, nothing else.\n\n"${section.trim()}"`;

  let refineResult, translateResult = null;
  try {
    refineResult = await geminiQueue.run(() => model.generateContent(prompt));
  } catch (err) {
    if (isQuotaError(err)) return next(new AppError('AI service is temporarily at capacity. Please try again in a moment.', 503));
    return next(new AppError(`Refinement failed: ${err.message}`, 502));
  }

  const refined = refineResult.response.text().trim();
  let translatedRefined = null;

  if (language && language !== 'English') {
    try {
      const tr = await translateText(refined, language, model);
      translateResult = tr.result;
      translatedRefined = tr.text;
    } catch (_) {
      // Non-critical: return refined even if translation fails
    }
  }

  logAiUsage(req, [refineResult, translateResult], language, 'email_refinement');
  res.json({ success: true, refined, translatedRefined });
});

// ---------------------------------------------------------------------------
// EMAIL TEMPLATE CRUD
// ---------------------------------------------------------------------------

exports.getEmailTemplates = catchAsync(async (req, res) => {
  res.json({ success: true, templates: await getEmailTemplateList() });
});

exports.createEmailTemplate = catchAsync(async (req, res, next) => {
  const template = buildTemplateDocument(req.body);
  if (!template.key || !template.text || !template.type) {
    return next(new AppError('key, text, and type are required', 400));
  }

  const existing = await EmailTemplate.findOne({ key: template.key });
  if (existing) return next(new AppError('A template with that key already exists', 409));

  await EmailTemplate.create(template);
  res.json({ success: true, templates: await getEmailTemplateList() });
});

exports.updateEmailTemplate = catchAsync(async (req, res, next) => {
  const key = String(req.body.key || '').trim();
  if (!key) return next(new AppError('key is required', 400));

  const existing = await EmailTemplate.findOne({ key });
  if (!existing) return next(new AppError('Template not found', 404));

  const update = buildTemplateUpdate(req.body);
  if (update.text !== undefined && !update.text) {
    return next(new AppError('text is required', 400));
  }
  if (update.label !== undefined && !update.label) {
    return next(new AppError('label is required', 400));
  }

  if (Object.keys(update).length) {
    await EmailTemplate.updateOne({ key }, { $set: update }, { runValidators: true });
  }

  res.json({ success: true, templates: await getEmailTemplateList() });
});

exports.deleteEmailTemplate = catchAsync(async (req, res, next) => {
  const key = String(req.params.key || '').trim();
  if (!key) return next(new AppError('key is required', 400));

  const result = await EmailTemplate.deleteOne({ key });
  if (!result.deletedCount) return next(new AppError('Template not found', 404));

  res.json({ success: true, templates: await getEmailTemplateList() });
});

// ---------------------------------------------------------------------------
// EMAIL REFERENCE CRUD — persistent AI context
// ---------------------------------------------------------------------------

exports.getEmailReferences = catchAsync(async (req, res) => {
  const refs = await EmailReference.find().sort({ createdAt: -1 }).lean();
  res.json({ success: true, references: refs });
});

exports.createEmailReference = catchAsync(async (req, res, next) => {
  const title = String(req.body.title || '').trim();
  const content = String(req.body.content || '').trim();
  if (!title || !content) return next(new AppError('title and content are required', 400));

  const count = await EmailReference.countDocuments();
  if (count >= MAX_REFERENCES) {
    return next(new AppError(`Maximum ${MAX_REFERENCES} references allowed. Delete one first.`, 400));
  }

  await EmailReference.create({ title, content });
  const refs = await EmailReference.find().sort({ createdAt: -1 }).lean();
  res.json({ success: true, references: refs });
});

exports.deleteEmailReference = catchAsync(async (req, res, next) => {
  const id = req.params.id;
  if (!id) return next(new AppError('id is required', 400));

  const result = await EmailReference.deleteOne({ _id: id });
  if (!result.deletedCount) return next(new AppError('Reference not found', 404));

  const refs = await EmailReference.find().sort({ createdAt: -1 }).lean();
  res.json({ success: true, references: refs });
});

// ---------------------------------------------------------------------------
// ANNOUNCEMENTS KNOWLEDGE BASE
// ---------------------------------------------------------------------------

exports.getAnnouncements = catchAsync(async (req, res) => {
  const announcements = await Announcement.find().sort({ date: -1, createdAt: -1 }).lean();
  res.json({ success: true, announcements });
});

exports.addAnnouncement = catchAsync(async (req, res, next) => {
  const announcer = String(req.body.announcer || '').trim();
  const date = String(req.body.date || '').trim();
  const content = String(req.body.content || '').trim();

  if (!announcer || !date || !content) {
    return next(new AppError('announcer, date, and content are required', 400));
  }

  const model = genAI.getGenerativeModel({ model: ANNOUNCEMENT_MODEL });
  const formatPrompt = `You are a text formatter. Your ONLY job is to add HTML formatting to the announcement text below.

STRICT RULES:
1. Do not change, add, or remove words. Every original word must appear exactly as written.
2. Return only inner HTML. No <html>, <body>, <p>, markdown, or code fences.
3. Allowed tags only: <strong>, <ul>, <li>, <br>, <span style="color:...">.
4. Use <strong> for key names, deadlines, action items, or important phrases.
5. If the text has multiple distinct points or steps, convert them into a <ul><li> list.
6. Use <span style="color:#dc2626;font-weight:600"> for urgent or critical items.
7. Use <span style="color:#2563eb"> for reference numbers, codes, dates, or technical terms.
8. If the text is a single sentence with nothing to highlight, return it unchanged.

Announcement text:
"""
${content}
"""`;

  let formatResult;
  try {
    formatResult = await geminiQueue.run(() => model.generateContent(formatPrompt));
  } catch (err) {
    if (isQuotaError(err)) return next(new AppError('AI service is temporarily at capacity. Please try again in a moment.', 503));
    return next(new AppError(`Announcement formatting failed: ${err.message}`, 502));
  }
  logGeminiUsage(req, [formatResult], 'announcement_format', ANNOUNCEMENT_MODEL, { contentLength: content.length });

  const formattedContent = stripCodeFence(formatResult.response.text()) || content;

  const existingSubjects = await Announcement.distinct('subject');
  const labelPrompt = `You are a categorization assistant. Given the announcement text below and the list of existing labels, assign this announcement to the best matching existing label OR create a short new one if none fit.

EXISTING LABELS: ${existingSubjects.length ? existingSubjects.join(', ') : 'None yet'}

ANNOUNCEMENT:
"""
${content}
"""

RULES:
- Return ONLY the label text, no quotes, explanation, punctuation, or markdown.
- Prefer reusing an existing label if the topic is close enough.
- If creating a new label, use 1-3 words in Title Case.
- Keep labels generic enough to apply to future similar announcements.
- Examples: Policy Update, Schedule Change, System Maintenance, HR Notice, Training, Safety Alert`;

  let labelResult;
  try {
    labelResult = await geminiQueue.run(() => model.generateContent(labelPrompt));
  } catch (err) {
    if (isQuotaError(err)) return next(new AppError('AI service is temporarily at capacity. Please try again in a moment.', 503));
    return next(new AppError(`Announcement labeling failed: ${err.message}`, 502));
  }
  logGeminiUsage(req, [labelResult], 'announcement_label', ANNOUNCEMENT_MODEL, { contentLength: content.length });

  const subject = cleanAnnouncementLabel(labelResult.response.text());
  const announcement = await Announcement.create({ announcer, subject, date, content: formattedContent });

  res.status(201).json({ success: true, announcement });
});

exports.askAnnouncements = catchAsync(async (req, res, next) => {
  const question = String(req.body.question || '').trim();
  if (!question) return next(new AppError('Question is required', 400));

  const announcements = await Announcement.find().sort({ date: -1, createdAt: -1 }).lean();
  if (!announcements.length) {
    return res.json({
      success: true,
      ...fallbackAnnouncementAnswer('There are no announcements logged yet.')
    });
  }

  const context = announcements
    .map((a) => `${String(a._id)} | ${a.date} | ${a.announcer} | ${a.subject} | ${stripAnnouncementHtml(a.content)}`)
    .join('\n');

  const prompt = `You are an internal knowledge-base assistant for ReFly employees.

Answer the user's question using ONLY the announcements below. The announcements are sorted newest-first and each line is:
id | date | announcer | subject | content

ANNOUNCEMENTS:
${context}

QUESTION:
${question}

Return STRICT JSON only. Do not include markdown fences or explanatory text outside JSON.

JSON contract:
{
  "answer": "Plain-text answer redrafted for clarity.",
  "sources": [
    { "id": "<announcement id>", "subject": "...", "date": "YYYY-MM-DD", "announcer": "..." }
  ],
  "supersededIds": ["<older announcement id>"],
  "contradictions": [
    { "summary": "Earlier policy said X; updated policy says Y.", "ids": ["<old id>", "<new id>"] }
  ],
  "noMatch": false
}

Rules:
- Use only facts present in the announcements. Do not infer policy beyond them.
- If nothing relevant answers the question, set noMatch to true, use an apologetic one-sentence answer, and return empty sources, supersededIds, and contradictions.
- If announcements conflict, prefer the newest relevant announcement and list older superseded announcement ids in supersededIds.
- Every non-noMatch answer must cite at least one announcement in sources.
- Source ids and contradiction ids must be exact ids from the announcement list.`;

  const model = genAI.getGenerativeModel({ model: ANNOUNCEMENT_MODEL });
  let result;
  try {
    result = await geminiQueue.run(() => model.generateContent(prompt));
  } catch (err) {
    if (isQuotaError(err)) return next(new AppError('AI service is temporarily at capacity. Please try again in a moment.', 503));
    return next(new AppError(`Announcement answer failed: ${err.message}`, 502));
  }
  logGeminiUsage(req, [result], 'announcement_ask', ANNOUNCEMENT_MODEL, { questionLength: question.length });

  let payload;
  try {
    payload = JSON.parse(stripCodeFence(result.response.text()));
  } catch (_) {
    payload = fallbackAnnouncementAnswer();
  }

  res.json({
    success: true,
    ...normalizeAnnouncementAskPayload(payload, announcements)
  });
});

exports.deleteAnnouncement = catchAsync(async (req, res, next) => {
  const deleted = await Announcement.findByIdAndDelete(req.params.id);
  if (!deleted) return next(new AppError('Announcement not found', 404));

  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// EOC SYNC
// ---------------------------------------------------------------------------

exports.syncEOC = async (req, res) => {
  try {
    const previousCount = await EocRecord.countDocuments();
    console.log(`[syncEOC] Sync requested. Current count: ${previousCount}`);
    const { newCount, delta } = await syncEocFromSheet(previousCount);
    const deltaStr = delta > 0 ? `+${delta}` : String(delta);
    console.log(`[syncEOC] Done. New count: ${newCount} (${deltaStr})`);
    res.json({ success: true, newCount, delta, message: `Synced ${newCount} records, ${deltaStr} new` });
  } catch (error) {
    console.error('[syncEOC] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

