const express = require('express');
const compression = require('compression');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { tryInitFirestore, scheduleGameStateSave } = require('./firebase-firestore');

const app = express();
app.use(compression());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Serve your HTML (long cache in production; gzip/br via compression middleware)
const STATIC_MAX_AGE_MS =
  process.env.NODE_ENV === 'production' ? 86400000 * 7 : 0; /* 7d prod, dev: revalidate always */
const staticOpts = { maxAge: STATIC_MAX_AGE_MS, etag: true };
app.use(express.static(path.join(__dirname, 'city-waste-simulation'), staticOpts));
app.use(express.static(__dirname, staticOpts));

// ── Global state ──
let players = [];          // [{ id, role }]
let takenRoles = [];       // ["Municipality", "MRF", …]
const MAX_PLAYERS = 3;
const AVAILABLE_ROLES = ['Municipality', 'MRF', 'Broker'];
const DIFFICULTY_PRESETS = {
  normal: {
    id: 'normal',
    label: 'Normal',
    carbonMultiplier: 1.0,
    districtPenaltyMultiplier: 1.0,
    holdingCostMultiplier: 1.0,
    degradeEveryDays: 5,
    degradeRate: 0.1,
    projectPenaltyMultiplier: 1.0,
    bufferPenaltyMultiplier: 1.0,
    bufferPenaltyIntervalDays: 10,
    disasterFineMultiplier: 1.0,
    graceDays: 0,
    gracePenaltyMultiplier: 1.0
  },
  beginner: {
    id: 'beginner',
    label: 'Beginner',
    carbonMultiplier: 0.75,
    districtPenaltyMultiplier: 0.6,
    holdingCostMultiplier: 0.65,
    degradeEveryDays: 7,
    degradeRate: 0.1,
    projectPenaltyMultiplier: 0.4,
    bufferPenaltyMultiplier: 0.5,
    bufferPenaltyIntervalDays: 14,
    disasterFineMultiplier: 0.6,
    graceDays: 30,
    gracePenaltyMultiplier: 0.4
  }
};
let lobbyDifficulty = 'beginner';
let activeDifficulty = 'beginner';

// Shared game clock (all players see same in‑game day)
let currentDay = 1;
const MAX_DAY = 180;
/** Full round: all MAX_DAY in-game days fit in this much real time. */
const ROUND_DURATION_MINUTES = 30;
const ROUND_DURATION_MS = ROUND_DURATION_MINUTES * 60 * 1000;
/**
 * Real-time pace: one in-game day advances every REAL_MS_PER_GAME_DAY milliseconds.
 * With ROUND_DURATION_MINUTES / MAX_DAY → 10_000 ms (10 real seconds) per in-game day.
 * Note: "1 real-world second = 1 in-game day" would mean 180 days in 180 seconds (3 minutes),
 * which cannot match a 30-minute round; use this formula instead.
 */
const REAL_MS_PER_GAME_DAY = ROUND_DURATION_MS / MAX_DAY;
let dayIntervalId = null;

// Simple JSON endpoint for latest game state (works even without Socket.IO)
app.get('/state', (req, res) => {
  if (gameState) {
    try {
      if (req.query && String(req.query.reconcile) === '1') {
        recomputeUncollectedWasteTotal();
      }
    } catch (_e) {}
    return res.json(buildClientGameStatePayload(gameState));
  }
  return res.json({
    shared: null,
    roles: null,
    notStarted: true,
    difficulty: normalizeDifficulty(lobbyDifficulty),
    day: currentDay,
    maxDay: MAX_DAY,
    roundDurationMinutes: ROUND_DURATION_MINUTES,
    realSecondsPerGameDay: REAL_MS_PER_GAME_DAY / 1000
  });
});

// Game state (shared across all players)
let gameState = null;
let isGameOver = false;
// Restart coordination gate:
// When the game ends, we wait until ALL roles click "Play Again" before actually restarting.
let restartReadyRoles = new Set(); // roles that already requested restart
let isRestartGateActive = false; // only active while the game is over

// ── Inventory constraints (education/co-op balancing) ──
const INVENTORY_CAPACITY_TONNES = {
  municipality: 150,
  mrf: 150,
  broker: 150
};

// ── Districts: Residential, Commercial, Industrial ──
const DISTRICT_NAMES = ['residential', 'commercial', 'industrial'];
// Status thresholds: 0–20 Normal, 21–40 Full, 41+ Overflowing
const DISTRICT_STATUS = {
  Normal:      { maxTonnes: 20, costPerTon: 30, healthGain: 1 },
  Full:        { maxTonnes: 40, costPerTon: 40, healthGain: 2 },
  Overflowing: { maxTonnes: 1e9, costPerTon: 60, healthGain: 4 }
};
function getDistrictStatus(totalTonnes) {
  if (totalTonnes <= 20) return 'Normal';
  if (totalTonnes <= 40) return 'Full';
  return 'Overflowing';
}

// CO2 (kg per ton collected) by material
const MATERIAL_CO2 = { paper: 0.6, plastic: 1.0, metal: 0.8, glass: 0.5, wood: 0.7 };
// kg CO2 → game carbon % (e.g. 10 kg → 1%) — used for trips, waste, marketplace, etc.
const CO2_KG_TO_PERCENT = 0.1;
// One-time transportation *infrastructure* upgrades: tier.co2 is a lighter "installation impact" scale
// so a few upgrades do not instantly hit the global carbon cap (was tier.co2 * CO2_KG_TO_PERCENT, far too harsh).
const UPGRADE_INSTALLATION_CO2_TO_PERCENT = 0.012;

function normalizeDifficulty(raw) {
  const v = String(raw || '').toLowerCase();
  return DIFFICULTY_PRESETS[v] ? v : 'normal';
}

function getCurrentDifficultyKey() {
  const fromShared = gameState && gameState.shared && gameState.shared.difficulty;
  return normalizeDifficulty(fromShared || activeDifficulty || lobbyDifficulty);
}

function getDifficultyPreset() {
  return DIFFICULTY_PRESETS[getCurrentDifficultyKey()] || DIFFICULTY_PRESETS.normal;
}

function getPenaltyScalar(dayNum) {
  const cfg = getDifficultyPreset();
  const day = Number(dayNum || currentDay || 1);
  if (cfg.graceDays > 0 && day <= cfg.graceDays) return cfg.gracePenaltyMultiplier;
  return 1;
}

function co2KgToPct(kg, dayNum) {
  const cfg = getDifficultyPreset();
  const scalar = getPenaltyScalar(dayNum);
  return Math.round((Number(kg || 0) * CO2_KG_TO_PERCENT * cfg.carbonMultiplier * scalar) * 10) / 10;
}

/** Cap event log length so broadcasts stay O(1) relative to game length. */
const MAX_EVENT_LOG_ENTRIES = 200;
/** Recent log lines sent over Socket.IO /state (full log kept server-side up to MAX_EVENT_LOG_ENTRIES). */
const CLIENT_EVENT_LOG_MAX = 50;

function appendEventLog(shared, entry) {
  if (!shared || !Array.isArray(shared.eventLog)) return;
  const log = shared.eventLog;
  log.push(entry);
  if (log.length > MAX_EVENT_LOG_ENTRIES) {
    shared.eventLog = log.slice(-MAX_EVENT_LOG_ENTRIES);
  }
}

/**
 * Cumulative carbon % points by source (for dashboard sankey; avoids parsing eventLog).
 * Keys mirror dashboard `parseCO2` buckets plus mrfOperations (MRF plant CO2 not always in log text).
 */
const CARBON_BREAKDOWN_DEFAULTS = {
  collection: 0,
  projects: 0,
  transport: 0,
  marketplace: 0,
  upgrades: 0,
  passive: 0,
  mrfOperations: 0
};

function ensureCarbonBreakdown(shared) {
  if (!shared) return null;
  if (!shared.carbonBreakdown) {
    shared.carbonBreakdown = { ...CARBON_BREAKDOWN_DEFAULTS };
    return shared.carbonBreakdown;
  }
  const bd = shared.carbonBreakdown;
  Object.keys(CARBON_BREAKDOWN_DEFAULTS).forEach((k) => {
    if (typeof bd[k] !== 'number' || !Number.isFinite(bd[k])) bd[k] = CARBON_BREAKDOWN_DEFAULTS[k];
  });
  return bd;
}

function addCarbonBreakdownPct(shared, key, deltaPct) {
  if (!shared || deltaPct == null || !Number.isFinite(deltaPct) || deltaPct === 0) return;
  const bd = ensureCarbonBreakdown(shared);
  if (!bd || bd[key] === undefined) return;
  bd[key] = Math.round((bd[key] + deltaPct) * 10) / 10;
}

const TRANSPORT_MODE_BASE = {
  Truck: { deliveryDays: 3, returnDays: 3, cap: 10, co2PerTrip: 150, qty: 5, costPerTrip: 250 },
  Airport: { deliveryDays: 1, returnDays: 1, cap: 5, co2PerTrip: 500, qty: 1, costPerTrip: 400 },
  Port: { deliveryDays: 4, returnDays: 4, cap: 100, co2PerTrip: 75, qty: 1, costPerTrip: 25 }
};
const TRANSPORT_UPGRADE_TABLE = {
  speed: {
    // mult chosen so ceil(baseDays*mult) drops for Truck (3d) after the first purchase (Lv.1→2):
    // 3*0.7=2.1→3d was invisible; 3*0.65=1.95→2d.
    tiers: {
      0: { cost: 0, co2: 0, mult: 1 },
      1: { cost: 2000, co2: 200, mult: 0.85 },
      2: { cost: 3500, co2: 350, mult: 0.65 },
      3: { cost: 5500, co2: 500, mult: 0.48 },
      4: { cost: 8000, co2: 700, mult: 0.34 },
      5: { cost: 11000, co2: 900, mult: 0.25 }
    }
  },
  capacity: {
    tiers: {
      0: { cost: 0, co2: 0, mult: 1 },
      1: { cost: 3000, co2: 300, mult: 1.2 },
      2: { cost: 5000, co2: 450, mult: 1.45 },
      3: { cost: 7500, co2: 600, mult: 1.75 },
      4: { cost: 10500, co2: 800, mult: 2.1 },
      5: { cost: 14000, co2: 1000, mult: 2.5 }
    }
  },
  green: {
    tiers: {
      0: { cost: 0, co2: 0, mult: 1 },
      1: { cost: 4000, co2: 400, mult: 0.75 },
      2: { cost: 6500, co2: 550, mult: 0.5 },
      3: { cost: 9000, co2: 700, mult: 0.3 },
      4: { cost: 12000, co2: 900, mult: 0.15 },
      5: { cost: 16000, co2: 1100, mult: 0.05 }
    }
  },
  fleet: {
    tiers: {
      0: { cost: 0, co2: 0, add: 0 },
      1: { cost: 15000, co2: 380, add: 1 },
      2: { cost: 25000, co2: 520, add: 2 },
      3: { cost: 35000, co2: 680, add: 3 },
      4: { cost: 45000, co2: 820, add: 4 },
      5: { cost: 55000, co2: 980, add: 5 }
    }
  }
};

// Daily waste generation per district: tonnes per day, material mix (%), grade mix (%)
const DISTRICT_GENERATION = {
  residential: { tonnesPerDay: 3, material: { paper: 25, plastic: 25, metal: 10, glass: 15, wood: 25 }, grade: { B: 20, C: 50, F: 30 } },
  commercial:  { tonnesPerDay: 4, material: { paper: 50, plastic: 20, metal: 10, glass: 15, wood: 5 },  grade: { B: 35, C: 45, F: 20 } },
  industrial:  { tonnesPerDay: 6, material: { paper: 15, plastic: 25, metal: 30, glass: 10, wood: 20 }, grade: { B: 50, C: 35, F: 15 } }
};

// ── City Projects (Municipality) ──
const MATERIALS = ['paper', 'plastic', 'metal', 'glass', 'wood'];
const { normalizeInventoryTransferItems: normalizeInventoryTransferItemsCore } = require('./lib/normalize-inventory-transfer-items.js');

const CITY_PROJECTS = {
  park: {
    name: 'Park',
    healthGainPct: 15,
    co2ImpactKg: -10,
    costHKD: 1000,
    deadlineDays: 5,
    requiredTypesMin: 3,
    requiredTypesMax: 4
  },
  recyclingCentre: {
    name: 'Recycling Centre',
    healthGainPct: 20,
    co2ImpactKg: -25,
    costHKD: 3000,
    deadlineDays: 6,
    requiredTypesMin: 4,
    requiredTypesMax: 4
  },
  bridge: {
    name: 'Bridge',
    healthGainPct: 10,
    co2ImpactKg: 50,
    costHKD: 4000,
    deadlineDays: 8,
    requiredTypesMin: 4,
    requiredTypesMax: 4
  },
  airport: {
    name: 'Airport',
    healthGainPct: 15,
    co2ImpactKg: 200,
    costHKD: 12000,
    deadlineDays: 10,
    requiredTypesMin: 4,
    requiredTypesMax: 4
  },
  port: {
    name: 'Port',
    healthGainPct: 15,
    co2ImpactKg: 150,
    costHKD: 8000,
    deadlineDays: 9,
    requiredTypesMin: 4,
    requiredTypesMax: 4
  }
};

// Material -> waste conversion (per tonne of material consumed)
// Waste grades: B(clean), C(dirty), F(unrecyclable)
// Material grades: A(excellent), B(average), C(poor)
const MATERIAL_TO_WASTE = {
  A: { B: 0.3, C: 0.4, F: 0.3 },
  B: { B: 0.0, C: 0.6, F: 0.4 },
  C: { B: 0.0, C: 0.0, F: 1.0 }
};

// ══════════════════════════════════════════════════
// ── Marketplace Configuration ──
// ══════════════════════════════════════════════════
const VENDOR_CONFIG = {
  paper:   { name: 'Paper',   commodity: 'Wood Pulp',    basePrice: 80 },
  plastic: { name: 'Plastic', commodity: 'Crude Polymer', basePrice: 120 },
  metal:   { name: 'Metal',   commodity: 'Scrap Metal',   basePrice: 200 },
  glass:   { name: 'Glass',   commodity: 'Silica Sand',   basePrice: 60 },
  wood:    { name: 'Wood',    commodity: 'Timber',         basePrice: 50 }
};
const VENDOR_GRADE_MULTIPLIER = { A: 1.2, B: 1.0, C: 0.8 };

const TRADER_PRODUCTS = {
  paper:   ['Cardboard Box', 'Paper Roll', 'Newsprint Bundle', 'Tissue Pack'],
  plastic: ['PET Bottles', 'HDPE Container', 'Plastic Film', 'Vinyl Sheet'],
  metal:   ['Steel Utensils', 'Aluminum Cans', 'Copper Wire', 'Iron Rods'],
  glass:   ['Glass Sheet', 'Glass Bottles', 'Window Pane', 'Mirror Panel'],
  wood:    ['Lumber Pack', 'Plywood Sheet', 'Wood Chips', 'Bamboo Bundle']
};

let nextListingId = 1000;

function initMarketplace() {
  const vendor = {};
  Object.keys(VENDOR_CONFIG).forEach(mat => {
    const base = VENDOR_CONFIG[mat].basePrice;
    // Seed 10 points of history with slight variation
    const history = [];
    let p = base;
    for (let i = 0; i < 10; i++) {
      p = Math.round(Math.max(base * 0.5, Math.min(base * 2, p + (Math.random() - 0.5) * base * 0.1)) * 100) / 100;
      history.push(p);
    }
    vendor[mat] = { current: history[history.length - 1], trend: 'stable', history };
  });

  const trader = generateNewTraderListings(4);
  return { vendor, trader };
}

function generateNewTraderListings(count) {
  const listings = [];
  const mats = Object.keys(VENDOR_CONFIG);

  for (let i = 0; i < count; i++) {
    const mat = mats[Math.floor(Math.random() * mats.length)];
    const products = TRADER_PRODUCTS[mat];
    const product = products[Math.floor(Math.random() * products.length)];
    const quantity = 1 + Math.floor(Math.random() * 5);
    const grade = Math.random() > 0.3 ? 'A' : 'B';
    const basePrice = VENDOR_CONFIG[mat].basePrice;
    const price = Math.round(basePrice * quantity * (0.7 + Math.random() * 0.6) * 100) / 100;
    const durationDays = 5 + Math.floor(Math.random() * 10);

    listings.push({
      id: nextListingId++,
      material: mat,
      product,
      quantity,
      grade,
      price,
      seller: '0x' + Math.random().toString(16).substring(2, 10) + '...' + Math.random().toString(16).substring(2, 6),
      listedDay: currentDay,
      expiresDay: currentDay + durationDays,
      sold: false
    });
  }
  return listings;
}

function updateVendorPrices() {
  if (!gameState?.shared?.marketplace?.vendor) return;
  const vendor = gameState.shared.marketplace.vendor;

  Object.keys(vendor).forEach(mat => {
    const base = VENDOR_CONFIG[mat].basePrice;
    const prev = vendor[mat].current;
    const change = (Math.random() - 0.5) * base * 0.15;
    let newPrice = Math.round(Math.max(base * 0.5, Math.min(base * 2, prev + change)) * 100) / 100;

    vendor[mat].trend = newPrice > prev ? 'rising' : newPrice < prev ? 'falling' : 'stable';
    vendor[mat].current = newPrice;
    vendor[mat].history.push(newPrice);
    if (vendor[mat].history.length > 30) vendor[mat].history.shift();
  });
}

function refreshTraderListings() {
  if (!gameState?.shared?.marketplace) return;
  // Remove expired and sold listings
  gameState.shared.marketplace.trader = gameState.shared.marketplace.trader.filter(
    l => !l.sold && l.expiresDay > currentDay
  );
  // Top up to at least 3 active listings
  const active = gameState.shared.marketplace.trader.length;
  if (active < 3) {
    const newOnes = generateNewTraderListings(3 - active);
    gameState.shared.marketplace.trader.push(...newOnes);
  }
}

function addWasteByConversion(invWaste, materialKey, materialGrade, tonnes) {
  const t = Number(tonnes) || 0;
  if (t <= 0) return;
  const conv = MATERIAL_TO_WASTE[materialGrade];
  if (!conv) return;
  const dest = invWaste?.[materialKey];
  if (!dest) return;
  const add = (grade, amt) => {
    if (!amt || amt <= 0) return;
    // keep 1 decimal precision to avoid drifting
    dest[grade] = Math.round(((dest[grade] || 0) + amt) * 10) / 10;
  };
  add('B', t * conv.B);
  add('C', t * conv.C);
  add('F', t * conv.F);
}

function sampleUnique(arr, n) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.max(0, Math.min(n, copy.length)));
}

function initCityProjectsState() {
  const state = {};
  Object.keys(CITY_PROJECTS).forEach((key) => {
    state[key] = makeNewProjectInstance(key, 1);
  });
  return state;
}

function makeNewProjectInstance(projectKey, instanceNumber) {
  const cfg = CITY_PROJECTS[projectKey];
  if (!cfg) return null;
  const count = cfg.requiredTypesMin === cfg.requiredTypesMax
    ? cfg.requiredTypesMin
    : (cfg.requiredTypesMin + Math.floor(Math.random() * (cfg.requiredTypesMax - cfg.requiredTypesMin + 1)));
  const requiredTypes = sampleUnique(MATERIALS, count);
  return {
    key: projectKey,
    instance: instanceNumber,
    name: cfg.name,
    requiredTypes,
    requiredCount: requiredTypes.length,
    submittedTypes: [], // unique material types submitted
    startedDay: null,
    deadlineDay: null,
    completedDay: null
    ,regenerateOnDay: null
  };
}

function regenerateProject(projectKey) {
  if (!gameState || !gameState.shared || !gameState.shared.projects) return;
  const projects = gameState.shared.projects;
  const prev = projects[projectKey];
  const nextInstance = (prev && prev.instance ? prev.instance + 1 : 1);
  const next = makeNewProjectInstance(projectKey, nextInstance);
  if (!next) return;
  projects[projectKey] = next;
  appendEventLog(gameState.shared,{
    day: currentDay,
    message: `New project generated: ${next.name} (Instance ${next.instance}). Required: ${next.requiredTypes.join(', ')}`
  });
}

function scheduleProjectRegeneration(projectKey, dayToRegenerate) {
  if (!gameState || !gameState.shared || !gameState.shared.projects) return;
  const proj = gameState.shared.projects[projectKey];
  if (!proj) return;
  proj.regenerateOnDay = dayToRegenerate;
  appendEventLog(gameState.shared,{
    day: currentDay,
    message: `Project rotation scheduled: ${proj.name} will refresh on Day ${dayToRegenerate}`
  });
}

function processScheduledProjectRegenerations() {
  if (!gameState || !gameState.shared || !gameState.shared.projects) return;
  Object.entries(gameState.shared.projects).forEach(([key, proj]) => {
    if (!proj) return;
    if (proj.regenerateOnDay && currentDay >= proj.regenerateOnDay) {
      regenerateProject(key);
    }
  });
}

function getProjectStatus(proj, currentDayNum) {
  if (!proj) return { level: 'Not started', lateDays: 0, dailyPenaltyPct: 0 };
  if (proj.completedDay) return { level: 'Completed', lateDays: 0, dailyPenaltyPct: 0 };
  if (!proj.startedDay || !proj.deadlineDay) return { level: 'Not started', lateDays: 0, dailyPenaltyPct: 0 };
  const lateDays = Math.max(0, currentDayNum - proj.deadlineDay);
  if (lateDays <= 0) return { level: 'On Track', lateDays: 0, dailyPenaltyPct: 0 };
  if (lateDays <= 2) return { level: 'Warning', lateDays, dailyPenaltyPct: 5 };
  if (lateDays <= 4) return { level: 'Delayed', lateDays, dailyPenaltyPct: 10 };
  return { level: 'Stalled', lateDays, dailyPenaltyPct: 20 };
}

function applyProjectDeadlinePenalties() {
  if (!gameState || isGameOver) return;
  const shared = gameState.shared;
  const projects = shared.projects;
  if (!projects) return;

  const cfg = getDifficultyPreset();
  const penaltyScalar = getPenaltyScalar(currentDay);
  let totalPenalty = 0;
  Object.values(projects).forEach((proj) => {
    if (!proj || proj.completedDay) return;
    if (!proj.startedDay || !proj.deadlineDay) return;
    if (currentDay <= proj.deadlineDay) return;

    const { level, dailyPenaltyPct } = getProjectStatus(proj, currentDay);
    const scaledPenalty = Math.round(dailyPenaltyPct * cfg.projectPenaltyMultiplier * penaltyScalar * 10) / 10;
    if (scaledPenalty > 0) {
      totalPenalty += scaledPenalty;
      appendEventLog(shared,{
        day: currentDay,
        message: `Project deadline penalty (${proj.name} – ${level}): −${scaledPenalty}% City Health`
      });
    }
  });

  if (totalPenalty > 0) {
    shared.cityHealth = Math.max(0, Math.round((shared.cityHealth - totalPenalty) * 10) / 10);
  }
}

function emptyWaste() {
  // District waste quality (B/C/F)
  return {
    paper: { B: 0, C: 0, F: 0 },
    plastic: { B: 0, C: 0, F: 0 },
    metal: { B: 0, C: 0, F: 0 },
    glass: { B: 0, C: 0, F: 0 },
    wood: { B: 0, C: 0, F: 0 }
  };
}

function emptyMaterials() {
  // Material quality (A/B/C)
  return {
    paper: { A: 0, B: 0, C: 0 },
    plastic: { A: 0, B: 0, C: 0 },
    metal: { A: 0, B: 0, C: 0 },
    glass: { A: 0, B: 0, C: 0 },
    wood: { A: 0, B: 0, C: 0 }
  };
}

function emptyInventoryWaste() {
  // Waste quality (B/C/F)
  return emptyWaste();
}

function getInventoryTotal(inv) {
  if (!inv) return 0;
  let total = Math.max(0, Number(inv.unprocessedWaste || 0));
  const mats = inv.materials || {};
  const waste = inv.waste || {};
  Object.values(mats).forEach((g) => { total += (g.A || 0) + (g.B || 0) + (g.C || 0); });
  Object.values(waste).forEach((g) => { total += (g.B || 0) + (g.C || 0) + (g.F || 0); });
  return total;
}

/**
 * Sorting Centre: per material stream, consume B/C waste → recover A/B/C material.
 * F-grade waste is excluded from Sorting and must be handled by Waste Treatment.
 */
const SORT_RECOVERY_FROM_WASTE_B = { A: 0.5, B: 0.35, C: 0.15 };
const SORT_RECOVERY_FROM_WASTE_C = { A: 0.35, B: 0.4, C: 0.25 };

function sortingWasteToMaterialTonnes(wB, wC) {
  const b = Math.max(0, Number(wB) || 0);
  const c = Math.max(0, Number(wC) || 0);
  const A =
    SORT_RECOVERY_FROM_WASTE_B.A * b +
    SORT_RECOVERY_FROM_WASTE_C.A * c;
  const B =
    SORT_RECOVERY_FROM_WASTE_B.B * b +
    SORT_RECOVERY_FROM_WASTE_C.B * c;
  const C =
    SORT_RECOVERY_FROM_WASTE_B.C * b +
    SORT_RECOVERY_FROM_WASTE_C.C * c;
  return {
    A: Math.round(A * 10) / 10,
    B: Math.round(B * 10) / 10,
    C: Math.round(C * 10) / 10
  };
}

/** Sorting Centre: per material stream, consume B/C grade waste → produce A/B/C material (recovery model). */
function applyMrfSortingConversion(inv, batch) {
  if (!inv || !batch || typeof batch !== 'object') return { ok: false, error: 'Invalid sorting batch.' };
  ensureInventoryMaterials(inv);
  ensureInventoryWaste(inv);
  const cap = Number(inv.capacityTonnes || 0) || 150;

  const lines = [];
  let totalWasteProcessedT = 0;
  let netInventoryDelta = 0;

  for (const mat of MATERIALS) {
    const b = batch[mat];
    if (!b || typeof b !== 'object') continue;
    const wB = Math.round(Math.max(0, Number(b.B)) * 10) / 10;
    const wC = Math.round(Math.max(0, Number(b.C)) * 10) / 10;
    const wF = Math.round(Math.max(0, Number(b.F)) * 10) / 10;
    if (wF > 0) {
      return { ok: false, error: 'Sorting accepts only B/C waste. F-grade must go to Waste Treatment.' };
    }
    if (wB + wC <= 0) continue;

    const ww = inv.waste[mat];
    if (!ww) continue;
    if (ww.B + 1e-9 < wB || ww.C + 1e-9 < wC) {
      return { ok: false, error: `Insufficient ${mat} waste (need B ${wB} / C ${wC} t).` };
    }

    const av = inv.materials[mat];
    if (!av) continue;

    const { A: aAdd, B: bAdd, C: cAdd } = sortingWasteToMaterialTonnes(wB, wC);
    const wasteRemoved = wB + wC;
    const materialAdded = aAdd + bAdd + cAdd;
    netInventoryDelta += materialAdded - wasteRemoved;

    lines.push(
      `${mat}: −waste B${wB} C${wC} → +material A${aAdd} B${bAdd} C${cAdd}`
    );
    totalWasteProcessedT += wasteRemoved;
  }

  if (!lines.length) return { ok: false, error: 'No waste selected to sort (tick waste lines with stock).' };

  const invBefore = getInventoryTotal(inv);
  if (invBefore + netInventoryDelta > cap + 1e-6) {
    return {
      ok: false,
      error: `Sorting would exceed MRF inventory capacity (${cap} t). Free space: ${Math.max(0, Math.round((cap - invBefore) * 10) / 10)} t.`
    };
  }

  for (const mat of MATERIALS) {
    const b = batch[mat];
    if (!b || typeof b !== 'object') continue;
    const wB = Math.round(Math.max(0, Number(b.B)) * 10) / 10;
    const wC = Math.round(Math.max(0, Number(b.C)) * 10) / 10;
    const wF = Math.round(Math.max(0, Number(b.F)) * 10) / 10;
    if (wB + wC <= 0) continue;
    const ww = inv.waste[mat];
    const av = inv.materials[mat];
    const { A: aAdd, B: bAdd, C: cAdd } = sortingWasteToMaterialTonnes(wB, wC);
    ww.B -= wB;
    ww.C -= wC;
    av.A += aAdd;
    av.B += bAdd;
    av.C += cAdd;
  }

  // Global impacts: per tonne of waste processed (same scale as previous Sorting UX).
  if (gameState && gameState.shared && totalWasteProcessedT > 0) {
    const shared = gameState.shared;

    const budgetDelta = Math.round(100 * totalWasteProcessedT);
    shared.budgetHKD = Math.max(0, Math.round(shared.budgetHKD - budgetDelta));

    const healthDelta = Math.round(0.05 * totalWasteProcessedT * 10) / 10;
    shared.cityHealth = Math.max(0, Math.min(100, Math.round((shared.cityHealth + healthDelta) * 10) / 10));

    const co2Delta = Math.round(0.1 * totalWasteProcessedT * 10) / 10;
    const co2Limit =
      shared.carbonEmissions && typeof shared.carbonEmissions.limit === 'number'
        ? shared.carbonEmissions.limit
        : 100;
    const currentCo2 =
      shared.carbonEmissions && typeof shared.carbonEmissions.value === 'number'
        ? shared.carbonEmissions.value
        : 0;
    const nextCo2 = Math.min(co2Limit, Math.round((currentCo2 + co2Delta) * 10) / 10);
    if (!shared.carbonEmissions) shared.carbonEmissions = { value: 0, limit: co2Limit };
    shared.carbonEmissions.value = nextCo2;
    addCarbonBreakdownPct(shared, 'mrfOperations', co2Delta);

    return {
      ok: true,
      summary: lines.join(' · '),
      totals: {
        wasteTonnes: totalWasteProcessedT,
        budgetDelta: -budgetDelta,
        healthDelta,
        co2Delta
      }
    };
  }

  return { ok: true, summary: lines.join(' · '), totals: { wasteTonnes: totalWasteProcessedT } };
}

/**
 * Recycling Centre grade upgrades (step model):
 * - C -> B (+ F residue)
 * - B -> A (+ F residue)
 * Mass balance per tonne per step:
 * - C 1.0 -> B 0.5 + F 0.5
 * - B 1.0 -> A 0.5 + F 0.5
 */
const RECYCLING_STEP_OUTPUT = {
  cToB: { B: 0.5, F: 0.5 },
  bToA: { A: 0.5, F: 0.5 }
};

function applyMrfRecyclingCentreConversion(inv, batch) {
  if (!inv || !batch || typeof batch !== 'object') return { ok: false, error: 'Invalid recycling batch.' };
  ensureInventoryMaterials(inv);
  ensureInventoryWaste(inv);
  const lines = [];
  let totalCToBT = 0;
  let totalBToAT = 0;

  for (const mat of MATERIALS) {
    const raw = batch[mat];
    const tCToB = Math.round(Math.max(0, Number((raw && typeof raw === 'object') ? raw.cToB : raw)) * 10) / 10;
    const tBToA = Math.round(Math.max(0, Number((raw && typeof raw === 'object') ? raw.bToA : 0)) * 10) / 10;
    if (tCToB <= 0 && tBToA <= 0) continue;

    const av = inv.materials[mat];
    const ww = inv.waste[mat];
    if (!av || !ww) continue;
    if ((av.C || 0) + 1e-9 < tCToB) {
      return { ok: false, error: `Insufficient ${mat} material Grade C (need ${tCToB} t, have ${av.C || 0}).` };
    }
    if ((av.B || 0) + 1e-9 < tBToA) {
      return { ok: false, error: `Insufficient ${mat} material Grade B (need ${tBToA} t, have ${av.B || 0}).` };
    }

    const bFromC = Math.round(tCToB * RECYCLING_STEP_OUTPUT.cToB.B * 10) / 10;
    const fFromC = Math.round(tCToB * RECYCLING_STEP_OUTPUT.cToB.F * 10) / 10;
    const aFromB = Math.round(tBToA * RECYCLING_STEP_OUTPUT.bToA.A * 10) / 10;
    const fFromB = Math.round(tBToA * RECYCLING_STEP_OUTPUT.bToA.F * 10) / 10;

    if (tCToB > 0) lines.push(`${mat}: −C ${tCToB} t → +B ${bFromC} t +F ${fFromC} t`);
    if (tBToA > 0) lines.push(`${mat}: −B ${tBToA} t → +A ${aFromB} t +F ${fFromB} t`);
    totalCToBT += tCToB;
    totalBToAT += tBToA;
  }

  if (!lines.length) return { ok: false, error: 'Enter C→B or B→A tonnes to recycle (at least one stream).' };

  for (const mat of MATERIALS) {
    const raw = batch[mat];
    const tCToB = Math.round(Math.max(0, Number((raw && typeof raw === 'object') ? raw.cToB : raw)) * 10) / 10;
    const tBToA = Math.round(Math.max(0, Number((raw && typeof raw === 'object') ? raw.bToA : 0)) * 10) / 10;
    if (tCToB <= 0 && tBToA <= 0) continue;
    const av = inv.materials[mat];
    const ww = inv.waste[mat];
    if (tCToB > 0) {
      av.C -= tCToB;
      av.B += Math.round(tCToB * RECYCLING_STEP_OUTPUT.cToB.B * 10) / 10;
      ww.F += Math.round(tCToB * RECYCLING_STEP_OUTPUT.cToB.F * 10) / 10;
    }
    if (tBToA > 0) {
      av.B -= tBToA;
      av.A += Math.round(tBToA * RECYCLING_STEP_OUTPUT.bToA.A * 10) / 10;
      ww.F += Math.round(tBToA * RECYCLING_STEP_OUTPUT.bToA.F * 10) / 10;
    }
  }

  const totalProcessedT = Math.round((totalCToBT + totalBToAT) * 10) / 10;
  if (gameState && gameState.shared && totalProcessedT > 0) {
    const shared = gameState.shared;
    const budgetDelta = Math.round(70 * totalProcessedT);
    shared.budgetHKD = Math.max(0, Math.round(shared.budgetHKD - budgetDelta));
    const healthDelta = Math.round(0.03 * totalProcessedT * 10) / 10;
    shared.cityHealth = Math.max(0, Math.min(100, Math.round((shared.cityHealth + healthDelta) * 10) / 10));
    const co2Delta = Math.round(0.06 * totalProcessedT * 10) / 10;
    const co2Limit =
      shared.carbonEmissions && typeof shared.carbonEmissions.limit === 'number'
        ? shared.carbonEmissions.limit
        : 100;
    const currentCo2 =
      shared.carbonEmissions && typeof shared.carbonEmissions.value === 'number'
        ? shared.carbonEmissions.value
        : 0;
    const nextCo2 = Math.min(co2Limit, Math.round((currentCo2 + co2Delta) * 10) / 10);
    if (!shared.carbonEmissions) shared.carbonEmissions = { value: 0, limit: co2Limit };
    shared.carbonEmissions.value = nextCo2;
    addCarbonBreakdownPct(shared, 'mrfOperations', co2Delta);

    return {
      ok: true,
      summary: lines.join(' · '),
      totals: {
        cToBTonnes: totalCToBT,
        bToATonnes: totalBToAT,
        budgetDelta: -budgetDelta,
        healthDelta,
        co2Delta
      }
    };
  }

  return { ok: true, summary: lines.join(' · '), totals: { cToBTonnes: totalCToBT, bToATonnes: totalBToAT } };
}

/** Layer 1 → Layer 2 — coefficients per tonne F-grade waste (sync with mrf-inventory WASTE_TREATMENT_TREE). */
const WASTE_TREATMENT_METHOD_SPECS = {
  thermal: {
    mass_burn: { costPerTon: 420, co2PerTon: 0.14, healthPerTon: 0.02 },
    clean_pyrolysis: { costPerTon: 480, co2PerTon: 0.1, healthPerTon: 0.03 }
  },
  landfill: {
    sanitary: { costPerTon: 160, co2PerTon: 0.28, healthPerTon: -0.04 },
    bioreactor: { costPerTon: 200, co2PerTon: 0.22, healthPerTon: 0.015 },
    controlled: { costPerTon: 240, co2PerTon: 0.32, healthPerTon: -0.06 }
  },
  open_dump: {
    informal: { costPerTon: 35, co2PerTon: 0.5, healthPerTon: -0.22 },
    semi_controlled: { costPerTon: 85, co2PerTon: 0.36, healthPerTon: -0.12 },
    remediation: { costPerTon: 300, co2PerTon: 0.2, healthPerTon: 0.04 }
  },
  advanced: {
    gasification: { costPerTon: 560, co2PerTon: 0.07, healthPerTon: 0.035 },
    pyrolysis_oil: { costPerTon: 540, co2PerTon: 0.09, healthPerTon: 0.035 },
    mbt: { costPerTon: 600, co2PerTon: 0.055, healthPerTon: 0.045 }
  }
};

const WASTE_TREATMENT_MATERIAL_KEYS = [...MATERIALS, 'material6'];

function applyMrfWasteTreatment(inv, category, subMethod, batch) {
  if (!inv || !batch || typeof batch !== 'object') return { ok: false, error: 'Invalid treatment batch.' };
  const cat = String(category || '').trim().toLowerCase();
  const sub = String(subMethod || '').trim().toLowerCase();
  const spec = WASTE_TREATMENT_METHOD_SPECS[cat] && WASTE_TREATMENT_METHOD_SPECS[cat][sub];
  if (!spec) return { ok: false, error: 'Unknown treatment category / sub-method.' };

  ensureInventoryWaste(inv);
  if (!inv.waste.material6) inv.waste.material6 = { B: 0, C: 0, F: 0 };
  const lines = [];
  let totalT = 0;

  for (const mat of WASTE_TREATMENT_MATERIAL_KEYS) {
    const b = batch[mat];
    if (!b || typeof b !== 'object') continue;
    const wF = Math.round(Math.max(0, Number(b.F)) * 10) / 10;
    if (wF <= 0) continue;
    const ww = inv.waste[mat];
    if (!ww) continue;
    if (ww.F + 1e-9 < wF) {
      return { ok: false, error: `Insufficient ${mat} F-grade waste (need ${wF} t).` };
    }
    totalT += wF;
    lines.push(`${mat} F ${wF}t`);
  }

  if (totalT <= 0) return { ok: false, error: 'No F-grade waste in batch.' };

  const costHkd = Math.round(spec.costPerTon * totalT);
  const co2Delta = Math.round(spec.co2PerTon * totalT * 10) / 10;
  const healthDelta = Math.round(spec.healthPerTon * totalT * 10) / 10;

  for (const mat of WASTE_TREATMENT_MATERIAL_KEYS) {
    const b = batch[mat];
    if (!b || typeof b !== 'object') continue;
    const wF = Math.round(Math.max(0, Number(b.F)) * 10) / 10;
    if (wF <= 0) continue;
    inv.waste[mat].F -= wF;
  }

  if (gameState && gameState.shared) {
    const shared = gameState.shared;
    shared.budgetHKD = Math.max(0, Math.round(shared.budgetHKD - costHkd));
    shared.cityHealth = Math.max(0, Math.min(100, Math.round((shared.cityHealth + healthDelta) * 10) / 10));
    const co2Limit =
      shared.carbonEmissions && typeof shared.carbonEmissions.limit === 'number'
        ? shared.carbonEmissions.limit
        : 100;
    const currentCo2 =
      shared.carbonEmissions && typeof shared.carbonEmissions.value === 'number'
        ? shared.carbonEmissions.value
        : 0;
    const nextCo2 = Math.min(co2Limit, Math.round((currentCo2 + co2Delta) * 10) / 10);
    if (!shared.carbonEmissions) shared.carbonEmissions = { value: 0, limit: co2Limit };
    shared.carbonEmissions.value = nextCo2;
    addCarbonBreakdownPct(shared, 'mrfOperations', co2Delta);
  }

  return {
    ok: true,
    summary: lines.join(' · '),
    totals: {
      wasteTonnes: Math.round(totalT * 10) / 10,
      budgetDelta: -costHkd,
      co2Delta,
      healthDelta
    },
    methodLabel: `${cat}/${sub}`
  };
}

function normalizeTransferItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((it) => ({
    material: String(it && it.material ? it.material : '').toLowerCase(),
    grade: String(it && it.grade ? it.grade : '').toUpperCase(),
    tonnes: Math.max(0, Math.floor(Number(it && it.tonnes ? it.tonnes : 0)))
  })).filter((it) => MATERIALS.includes(it.material) && ['B', 'C', 'F'].includes(it.grade) && it.tonnes > 0);
}

function transferWasteBetweenRoles(fromKey, toKey, rawItems) {
  if (!gameState || !gameState.roles) return { ok: false, error: 'Game state unavailable.' };
  const fromInv = gameState.roles[fromKey] && gameState.roles[fromKey].inventory;
  const toInv = gameState.roles[toKey] && gameState.roles[toKey].inventory;
  if (!fromInv || !toInv) return { ok: false, error: 'Source or target inventory missing.' };

  const items = normalizeTransferItems(rawItems);
  if (!items.length) return { ok: false, error: 'No valid waste items to transfer.' };

  const requestedTotal = items.reduce((s, it) => s + it.tonnes, 0);
  const toCap = Number(toInv.capacityTonnes || 0);
  const toCurrent = getInventoryTotal(toInv);
  if (toCurrent + requestedTotal > toCap) {
    const free = Math.max(0, Math.floor((toCap - toCurrent) * 10) / 10);
    return { ok: false, error: `Target inventory capacity exceeded. Free capacity: ${free} t.` };
  }

  for (const it of items) {
    const available = Number((fromInv.waste && fromInv.waste[it.material] && fromInv.waste[it.material][it.grade]) || 0);
    if (available < it.tonnes) {
      return { ok: false, error: `Insufficient ${it.material} (${it.grade}) in source inventory.` };
    }
  }

  items.forEach((it) => {
    fromInv.waste[it.material][it.grade] -= it.tonnes;
    toInv.waste[it.material][it.grade] += it.tonnes;
  });

  return { ok: true, items, totalTonnes: requestedTotal };
}

function transferInventoryBetweenRoles(fromKey, toKey, rawItems) {
  if (!gameState || !gameState.roles) return { ok: false, error: 'Game state unavailable.' };
  const fromInv = gameState.roles[fromKey] && gameState.roles[fromKey].inventory;
  const toInv = gameState.roles[toKey] && gameState.roles[toKey].inventory;
  if (!fromInv || !toInv) return { ok: false, error: 'Source or target inventory missing.' };
  ensureInventoryMaterials(fromInv);
  ensureInventoryWaste(fromInv);
  ensureInventoryMaterials(toInv);
  ensureInventoryWaste(toInv);
  const items = normalizeInventoryTransferItems(rawItems);
  if (!items.length) return { ok: false, error: 'No valid inventory items to transfer.' };
  const requestedTotal = items.reduce((s, it) => s + it.tonnes, 0);
  const toCap = Number(toInv.capacityTonnes || 0);
  const toCurrent = getInventoryTotal(toInv);
  if (toCurrent + requestedTotal > toCap) {
    const free = Math.max(0, Math.floor((toCap - toCurrent) * 10) / 10);
    return { ok: false, error: `Target inventory capacity exceeded. Free capacity: ${free} t.` };
  }
  for (const it of items) {
    const bucket = it.kind === 'material' ? fromInv.materials : fromInv.waste;
    const available = Number((bucket[it.material] && bucket[it.material][it.grade]) || 0);
    if (available < it.tonnes) {
      return { ok: false, error: `Insufficient ${it.kind} ${it.material} (${it.grade}) in source inventory.` };
    }
  }
  items.forEach((it) => {
    const fromBucket = it.kind === 'material' ? fromInv.materials : fromInv.waste;
    const toBucket = it.kind === 'material' ? toInv.materials : toInv.waste;
    fromBucket[it.material][it.grade] -= it.tonnes;
    toBucket[it.material][it.grade] += it.tonnes;
  });
  return { ok: true, items, totalTonnes: requestedTotal };
}

function ensureInventoryWaste(inv) {
  if (!inv) return;
  if (!inv.waste) inv.waste = emptyInventoryWaste();
  MATERIALS.forEach((mat) => {
    if (!inv.waste[mat]) inv.waste[mat] = { B: 0, C: 0, F: 0 };
  });
}

function ensureInventoryMaterials(inv) {
  if (!inv) return;
  if (!inv.materials) inv.materials = emptyMaterials();
  MATERIALS.forEach((mat) => {
    if (!inv.materials[mat]) inv.materials[mat] = { A: 0, B: 0, C: 0 };
  });
}

/** @param {unknown[]} items @param {{ requireExplicitKind?: boolean }} [opts] */
function normalizeInventoryTransferItems(items, opts) {
  return normalizeInventoryTransferItemsCore(items, MATERIALS, opts || {});
}

function removeInventoryItems(fromInv, rawItems) {
  if (!fromInv) return { ok: false, error: 'Source inventory missing.' };
  ensureInventoryWaste(fromInv);
  ensureInventoryMaterials(fromInv);
  const items = normalizeInventoryTransferItems(rawItems);
  if (!items.length) return { ok: false, error: 'No valid inventory items.' };
  for (const it of items) {
    const bucket = it.kind === 'material' ? fromInv.materials : fromInv.waste;
    const available = Number((bucket[it.material] && bucket[it.material][it.grade]) || 0);
    if (available < it.tonnes) {
      return { ok: false, error: `Insufficient ${it.kind} ${it.material} (${it.grade}) in source inventory.` };
    }
  }
  items.forEach((it) => {
    const bucket = it.kind === 'material' ? fromInv.materials : fromInv.waste;
    bucket[it.material][it.grade] -= it.tonnes;
  });
  return { ok: true, items, totalTonnes: items.reduce((s, it) => s + it.tonnes, 0) };
}

function removeInventoryItemsFromRole(roleKey, rawItems) {
  if (!gameState || !gameState.roles || !gameState.roles[roleKey]) return { ok: false, error: 'Role missing.' };
  return removeInventoryItems(gameState.roles[roleKey].inventory, rawItems);
}

function addInventoryItems(toInv, rawItems) {
  if (!toInv) return { ok: false, error: 'Target inventory missing.' };
  ensureInventoryWaste(toInv);
  ensureInventoryMaterials(toInv);
  const items = normalizeInventoryTransferItems(rawItems);
  if (!items.length) return { ok: false, error: 'No valid inventory items.' };
  const requestedTotal = items.reduce((s, it) => s + it.tonnes, 0);
  const toCap = Number(toInv.capacityTonnes || 0);
  const toCurrent = getInventoryTotal(toInv);
  if (toCurrent + requestedTotal > toCap) {
    const free = Math.max(0, Math.floor((toCap - toCurrent) * 10) / 10);
    return { ok: false, error: `Target inventory capacity exceeded. Free capacity: ${free} t.` };
  }
  items.forEach((it) => {
    const bucket = it.kind === 'material' ? toInv.materials : toInv.waste;
    bucket[it.material][it.grade] += it.tonnes;
  });
  return { ok: true, items, totalTonnes: requestedTotal };
}

function addInventoryItemsToRole(roleKey, rawItems) {
  if (!gameState || !gameState.roles || !gameState.roles[roleKey]) return { ok: false, error: 'Role missing.' };
  return addInventoryItems(gameState.roles[roleKey].inventory, rawItems);
}

function removeWasteFromInventory(fromInv, rawItems) {
  if (!fromInv) return { ok: false, error: 'Source inventory missing.' };
  ensureInventoryWaste(fromInv);
  const items = normalizeTransferItems(rawItems);
  if (!items.length) return { ok: false, error: 'No valid waste items.' };
  for (const it of items) {
    const available = Number((fromInv.waste[it.material] && fromInv.waste[it.material][it.grade]) || 0);
    if (available < it.tonnes) {
      return { ok: false, error: `Insufficient ${it.material} (${it.grade}) in source inventory.` };
    }
  }
  items.forEach((it) => {
    fromInv.waste[it.material][it.grade] -= it.tonnes;
  });
  return { ok: true, items, totalTonnes: items.reduce((s, it) => s + it.tonnes, 0) };
}

function removeWasteFromRole(roleKey, rawItems) {
  if (!gameState || !gameState.roles || !gameState.roles[roleKey]) return { ok: false, error: 'Role missing.' };
  return removeWasteFromInventory(gameState.roles[roleKey].inventory, rawItems);
}

function addWasteToInventory(toInv, rawItems) {
  if (!toInv) return { ok: false, error: 'Target inventory missing.' };
  ensureInventoryWaste(toInv);
  const items = normalizeTransferItems(rawItems);
  if (!items.length) return { ok: false, error: 'No valid waste items.' };
  const requestedTotal = items.reduce((s, it) => s + it.tonnes, 0);
  const toCap = Number(toInv.capacityTonnes || 0);
  const toCurrent = getInventoryTotal(toInv);
  if (toCurrent + requestedTotal > toCap) {
    const free = Math.max(0, Math.floor((toCap - toCurrent) * 10) / 10);
    return { ok: false, error: `Target inventory capacity exceeded. Free capacity: ${free} t.` };
  }
  items.forEach((it) => {
    toInv.waste[it.material][it.grade] += it.tonnes;
  });
  return { ok: true, items, totalTonnes: requestedTotal };
}

function addWasteToRole(roleKey, rawItems) {
  if (!gameState || !gameState.roles || !gameState.roles[roleKey]) return { ok: false, error: 'Role missing.' };
  return addWasteToInventory(gameState.roles[roleKey].inventory, rawItems);
}

function ensurePendingDeliveries() {
  if (!gameState || !gameState.shared) return;
  if (!Array.isArray(gameState.shared.pendingDeliveries)) gameState.shared.pendingDeliveries = [];
}

/** In-flight payloads before kind was enforced: A→material, F/B/C→waste (historical broker pulls were waste-only for B/C). */
function ensureDeliveryItemKind(it) {
  if (!it || typeof it !== 'object') return it;
  if (it.kind === 'material' || it.kind === 'waste') return it;
  const g = String(it.grade || '').toUpperCase();
  if (g === 'A') return { ...it, kind: 'material' };
  if (g === 'F') return { ...it, kind: 'waste' };
  if (g === 'B' || g === 'C') return { ...it, kind: 'waste' };
  return it;
}

function processPendingDeliveries() {
  if (!gameState || !gameState.shared || isGameOver) return;
  ensurePendingDeliveries();
  const list = gameState.shared.pendingDeliveries;
  const remaining = [];
  for (const p of list) {
    if (currentDay < p.arriveDay) {
      remaining.push(p);
      continue;
    }
    const roleKey = p.targetRole === 'municipality' ? 'municipality' : p.targetRole === 'mrf' ? 'mrf' : 'broker';
    const arrivalItems = Array.isArray(p.items) ? p.items.map(ensureDeliveryItemKind) : [];
    const result = addInventoryItemsToRole(roleKey, arrivalItems);
    if (!result.ok) {
      p.arriveDay = currentDay + 1;
      remaining.push(p);
      appendEventLog(gameState.shared,{
        day: currentDay,
        message: `Delivery deferred (${roleKey}): ${result.error} — will retry next day.`
      });
      continue;
    }
    const label = roleKey === 'municipality' ? 'Municipality' : roleKey === 'mrf' ? 'MRF' : 'Broker';
    const summary = result.items.map((it) => `${it.tonnes} t ${it.material} (${it.grade})`).join(', ');
    appendEventLog(gameState.shared,{
      day: currentDay,
      message: `Shipment arrived at ${label}: ${summary}`
    });
  }
  gameState.shared.pendingDeliveries = remaining;
}

function collectAllWasteItems(roleKey) {
  if (!gameState || !gameState.roles || !gameState.roles[roleKey] || !gameState.roles[roleKey].inventory) return [];
  const invWaste = gameState.roles[roleKey].inventory.waste || {};
  const out = [];
  MATERIALS.forEach((mat) => {
    ['B', 'C', 'F'].forEach((grade) => {
      const tonnes = Math.max(0, Math.floor(Number((invWaste[mat] && invWaste[mat][grade]) || 0)));
      if (tonnes > 0) out.push({ material: mat, grade, tonnes });
    });
  });
  return out;
}

function collectAllInventoryItems(roleKey) {
  if (!gameState || !gameState.roles || !gameState.roles[roleKey] || !gameState.roles[roleKey].inventory) return [];
  const inv = gameState.roles[roleKey].inventory;
  ensureInventoryMaterials(inv);
  ensureInventoryWaste(inv);
  const out = [];
  MATERIALS.forEach((mat) => {
    ['A', 'B', 'C'].forEach((grade) => {
      const tonnes = Math.max(0, Math.floor(Number((inv.materials[mat] && inv.materials[mat][grade]) || 0)));
      if (tonnes > 0) out.push({ material: mat, grade, tonnes, kind: 'material' });
    });
    ['B', 'C', 'F'].forEach((grade) => {
      const tonnes = Math.max(0, Math.floor(Number((inv.waste[mat] && inv.waste[mat][grade]) || 0)));
      if (tonnes > 0) out.push({ material: mat, grade, tonnes, kind: 'waste' });
    });
  });
  return out;
}

function normalizeTransportMeta(data) {
  const typeRaw = String(data && data.transportType ? data.transportType : 'Truck');
  const allowed = ['Truck', 'Airport', 'Port'];
  const transportType = allowed.includes(typeRaw) ? typeRaw : 'Truck';
  const transportUnits = Math.max(1, Math.floor(Number(data && data.transportUnits ? data.transportUnits : 1) || 1));
  return { transportType, transportUnits };
}

function computeBrokerTransportConfig(broker, transportType) {
  const base = TRANSPORT_MODE_BASE[transportType] || TRANSPORT_MODE_BASE.Truck;
  // Same upgrade track (speed / capacity / green / fleet) applies to Truck, Airport, and Port
  // so inventory transfers and previews stay consistent across modes.
  const ups = (broker && broker.transportation && broker.transportation.upgrades) || {};
  const speedLv = Math.max(0, Number(ups.speed || 0));
  const capacityLv = Math.max(0, Number(ups.capacity || 0));
  const greenLv = Math.max(0, Number(ups.green || 0));
  const fleetLv = Math.max(0, Number(ups.fleet || 0));
  const speedMult = TRANSPORT_UPGRADE_TABLE.speed.tiers[speedLv]?.mult ?? 1;
  const capMult = TRANSPORT_UPGRADE_TABLE.capacity.tiers[capacityLv]?.mult ?? 1;
  const greenMult = TRANSPORT_UPGRADE_TABLE.green.tiers[greenLv]?.mult ?? 1;
  const fleetAdd = TRANSPORT_UPGRADE_TABLE.fleet.tiers[fleetLv]?.add ?? 0;
  return {
    deliveryDays: Math.max(1, Math.ceil(base.deliveryDays * speedMult)),
    returnDays: Math.max(1, Math.ceil(base.returnDays * speedMult)),
    cap: Math.max(1, Math.floor(base.cap * capMult)),
    co2PerTrip: Math.max(1, Math.floor(base.co2PerTrip * greenMult)),
    qty: Math.max(1, base.qty + fleetAdd),
    costPerTrip: base.costPerTrip
  };
}

function ensureBrokerTransportState(broker) {
  if (!broker.transportation) {
    broker.transportation = {
      currentLoadTonnes: 0,
      capacityTonnes: 150,
      inUseCount: 0,
      upgrades: { speed: 0, capacity: 0, green: 0, fleet: 0 },
      activeTrips: []
    };
  }
  if (!broker.transportation.upgrades) broker.transportation.upgrades = { speed: 0, capacity: 0, green: 0, fleet: 0 };
  if (!Array.isArray(broker.transportation.activeTrips)) broker.transportation.activeTrips = [];
}

function getTransportAvailability(broker, transportType) {
  ensureBrokerTransportState(broker);
  const cfg = computeBrokerTransportConfig(broker, transportType);
  const inUse = broker.transportation.activeTrips.reduce((sum, t) => {
    if (t.transportType !== transportType) return sum;
    if (Number(t.returnDay || 0) > currentDay) return sum + Math.max(0, Number(t.transportUnits || 0));
    return sum;
  }, 0);
  return { totalQty: cfg.qty, inUse, available: Math.max(0, cfg.qty - inUse), cfg };
}

function processBrokerTripReturns() {
  if (!gameState || !gameState.roles || !gameState.roles.broker) return;
  const broker = gameState.roles.broker;
  ensureBrokerTransportState(broker);
  const active = broker.transportation.activeTrips;
  const stillActive = [];
  active.forEach((trip) => {
    if (Number(trip.returnDay || 0) <= currentDay) {
      appendEventLog(gameState.shared,{
        day: currentDay,
        message: `Transport returned: ${trip.transportType} x${trip.transportUnits} (${trip.from} -> ${trip.to})`
      });
    } else {
      stillActive.push(trip);
    }
  });
  broker.transportation.activeTrips = stillActive;
  broker.transportation.inUseCount = stillActive.reduce((s, t) => s + Math.max(0, Number(t.transportUnits || 0)), 0);
}

/** Older broker queues omitted kind; A-only as material, all else treated as waste (legacy). */
function ensureBrokerQueueItemKind(it) {
  const material = String(it && it.material ? it.material : '').toLowerCase();
  const grade = String(it && it.grade ? it.grade : '').toUpperCase();
  /** Match normalizeInventoryTransferItems (0.1 t steps); Math.floor dropped fractional tonnes < 1. */
  const tonnes = Math.max(0, Math.round(Number(it && it.tonnes != null ? it.tonnes : 0) * 10) / 10);
  let kind = it.kind;
  if (kind !== 'material' && kind !== 'waste') {
    kind = grade === 'A' ? 'material' : 'waste';
  }
  return { material, grade, tonnes, kind };
}

function brokerQueueKey(it) {
  const n = ensureBrokerQueueItemKind(it);
  return `${n.kind}:${n.material}:${n.grade}`;
}

/** Legacy array queue → aggregated map (key = kind:material:grade). */
function brokerQueueArrayToMap(arr) {
  const map = {};
  (arr || []).forEach((pit) => {
    const n = ensureBrokerQueueItemKind(pit);
    const key = brokerQueueKey(n);
    map[key] = (map[key] || 0) + n.tonnes;
  });
  return map;
}

/** Map → array for Socket.IO clients (broker-inventory expects []). */
function brokerQueueMapToArray(map) {
  if (!map || typeof map !== 'object') return [];
  if (Array.isArray(map)) return map;
  const out = [];
  for (const [key, tonnes] of Object.entries(map)) {
    const t = Number(tonnes) || 0;
    if (t <= 0) continue;
    const parts = key.split(':');
    if (parts.length < 3) continue;
    const kind = parts[0];
    const grade = parts[parts.length - 1];
    const material = parts.slice(1, -1).join(':');
    out.push({ kind, material, grade, tonnes: t });
  }
  return out;
}

function ensureBrokerTransferRequests() {
  if (!gameState || !gameState.shared) return;
  if (!gameState.shared.brokerTransferRequests) {
    gameState.shared.brokerTransferRequests = { municipality: {}, mrf: {} };
  }
  for (const k of ['municipality', 'mrf']) {
    const q = gameState.shared.brokerTransferRequests[k];
    if (Array.isArray(q)) {
      gameState.shared.brokerTransferRequests[k] = brokerQueueArrayToMap(q);
    } else if (!q || typeof q !== 'object' || Array.isArray(q)) {
      gameState.shared.brokerTransferRequests[k] = {};
    }
  }
}

const MIN_MRF_BROKER_REQUEST_TONNES = 1;

function addBrokerTransferRequest(sourceKey, rawItems) {
  ensureBrokerTransferRequests();
  const items = normalizeInventoryTransferItems(rawItems);
  if (!items.length) return { ok: false, error: 'No valid items to request (material & waste need kind for grade B/C).' };
  if (sourceKey === 'mrf') {
    const totalT = items.reduce((s, it) => s + (Number(it.tonnes) || 0), 0);
    if (totalT + 1e-9 < MIN_MRF_BROKER_REQUEST_TONNES) {
      return {
        ok: false,
        error: `MRF → Broker requests need at least ${MIN_MRF_BROKER_REQUEST_TONNES} t total per shipment (got ${Math.round(totalT * 10) / 10} t).`
      };
    }
  }
  const sourceInv = gameState.roles[sourceKey] && gameState.roles[sourceKey].inventory;
  if (!sourceInv) return { ok: false, error: 'Source inventory missing.' };
  ensureInventoryMaterials(sourceInv);
  ensureInventoryWaste(sourceInv);
  for (const it of items) {
    const bucket = it.kind === 'material' ? sourceInv.materials : sourceInv.waste;
    const available = Number((bucket[it.material] && bucket[it.material][it.grade]) || 0);
    if (available < it.tonnes) {
      return { ok: false, error: `Insufficient ${it.kind} ${it.material} (${it.grade}) in source inventory.` };
    }
  }
  const targetMap = gameState.shared.brokerTransferRequests[sourceKey];
  items.forEach((it) => {
    const n = ensureBrokerQueueItemKind(it);
    const key = brokerQueueKey(n);
    targetMap[key] = (targetMap[key] || 0) + n.tonnes;
  });
  return { ok: true, items };
}

function consumeBrokerTransferRequest(sourceKey, rawItems) {
  ensureBrokerTransferRequests();
  const items = normalizeInventoryTransferItems(rawItems);
  if (!items.length) return { ok: false, error: 'No valid items to collect.' };
  const pendingMap = { ...gameState.shared.brokerTransferRequests[sourceKey] };
  for (const it of items) {
    const key = brokerQueueKey(it);
    if ((pendingMap[key] || 0) < it.tonnes) {
      return {
        ok: false,
        error: `Requested collect exceeds pending amount for ${it.kind} ${it.material} (${it.grade}).`
      };
    }
  }
  const needMap = {};
  items.forEach((it) => {
    const key = brokerQueueKey(it);
    needMap[key] = (needMap[key] || 0) + it.tonnes;
  });
  Object.keys(needMap).forEach((key) => {
    pendingMap[key] = (pendingMap[key] || 0) - needMap[key];
    if (pendingMap[key] <= 1e-9) delete pendingMap[key];
  });
  gameState.shared.brokerTransferRequests[sourceKey] = pendingMap;
  return { ok: true, items };
}

function getDistrictTotal(district) {
  if (!gameState || !gameState.shared.districts || !gameState.shared.districts[district]) return 0;
  const w = gameState.shared.districts[district].waste;
  let t = 0;
  Object.values(w).forEach((g) => { Object.values(g).forEach((n) => { t += n; }); });
  return t;
}

/** Full scan of districts — shared.waste.totalTonnes = uncollected in districts; use for init / ?reconcile=1. */
function recomputeUncollectedWasteTotal() {
  if (!gameState || !gameState.shared || !gameState.shared.districts) return 0;
  let total = 0;
  DISTRICT_NAMES.forEach((k) => { total += getDistrictTotal(k); });
  gameState.shared.waste.totalTonnes = total;
  return total;
}

/** O(1) update when district waste changes (must stay in sync with addWasteToDistrict / collection). */
function adjustUncollectedWasteTotal(delta) {
  if (!gameState || !gameState.shared || !gameState.shared.waste) return;
  const w = gameState.shared.waste;
  const next = Math.max(0, Math.round((Number(w.totalTonnes) + delta) * 10) / 10);
  w.totalTonnes = next;
}

/** Slim payload for Socket.IO / GET /state: shorter eventLog + broker queues as arrays (server keeps full log & map). */
function buildClientGameStatePayload(gs) {
  if (!gs || !gs.shared) return gs;
  const shared = gs.shared;
  const br = shared.brokerTransferRequests;
  const brokerSerialized = br
    ? {
        municipality: brokerQueueMapToArray(br.municipality),
        mrf: brokerQueueMapToArray(br.mrf)
      }
    : { municipality: [], mrf: [] };
  const eventLog = Array.isArray(shared.eventLog)
    ? shared.eventLog.slice(-CLIENT_EVENT_LOG_MAX)
    : [];
  return {
    ...gs,
    shared: {
      ...shared,
      eventLog,
      brokerTransferRequests: brokerSerialized
    }
  };
}

// Passive district impacts (encourage timely collection without being oppressive)
const DISTRICT_PASSIVE = {
  // Mild mode: reduced by ~50% so urgency pressure exists but isn't dominant
  Full:        { budgetHKDPerDay: 250,  healthDropPerDay: 0.1, carbonPctPerDay: 0.05 },
  Overflowing: { budgetHKDPerDay: 750, healthDropPerDay: 0.25, carbonPctPerDay: 0.15 }
};

function applyDistrictPassiveEffects() {
  if (!gameState || isGameOver) return;
  const shared = gameState.shared;
  if (!shared || !shared.districts) return;

  const cfgScale = getDifficultyPreset();
  const penaltyScalar = getPenaltyScalar(currentDay);
  let totalBudgetPenalty = 0;
  let totalHealthDrop = 0;
  let totalCarbonAdd = 0;

  DISTRICT_NAMES.forEach((k) => {
    const total = getDistrictTotal(k);
    const status = getDistrictStatus(total);
    if (status === 'Full' || status === 'Overflowing') {
      const cfg = DISTRICT_PASSIVE[status];
      totalBudgetPenalty += cfg.budgetHKDPerDay;
      totalHealthDrop += cfg.healthDropPerDay;
      totalCarbonAdd += cfg.carbonPctPerDay;
    }
  });

  totalBudgetPenalty = Math.round(totalBudgetPenalty * cfgScale.districtPenaltyMultiplier * penaltyScalar);
  totalHealthDrop = Math.round(totalHealthDrop * cfgScale.districtPenaltyMultiplier * penaltyScalar * 10) / 10;
  totalCarbonAdd = Math.round(totalCarbonAdd * cfgScale.districtPenaltyMultiplier * penaltyScalar * 10) / 10;

  if (totalBudgetPenalty > 0 || totalHealthDrop > 0 || totalCarbonAdd > 0) {
    shared.budgetHKD -= totalBudgetPenalty;
    shared.cityHealth = Math.max(0, Math.round((shared.cityHealth - totalHealthDrop) * 10) / 10);
    shared.carbonEmissions.value = Math.min(
      Math.round((shared.carbonEmissions.value + totalCarbonAdd) * 10) / 10,
      shared.carbonEmissions.limit
    );
    addCarbonBreakdownPct(shared, 'passive', totalCarbonAdd);
    appendEventLog(shared,{
      day: currentDay,
      message: `District pressure: −HKD ${totalBudgetPenalty.toLocaleString()}, −${totalHealthDrop.toFixed(1)}% health, +${totalCarbonAdd.toFixed(1)}% CO₂`
    });
  }
}

// Inventory holding costs & degradation (discourage infinite stockpiling)
const HOLDING_COST_HKD_PER_TON_PER_DAY = {
  municipality: 2,
  mrf: 1,
  broker: 1
};
const DEGRADE_EVERY_DAYS = 5; // every N days
const DEGRADE_RATE = 0.1;     // 10% grade degradation

function applyInventoryHoldingAndDegradation() {
  if (!gameState || isGameOver) return;
  const shared = gameState.shared;
  const roles = gameState.roles;
  if (!shared || !roles) return;

  const diffCfg = getDifficultyPreset();
  const penaltyScalar = getPenaltyScalar(currentDay);
  let holdingCost = 0;
  ['municipality', 'mrf', 'broker'].forEach((rk) => {
    const inv = roles[rk]?.inventory;
    const total = getInventoryTotal(inv);
    holdingCost += total * (HOLDING_COST_HKD_PER_TON_PER_DAY[rk] || 0) * diffCfg.holdingCostMultiplier * penaltyScalar;
  });
  holdingCost = Math.round(holdingCost);
  if (holdingCost > 0) {
    shared.budgetHKD -= holdingCost;
    appendEventLog(shared,{ day: currentDay, message: `Inventory holding cost: −HKD ${holdingCost.toLocaleString()}` });
  }

  const degradeEveryDays = Math.max(1, Number(diffCfg.degradeEveryDays || DEGRADE_EVERY_DAYS));
  const degradeRate = Math.max(0, Number(diffCfg.degradeRate || DEGRADE_RATE));
  if (currentDay % degradeEveryDays !== 0) return;
  ['municipality', 'mrf', 'broker'].forEach((rk) => {
    const inv = roles[rk]?.inventory;
    if (!inv) return;
    // Materials degrade: A->B, B->C
    if (inv.materials) {
      Object.values(inv.materials).forEach((grades) => {
        const a = grades.A || 0;
        const b = grades.B || 0;
        const moveA = Math.floor(a * degradeRate);
        const moveB = Math.floor(b * degradeRate);
        if (moveA > 0) { grades.A -= moveA; grades.B = (grades.B || 0) + moveA; }
        if (moveB > 0) { grades.B -= moveB; grades.C = (grades.C || 0) + moveB; }
      });
    }
    // Waste degrades: B->C, C->F
    if (inv.waste) {
      Object.values(inv.waste).forEach((grades) => {
        const b = grades.B || 0;
        const c = grades.C || 0;
        const moveB = Math.floor(b * degradeRate);
        const moveC = Math.floor(c * degradeRate);
        if (moveB > 0) { grades.B -= moveB; grades.C = (grades.C || 0) + moveB; }
        if (moveC > 0) { grades.C -= moveC; grades.F = (grades.F || 0) + moveC; }
      });
    }
  });
  appendEventLog(shared,{ day: currentDay, message: `Inventory quality degraded: ${Math.round(degradeRate * 100)}% A→B→C (materials) and B→C→F (waste) (every ${degradeEveryDays} days)` });
}

function addWasteToDistrict(district, material, grade, amount) {
  const d = gameState.shared.districts[district];
  if (!d || !d.waste[material] || d.waste[material][grade] === undefined) return;
  const a = Number(amount) || 0;
  if (a <= 0) return;
  d.waste[material][grade] = (d.waste[material][grade] || 0) + a;
  adjustUncollectedWasteTotal(a);
}

function pickByWeight(weightMap) {
  const entries = Object.entries(weightMap || {}).filter(([, w]) => Number(w) > 0);
  if (!entries.length) return null;
  const total = entries.reduce((s, [, w]) => s + Number(w), 0);
  let r = Math.random() * total;
  for (const [key, w] of entries) {
    r -= Number(w);
    if (r <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

function generateDistrictWaste() {
  if (!gameState || isGameOver) return;
  const MATERIALS = ['paper', 'plastic', 'metal', 'glass', 'wood'];

  DISTRICT_NAMES.forEach((key) => {
    const cfg = DISTRICT_GENERATION[key];
    const totalT = Math.max(0, Math.floor(Number(cfg?.tonnesPerDay) || 0));
    if (totalT <= 0) return;

    // Randomized daily composition: each tonne is sampled independently.
    // This keeps district "flavor" (weight map) while changing type mix day-to-day.
    for (let i = 0; i < totalT; i++) {
      const material = pickByWeight(cfg.material) || MATERIALS[Math.floor(Math.random() * MATERIALS.length)];
      const grade = pickByWeight(cfg.grade) || 'C';
      addWasteToDistrict(key, material, grade, 1);
    }
  });
}

/** Buffer tiers from warehouse fill ratio (inventory tonnes / capacity), not district street waste. */
function getBufferLevelFromFillRatio(ratio) {
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));
  if (r >= 0.95) return 'Disaster';
  if (r >= 0.85) return 'Critical';
  if (r >= 0.75) return 'Warning';
  return 'Normal';
}

function getRoleInventoryFillRatio(roleKey) {
  if (!gameState || !gameState.roles || !gameState.roles[roleKey]) return 0;
  const inv = gameState.roles[roleKey].inventory;
  if (!inv) return 0;
  const cap = Number(inv.capacityTonnes || 0) || (INVENTORY_CAPACITY_TONNES[roleKey] || 150);
  if (cap <= 0) return 0;
  return Math.min(1, getInventoryTotal(inv) / cap);
}

/** Sets each role's bufferLevel from that role's inventory only. */
function syncRoleBufferLevels() {
  if (!gameState || !gameState.roles) return;
  ['municipality', 'mrf', 'broker'].forEach((rk) => {
    const role = gameState.roles[rk];
    if (!role) return;
    const ratio = getRoleInventoryFillRatio(rk);
    role.bufferLevel = getBufferLevelFromFillRatio(ratio);
  });
}

/** Keep role inventory capacities aligned with configured role caps. */
function enforceRoleInventoryCapacities() {
  if (!gameState || !gameState.roles) return;
  ['municipality', 'mrf', 'broker'].forEach((rk) => {
    const role = gameState.roles[rk];
    if (!role || !role.inventory) return;
    role.inventory.capacityTonnes = INVENTORY_CAPACITY_TONNES[rk] || 150;
  });
}

const BUFFER_LEVEL_ORDER = { Disaster: 4, Critical: 3, Warning: 2, Normal: 1 };

/** Worst level among roles — used for shared transport multiplier & buffer penalties. */
function getGlobalBufferLevelFromRoles() {
  if (!gameState || !gameState.roles) return 'Normal';
  let best = 'Normal';
  ['municipality', 'mrf', 'broker'].forEach((rk) => {
    const lv = gameState.roles[rk] && gameState.roles[rk].bufferLevel;
    if (!lv) return;
    if ((BUFFER_LEVEL_ORDER[lv] || 0) > (BUFFER_LEVEL_ORDER[best] || 0)) best = lv;
  });
  return best;
}

function updateBufferState() {
  if (!gameState || isGameOver) return;
  const shared = gameState.shared;

  syncRoleBufferLevels();
  const newLevel = getGlobalBufferLevelFromRoles();
  const oldLevel = shared.buffer?.level || 'Normal';

  if (!shared.buffer) {
    shared.buffer = { level: 'Normal', lastPenaltyDay: 1, disasterFinePaid: false };
  }

  // Transport multiplier rules
  const transportTimeMultiplier =
    newLevel === 'Critical' || newLevel === 'Disaster' ? 2 : 1;

  shared.transportTimeMultiplier = transportTimeMultiplier;

  if (newLevel !== oldLevel) {
    shared.buffer.level = newLevel;
    // Start counting penalty interval from now (no instant penalty on entry)
    shared.buffer.lastPenaltyDay = currentDay;

    appendEventLog(shared,{
      day: currentDay,
      message: `Warehouse buffer (inventory fill): ${oldLevel} → ${newLevel}. Transport time x${transportTimeMultiplier}`
    });

    // One-time fine on entry to Disaster
    if (newLevel === 'Disaster' && !shared.buffer.disasterFinePaid) {
      const diffCfg = getDifficultyPreset();
      const penaltyScalar = getPenaltyScalar(currentDay);
      shared.budgetHKD -= Math.round(50000 * diffCfg.disasterFineMultiplier * penaltyScalar);
      shared.buffer.disasterFinePaid = true;
      appendEventLog(shared,{
        day: currentDay,
        message: 'Disaster entry fine: −HKD 50,000'
      });
    }
  }
}

function applyBufferPenaltyIfDue() {
  if (!gameState || isGameOver) return;
  const shared = gameState.shared;
  if (!shared.buffer) return;

  const level = shared.buffer.level;
  const last = shared.buffer.lastPenaltyDay ?? currentDay;
  const diffCfg = getDifficultyPreset();
  const penaltyScalar = getPenaltyScalar(currentDay);
  const interval = Math.max(1, Number(diffCfg.bufferPenaltyIntervalDays || 10));
  const due = currentDay - last >= interval;
  if (!due) return;

  let drop = 0;
  if (level === 'Warning') drop = 2;
  if (level === 'Critical') drop = 3;
  if (level === 'Disaster') drop = 4;
  drop = Math.round(drop * diffCfg.bufferPenaltyMultiplier * penaltyScalar * 10) / 10;
  if (drop <= 0) return;

  shared.cityHealth = Math.max(0, shared.cityHealth - drop);
  shared.buffer.lastPenaltyDay = currentDay;
  appendEventLog(shared,{
    day: currentDay,
    message: `Warehouse buffer penalty: −${drop}% City Health (worst inventory level: ${level})`
  });
}

function initGameState(difficultyKey) {
  activeDifficulty = normalizeDifficulty(difficultyKey || activeDifficulty || lobbyDifficulty);
  currentDay = 1;
  isGameOver = false;
  restartReadyRoles.clear();
  isRestartGateActive = false;
  gameState = {
    shared: {
      budgetHKD: 1000000,
      cityHealth: 100,
      waste: {
        totalTonnes: 0,
        capacityTonnes: 10000,
        processedMaterials: { paper: 0, plastic: 0, metal: 0, glass: 0, wood: 0 }
      },
      carbonEmissions: { value: 0, limit: 100 },
      carbonBreakdown: { ...CARBON_BREAKDOWN_DEFAULTS },
      difficulty: activeDifficulty,
      day: currentDay,
      maxDay: MAX_DAY,
      roundDurationMinutes: ROUND_DURATION_MINUTES,
      realSecondsPerGameDay: REAL_MS_PER_GAME_DAY / 1000,
      transportTimeMultiplier: 1,
      buffer: { level: 'Normal', lastPenaltyDay: 1, disasterFinePaid: false },
      eventLog: [],
      brokerTransferRequests: { municipality: {}, mrf: {} },
      pendingDeliveries: [],
      marketplace: initMarketplace(),
      projects: initCityProjectsState(),
      gameOver: false,
      districts: {
        residential: { waste: emptyWaste() },
        commercial:  { waste: emptyWaste() },
        industrial:  { waste: emptyWaste() }
      }
    },
    roles: {
      municipality: {
        roleName: 'Municipality',
        bufferLevel: 'Normal',
        inventory: {
          capacityTonnes: INVENTORY_CAPACITY_TONNES.municipality,
          unprocessedWaste: 0,
          materials: emptyMaterials(),
          waste: emptyInventoryWaste()
        }
      },
      mrf: {
        roleName: 'MRF',
        bufferLevel: 'Normal',
        inventory: {
          capacityTonnes: INVENTORY_CAPACITY_TONNES.mrf,
          unprocessedWaste: 0,
          materials: emptyMaterials(),
          waste: emptyInventoryWaste()
        }
      },
      broker: {
        roleName: 'Broker',
        bufferLevel: 'Normal',
        transportation: {
          currentLoadTonnes: 0,
          capacityTonnes: 150,
          inUseCount: 0,
          upgrades: { speed: 0, capacity: 0, green: 0, fleet: 0 },
          activeTrips: []
        },
        inventory: {
          capacityTonnes: INVENTORY_CAPACITY_TONNES.broker,
          unprocessedWaste: 0,
          materials: emptyMaterials(),
          waste: emptyInventoryWaste()
        }
      }
    }
  };
}

function broadcastGameState() {
  if (!gameState) return;
  enforceRoleInventoryCapacities();
  ensureCarbonBreakdown(gameState.shared);
  syncRoleBufferLevels();
  gameState.shared.day = currentDay;
  gameState.shared.gameOver = isGameOver;
  io.emit('gameStateUpdate', buildClientGameStatePayload(gameState));
  try {
    scheduleGameStateSave(gameState);
  } catch (_e) {}
}

function checkGameOver() {
  if (!gameState || isGameOver) return;
  const shared = gameState.shared;

  let reason = null;
  if (shared.cityHealth <= 0) {
    reason = 'City health reached 0%';
  } else if (shared.budgetHKD <= 0) {
    reason = 'Budget reached 0';
  } else if (shared.waste.totalTonnes >= shared.waste.capacityTonnes) {
    reason = 'Waste capacity is full';
  } else if (shared.carbonEmissions.value >= shared.carbonEmissions.limit) {
    reason = 'Carbon emissions reached the limit';
  } else if (shared.day >= shared.maxDay) {
    reason = `Simulation complete — Day ${shared.maxDay}`;
  }

  if (!reason) return;
  const isWin = shared.day >= shared.maxDay &&
    shared.cityHealth > 0 &&
    shared.budgetHKD > 0 &&
    shared.waste.totalTonnes < shared.waste.capacityTonnes &&
    shared.carbonEmissions.value < shared.carbonEmissions.limit;

  isGameOver = true;
  // Start the "wait for all players" restart gate.
  isRestartGateActive = true;
  restartReadyRoles.clear();

  if (dayIntervalId) {
    clearInterval(dayIntervalId);
    dayIntervalId = null;
  }

  appendEventLog(shared,{
    day: currentDay,
    message: `${isWin ? 'Well done!' : 'Game Over'}: ${reason}`
  });

  broadcastGameState();
  io.emit('gameOver', { reason, isWin, state: buildClientGameStatePayload(gameState) });
}

function startGameClock() {
  if (dayIntervalId) return;          // already running

  // Broadcast initial day to everyone
  io.emit('dayUpdate', { day: currentDay, maxDay: MAX_DAY });
  // If a restored/late-joined session is already at max day, end immediately.
  checkGameOver();

  dayIntervalId = setInterval(() => {
    if (currentDay >= MAX_DAY) {
      // Safety: ensure max-day completion always emits game-over once.
      checkGameOver();
      clearInterval(dayIntervalId);
      dayIntervalId = null;
      return;
    }

    currentDay += 1;
    io.emit('dayUpdate', { day: currentDay, maxDay: MAX_DAY });

    // Shared state updates that happen each in-game day
    if (gameState && !isGameOver) {
      gameState.shared.day = currentDay;
      generateDistrictWaste();
      applyDistrictPassiveEffects();
      applyInventoryHoldingAndDegradation();
      applyProjectDeadlinePenalties();
      processScheduledProjectRegenerations();
      processBrokerTripReturns();
      processPendingDeliveries();
      updateVendorPrices();
      refreshTraderListings();
      updateBufferState();
      applyBufferPenaltyIfDue();
      // Full authoritative state on server; clients receive slim copy via buildClientGameStatePayload.
      broadcastGameState();
      checkGameOver();
    }
  }, REAL_MS_PER_GAME_DAY);
}

function restartGameSession() {
  if (dayIntervalId) {
    clearInterval(dayIntervalId);
    dayIntervalId = null;
  }
  initGameState(activeDifficulty);
  startGameClock();
  broadcastGameState();
}

function ensureGameStarted() {
  if (gameState) return;
  initGameState(activeDifficulty || lobbyDifficulty);
  generateDistrictWaste(); // Seed Day 1 so pages show data immediately
  startGameClock();
  broadcastGameState();
}

/** User-facing copy when socket handlers cannot run — must emit so clients are not left hanging. */
const SOCKET_ERR_GAME_NOT_STARTED =
  'Game has not started yet. Open game.html and select all roles (or start the round), then try again.';
const SOCKET_ERR_GAME_OVER = 'Game is over — this action is disabled.';

/**
 * If there is no active round, emit an error on the channel this action normally uses and return true.
 * @param {import('socket.io').Socket} socket
 * @param {'collectWasteError'|'projectSubmitError'|'inventoryTransferResult'|'sortingConvertResult'|'wasteTreatmentResult'|'recyclingConvertResult'|'marketplaceBuyResult'} eventName - must match what the client listens for on this action
 * @returns {boolean} true if the caller must return (blocked)
 */
function emitIfGameInactive(socket, eventName) {
  if (gameState && !isGameOver) return false;
  const msg = !gameState ? SOCKET_ERR_GAME_NOT_STARTED : SOCKET_ERR_GAME_OVER;
  if (eventName === 'collectWasteError') {
    socket.emit('collectWasteError', { message: msg });
  } else if (eventName === 'projectSubmitError') {
    socket.emit('projectSubmitError', { message: msg });
  } else if (eventName === 'marketplaceBuyResult') {
    socket.emit('marketplaceBuyResult', { error: msg });
  } else {
    socket.emit(eventName, { ok: false, error: msg });
  }
  return true;
}

/** Send lobby + day + optional game snapshot to one socket (does not change `players`). */
function emitLobbySnapshotToSocket(socket) {
  socket.emit('roleUpdate', {
    takenRoles: [...takenRoles],
    playerCount: players.length,
    maxPlayers: MAX_PLAYERS,
    difficulty: normalizeDifficulty(gameState ? activeDifficulty : lobbyDifficulty)
  });
  socket.emit('dayUpdate', { day: currentDay, maxDay: MAX_DAY });
  if (gameState) {
    socket.emit('gameStateUpdate', buildClientGameStatePayload(gameState));
  }
}

io.on('connection', (socket) => {
  console.log(`⚡ Socket connected: ${socket.id} (lobby seats: ${players.length}/${MAX_PLAYERS})`);

  // Inventory / dashboard / game pages also open Socket.IO; they must NOT consume the 3 lobby slots
  // or strangers (or extra tabs) instantly show "Room Full". Only `joinLobby` (index.html) reserves a seat.
  setImmediate(() => {
    if (!socket.connected) return;
    emitLobbySnapshotToSocket(socket);
  });

  socket.on('joinLobby', () => {
    players = players.filter((p) => io.sockets.sockets.has(p.id));

    if (players.some((p) => p.id === socket.id)) {
      if (!socket.connected) return;
      emitLobbySnapshotToSocket(socket);
      return;
    }

    if (players.length >= MAX_PLAYERS) {
      console.log(`🚫 Rejecting joinLobby ${socket.id} — room full (${players.length}/${MAX_PLAYERS})`);
      socket.emit('roomFull', { message: 'Game is full. Only 3 players allowed.' });
      socket.disconnect(true);
      return;
    }

    if (!socket.connected) return;

    players.push({ id: socket.id, role: null });
    console.log(`✅ Lobby join ${socket.id}. Total: ${players.length}/${MAX_PLAYERS}`);

    emitLobbySnapshotToSocket(socket);

    io.emit('lobbyUpdate', {
      playerCount: players.length,
      maxPlayers: MAX_PLAYERS,
      takenRoles: [...takenRoles],
      difficulty: normalizeDifficulty(gameState ? activeDifficulty : lobbyDifficulty)
    });
  });

  // Emergency reset for stuck lobby states (e.g., all roles appear taken unexpectedly).
  socket.on('resetLobby', (_data, ack) => {
    if (dayIntervalId) {
      clearInterval(dayIntervalId);
      dayIntervalId = null;
    }
    players = [];
    takenRoles = [];
    gameState = null;
    isGameOver = false;
    currentDay = 1;
    restartReadyRoles.clear();
    isRestartGateActive = false;
    activeDifficulty = normalizeDifficulty(lobbyDifficulty);

    io.emit('roleUpdate', {
      takenRoles: [],
      playerCount: 0,
      maxPlayers: MAX_PLAYERS,
      difficulty: normalizeDifficulty(lobbyDifficulty)
    });
    io.emit('lobbyUpdate', {
      playerCount: 0,
      maxPlayers: MAX_PLAYERS,
      takenRoles: [],
      difficulty: normalizeDifficulty(lobbyDifficulty)
    });
    io.emit('lobbyReset', { ok: true, message: 'Lobby has been reset.' });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('setDifficulty', (data) => {
    const requested = normalizeDifficulty(data && data.difficulty);
    if (gameState && !isGameOver) {
      socket.emit('difficultyUpdate', { ok: false, difficulty: activeDifficulty, message: 'Cannot change difficulty during active round.' });
      return;
    }
    lobbyDifficulty = requested;
    if (gameState && isGameOver) {
      activeDifficulty = requested;
      if (gameState.shared) gameState.shared.difficulty = requested;
    }
    io.emit('difficultyUpdate', {
      ok: true,
      difficulty: normalizeDifficulty(gameState ? activeDifficulty : lobbyDifficulty)
    });
  });

  socket.on('skipToDay', (data, ack) => {
    if (!gameState) {
      if (typeof ack === 'function') ack({ ok: false, error: SOCKET_ERR_GAME_NOT_STARTED });
      return;
    }
    if (isGameOver) {
      if (typeof ack === 'function') ack({ ok: false, error: SOCKET_ERR_GAME_OVER });
      return;
    }
    const targetRaw = Number(data && data.targetDay);
    const targetDay = Math.max(1, Math.min(MAX_DAY, Math.floor(targetRaw || 1)));
    if (targetDay <= currentDay) {
      if (typeof ack === 'function') ack({ ok: false, error: `Current day is already ${currentDay}.` });
      return;
    }

    currentDay = targetDay;
    if (gameState && gameState.shared) gameState.shared.day = currentDay;
    io.emit('dayUpdate', { day: currentDay, maxDay: MAX_DAY });
    broadcastGameState();
    checkGameOver();

    if (typeof ack === 'function') ack({ ok: true, day: currentDay, maxDay: MAX_DAY });
  });

  // ── Role selection ──
  socket.on('selectRole', (role) => {
    console.log(`🎯 ${socket.id} wants role: ${role}`);

    // Validate role name
    if (!AVAILABLE_ROLES.includes(role)) {
      socket.emit('roleError', { message: 'Invalid role.' });
      return;
    }

    // Already taken by ANOTHER player?
    if (takenRoles.includes(role)) {
      socket.emit('roleError', { message: `${role} is already taken by another player!` });
      return;
    }

    // This player already confirmed a role?
    const player = players.find(p => p.id === socket.id);
    if (!player) return;

    if (player.role) {
      socket.emit('roleError', { message: `You already confirmed: ${player.role}` });
      return;
    }

    // ── Assign ──
    player.role = role;
    takenRoles.push(role);
    console.log(`✅ ${socket.id} → ${role}.  Taken: [${takenRoles}]`);

    // Broadcast to ALL
    io.emit('roleUpdate', {
      takenRoles: [...takenRoles],
      playerCount: players.length,
      maxPlayers: MAX_PLAYERS,
      difficulty: normalizeDifficulty(gameState ? activeDifficulty : lobbyDifficulty)
    });

    // All 3 roles filled?
    if (takenRoles.length === MAX_PLAYERS) {
      console.log('🚀 All roles taken — game ready!');
      initGameState(lobbyDifficulty);
      generateDistrictWaste(); // Day 1: districts start with waste so Municipality sees data immediately
      startGameClock();
      broadcastGameState();
      io.emit('gameReady', { message: 'All roles selected! Game starting…' });
    }
  });

  // ── Municipality: collect waste from a district (Residential / Commercial / Industrial) ──
  socket.on('collectWasteFromDistrict', (data) => {
    const { role, district, tons } = data || {};
    if (role !== 'Municipality') {
      socket.emit('collectWasteError', { message: 'Only Municipality can collect waste.' });
      return;
    }
    if (isGameOver) {
      socket.emit('collectWasteError', { message: 'Game is already over.' });
      return;
    }
    // Allow single-player / early testing: start the game on first collect.
    ensureGameStarted();
    if (!DISTRICT_NAMES.includes(district)) {
      socket.emit('collectWasteError', { message: 'Invalid district.' });
      return;
    }

    const t = Math.max(0, Math.floor(Number(tons)));
    if (t <= 0) {
      socket.emit('collectWasteError', { message: 'Enter at least 1 ton to collect.' });
      return;
    }

    const dist = gameState.shared.districts[district];
    const totalInDistrict = getDistrictTotal(district);
    if (totalInDistrict <= 0) {
      socket.emit('collectWasteError', { message: `No waste in ${district} to collect.` });
      return;
    }

    const collectTons = Math.min(t, totalInDistrict);
    const status = getDistrictStatus(totalInDistrict);
    const { costPerTon, healthGain } = DISTRICT_STATUS[status] || DISTRICT_STATUS.Normal;

    // Inventory capacity constraint (prevents infinite stockpiling)
    const invCap = gameState.roles.municipality.inventory.capacityTonnes ?? INVENTORY_CAPACITY_TONNES.municipality;
    const invNow = getInventoryTotal(gameState.roles.municipality.inventory);
    if (invNow + collectTons > invCap) {
      socket.emit('collectWasteError', { message: `Inventory full. Capacity ${invCap} t, current ${invNow} t. Collect fewer tons or process/transfer first.` });
      return;
    }

    // Build list of (material, grade, amount) and deduct proportionally
    const entries = [];
    Object.entries(dist.waste).forEach(([mat, grades]) => {
      Object.entries(grades).forEach(([grade, amount]) => {
        if (amount > 0) entries.push({ material: mat, grade, amount });
      });
    });
    const total = entries.reduce((s, e) => s + e.amount, 0);
    const collected = {};
    ['paper', 'plastic', 'metal', 'glass', 'wood'].forEach((m) => { collected[m] = { B: 0, C: 0, F: 0 }; });
    let takenSum = 0;
    entries.forEach(({ material, grade, amount }) => {
      const take = Math.min(amount, Math.floor((amount / total) * collectTons));
      dist.waste[material][grade] -= take;
      collected[material][grade] += take;
      takenSum += take;
    });
    let remainder = collectTons - takenSum;
    for (const e of entries) {
      if (remainder <= 0) break;
      const left = dist.waste[e.material][e.grade];
      const take = Math.min(remainder, left);
      if (take > 0) {
        dist.waste[e.material][e.grade] -= take;
        collected[e.material][e.grade] += take;
        remainder -= take;
      }
    }
    // Clamp district waste to non-negative
    Object.keys(dist.waste).forEach((mat) => {
      Object.keys(dist.waste[mat]).forEach((grade) => {
        if (dist.waste[mat][grade] < 0) dist.waste[mat][grade] = 0;
      });
    });

    // Add to municipality inventory
    const inv = gameState.roles.municipality.inventory.waste;
    Object.entries(collected).forEach(([mat, grades]) => {
      Object.entries(grades).forEach(([grade, n]) => {
        if (n > 0) inv[mat][grade] = (inv[mat][grade] || 0) + n;
      });
    });

    const costHKD = collectTons * costPerTon;
    const healthGained = healthGain * (collectTons / 5);
    let co2Kg = 0;
    Object.entries(collected).forEach(([mat, grades]) => {
      Object.entries(grades).forEach(([, n]) => { co2Kg += (n || 0) * (MATERIAL_CO2[mat] ?? 0.8); });
    });
    const co2Pct = co2KgToPct(co2Kg, currentDay);

    const shared = gameState.shared;
    shared.budgetHKD -= costHKD;
    shared.cityHealth = Math.min(100, Math.max(0, shared.cityHealth + healthGained));
    shared.carbonEmissions.value = Math.min(
      Math.round((shared.carbonEmissions.value + co2Pct) * 10) / 10,
      shared.carbonEmissions.limit
    );
    addCarbonBreakdownPct(shared, 'collection', co2Pct);
    adjustUncollectedWasteTotal(-collectTons);

    const districtLabel = district.charAt(0).toUpperCase() + district.slice(1);
    appendEventLog(shared,{
      day: currentDay,
      message: `Municipality collected ${collectTons} t from ${districtLabel} (${status}). −HKD ${costHKD.toLocaleString()}, +${healthGained.toFixed(1)}% health, +${co2Pct}% CO₂`
    });

    updateBufferState();
    broadcastGameState();
    checkGameOver();
  });

  // ── Municipality: City Projects ──
  socket.on('projectSubmitMaterial', (data) => {
    const { role, projectKey, material } = data || {};
    if (role !== 'Municipality') {
      socket.emit('projectSubmitError', { message: 'Only Municipality can submit city projects.' });
      return;
    }
    if (emitIfGameInactive(socket, 'projectSubmitError')) return;
    const shared = gameState.shared;
    const projects = shared.projects;
    const cfg = CITY_PROJECTS[projectKey];
    const proj = projects && projects[projectKey];
    const mat = String(material || '').toLowerCase();

    if (!cfg || !proj) {
      socket.emit('projectSubmitError', { message: 'Invalid project.' });
      return;
    }
    if (!MATERIALS.includes(mat)) {
      socket.emit('projectSubmitError', { message: 'Invalid material.' });
      return;
    }
    if (proj.completedDay) {
      socket.emit('projectSubmitError', { message: 'Project already completed.' });
      return;
    }
    if (!proj.requiredTypes.includes(mat)) {
      socket.emit('projectSubmitError', { message: `Material ${mat} is not required for this project.` });
      return;
    }
    if (proj.submittedTypes.includes(mat)) {
      socket.emit('projectSubmitError', { message: `Material ${mat} already submitted.` });
      return;
    }

    // Start deadline timer on first submission
    if (!proj.startedDay) {
      proj.startedDay = currentDay;
      proj.deadlineDay = currentDay + cfg.deadlineDays - 1;
    }

    // Consume 1 tonne of good-quality MATERIAL (Grade A/B) from Municipality inventory.materials
    // and generate WASTE (B/C/F) into Municipality inventory.waste via conversion table.
    const muniInv = gameState.roles.municipality.inventory;
    const mats = muniInv?.materials;
    const invWaste = muniInv?.waste;
    const availableA = mats?.[mat]?.A || 0;
    const availableB = mats?.[mat]?.B || 0;
    if (availableA < 1 && availableB < 1) {
      socket.emit('projectSubmitError', { message: `Not enough good-quality ${mat} (Grade A/B). Need 1 t.` });
      return;
    }
    if (availableA >= 1) {
      mats[mat].A -= 1;
      addWasteByConversion(invWaste, mat, 'A', 1);
    } else {
      mats[mat].B -= 1;
      addWasteByConversion(invWaste, mat, 'B', 1);
    }

    const n = proj.requiredCount || proj.requiredTypes.length || 1;
    const fracCost = cfg.costHKD / n;
    const fracHealth = cfg.healthGainPct / n;
    const fracCo2Kg = cfg.co2ImpactKg / n;

    shared.budgetHKD -= fracCost;
    shared.cityHealth = Math.min(100, Math.max(0, Math.round((shared.cityHealth + fracHealth) * 100) / 100));
    const co2Pct = co2KgToPct(fracCo2Kg, currentDay);
    shared.carbonEmissions.value = Math.min(
      shared.carbonEmissions.limit,
      Math.max(0, Math.round((shared.carbonEmissions.value + co2Pct) * 10) / 10)
    );
    addCarbonBreakdownPct(shared, 'projects', co2Pct);

    proj.submittedTypes.push(mat);

    const done = proj.submittedTypes.length >= n;
    if (done) proj.completedDay = currentDay;

    appendEventLog(shared,{
      day: currentDay,
      message: `Project ${cfg.name}: submitted ${mat} (1/${n}). −HKD ${Math.round(fracCost).toLocaleString()}, +${fracHealth.toFixed(2)}% health, ${co2Pct >= 0 ? '+' : ''}${co2Pct}% CO₂`
    });
    if (done) {
      const late = proj.deadlineDay ? Math.max(0, currentDay - proj.deadlineDay) : 0;
      appendEventLog(shared,{
        day: currentDay,
        message: `Project completed: ${cfg.name}. ${late > 0 ? `Late by ${late} day(s).` : 'On time.'}`
      });
      // Rotate next day (remove now, regenerate Day+1)
      scheduleProjectRegeneration(projectKey, currentDay + 1);
    }

    updateBufferState();
    broadcastGameState();
    checkGameOver();
  });

  socket.on('projectSubmitAll', (data) => {
    const { role, projectKey } = data || {};
    if (role !== 'Municipality') {
      socket.emit('projectSubmitError', { message: 'Only Municipality can submit city projects.' });
      return;
    }
    if (emitIfGameInactive(socket, 'projectSubmitError')) return;
    const shared = gameState.shared;
    const projects = shared.projects;
    const cfg = CITY_PROJECTS[projectKey];
    const proj = projects && projects[projectKey];
    if (!cfg || !proj) {
      socket.emit('projectSubmitError', { message: 'Invalid project.' });
      return;
    }
    if (proj.completedDay) {
      socket.emit('projectSubmitError', { message: 'Project already completed.' });
      return;
    }

    // Start deadline timer on first submission
    if (!proj.startedDay) {
      proj.startedDay = currentDay;
      proj.deadlineDay = currentDay + cfg.deadlineDays - 1;
    }

    const remaining = proj.requiredTypes.filter((m) => !proj.submittedTypes.includes(m));
    const n = proj.requiredCount || proj.requiredTypes.length || 1;
    if (!remaining.length) {
      socket.emit('projectSubmitError', { message: 'Nothing left to submit.' });
      return;
    }

    // Check inventory.materials for all remaining (Grade A/B) and consume (prefer A),
    // then generate waste (B/C/F) into inventory.waste.
    const muniInv = gameState.roles.municipality.inventory;
    const mats = muniInv?.materials;
    const invWaste = muniInv?.waste;
    for (const m of remaining) {
      const a = mats?.[m]?.A || 0;
      const b = mats?.[m]?.B || 0;
      if (a < 1 && b < 1) {
        socket.emit('projectSubmitError', { message: `Not enough good-quality ${m} (Grade A/B) for all-at-once submit.` });
        return;
      }
    }
    remaining.forEach((m) => {
      const a = mats?.[m]?.A || 0;
      if (a >= 1) {
        mats[m].A -= 1;
        addWasteByConversion(invWaste, m, 'A', 1);
      } else {
        mats[m].B -= 1;
        addWasteByConversion(invWaste, m, 'B', 1);
      }
    });

    // Apply fractional effect for each submitted material type
    const fracCost = cfg.costHKD / n;
    const fracHealth = cfg.healthGainPct / n;
    const fracCo2Kg = cfg.co2ImpactKg / n;
    const co2PctEach = co2KgToPct(fracCo2Kg, currentDay);

    shared.budgetHKD -= fracCost * remaining.length;
    shared.cityHealth = Math.min(100, Math.max(0, Math.round((shared.cityHealth + fracHealth * remaining.length) * 100) / 100));
    shared.carbonEmissions.value = Math.min(
      shared.carbonEmissions.limit,
      Math.max(0, Math.round((shared.carbonEmissions.value + co2PctEach * remaining.length) * 10) / 10)
    );
    addCarbonBreakdownPct(shared, 'projects', Math.round(co2PctEach * remaining.length * 10) / 10);

    remaining.forEach((m) => proj.submittedTypes.push(m));
    proj.completedDay = currentDay;

    appendEventLog(shared,{
      day: currentDay,
      message: `Project ${cfg.name}: submitted all remaining (${remaining.length}/${n}). −HKD ${Math.round(fracCost * remaining.length).toLocaleString()}, +${(fracHealth * remaining.length).toFixed(2)}% health, ${(co2PctEach * remaining.length) >= 0 ? '+' : ''}${(co2PctEach * remaining.length).toFixed(1)}% CO₂`
    });

    const late = proj.deadlineDay ? Math.max(0, currentDay - proj.deadlineDay) : 0;
    appendEventLog(shared,{
      day: currentDay,
      message: `Project completed: ${cfg.name}. ${late > 0 ? `Late by ${late} day(s).` : 'On time.'}`
    });
    // Rotate next day (remove now, regenerate Day+1)
    scheduleProjectRegeneration(projectKey, currentDay + 1);

    updateBufferState();
    broadcastGameState();
    checkGameOver();
  });

  // ── Inventory transfer wiring across roles ──
  socket.on('municipalitySendToBroker', (data) => {
    const { role, items } = data || {};
    if (role !== 'Municipality') {
      socket.emit('collectWasteError', { message: 'Only Municipality can send waste to Broker.' });
      return;
    }
    if (emitIfGameInactive(socket, 'inventoryTransferResult')) return;
    const result = addBrokerTransferRequest('municipality', items);
    if (!result.ok) {
      socket.emit('inventoryTransferResult', { ok: false, error: result.error });
      return;
    }
    const summary = result.items.map((it) => `${it.tonnes} t ${it.material} (${it.grade})`).join(', ');
    appendEventLog(gameState.shared,{ day: currentDay, message: `Municipality -> Broker request: ${summary}` });
    broadcastGameState();
    checkGameOver();
    io.emit('inventoryTransferResult', { ok: true, from: 'Municipality', to: 'Broker', requestOnly: true });
  });

  socket.on('mrfSendToBroker', (data) => {
    const { role, items } = data || {};
    if (role !== 'MRF') {
      socket.emit('inventoryTransferResult', { ok: false, error: 'Only MRF can send waste to Broker.' });
      return;
    }
    if (emitIfGameInactive(socket, 'inventoryTransferResult')) return;
    const result = addBrokerTransferRequest('mrf', items);
    if (!result.ok) {
      socket.emit('inventoryTransferResult', { ok: false, error: result.error });
      return;
    }
    const summary = result.items.map((it) => `${it.tonnes} t ${it.material} (${it.grade})`).join(', ');
    appendEventLog(gameState.shared,{ day: currentDay, message: `MRF -> Broker request: ${summary}` });
    broadcastGameState();
    checkGameOver();
    io.emit('inventoryTransferResult', { ok: true, from: 'MRF', to: 'Broker', requestOnly: true });
  });

  socket.on('mrfSortingConvert', (data) => {
    const { role, batch } = data || {};
    if (role !== 'MRF') {
      socket.emit('sortingConvertResult', { ok: false, error: 'Only MRF can run sorting conversion.' });
      return;
    }
    if (emitIfGameInactive(socket, 'sortingConvertResult')) return;
    const mrfInv = gameState.roles && gameState.roles.mrf && gameState.roles.mrf.inventory;
    if (!mrfInv) {
      socket.emit('sortingConvertResult', { ok: false, error: 'MRF inventory missing.' });
      return;
    }
    const result = applyMrfSortingConversion(mrfInv, batch);
    if (!result.ok) {
      socket.emit('sortingConvertResult', { ok: false, error: result.error });
      return;
    }
    appendEventLog(gameState.shared,{
      day: currentDay,
      message: `Sorting Centre: material → waste — ${result.summary}`
    });
    updateBufferState();
    broadcastGameState();
    checkGameOver();
    io.emit('sortingConvertResult', { ok: true, message: 'Sorting conversion applied.' });
  });

  socket.on('mrfRecyclingConvert', (data) => {
    const { role, batch } = data || {};
    if (role !== 'MRF') {
      socket.emit('recyclingConvertResult', { ok: false, error: 'Only MRF can run Recycling Centre conversion.' });
      return;
    }
    if (emitIfGameInactive(socket, 'recyclingConvertResult')) return;
    const mrfInv = gameState.roles && gameState.roles.mrf && gameState.roles.mrf.inventory;
    if (!mrfInv) {
      socket.emit('recyclingConvertResult', { ok: false, error: 'MRF inventory missing.' });
      return;
    }
    const result = applyMrfRecyclingCentreConversion(mrfInv, batch);
    if (!result.ok) {
      socket.emit('recyclingConvertResult', { ok: false, error: result.error });
      return;
    }
    appendEventLog(gameState.shared,{
      day: currentDay,
      message: `Recycling Centre: grade upgrade (C→B / B→A) + residue — ${result.summary}`
    });
    updateBufferState();
    broadcastGameState();
    checkGameOver();
    io.emit('recyclingConvertResult', { ok: true, message: 'Recycling batch applied.', totals: result.totals });
  });

  socket.on('mrfWasteTreatment', (data) => {
    const { role, category, subMethod, batch } = data || {};
    if (role !== 'MRF') {
      socket.emit('wasteTreatmentResult', { ok: false, error: 'Only MRF can run waste treatment.' });
      return;
    }
    if (emitIfGameInactive(socket, 'wasteTreatmentResult')) return;
    const mrfInv = gameState.roles && gameState.roles.mrf && gameState.roles.mrf.inventory;
    if (!mrfInv) {
      socket.emit('wasteTreatmentResult', { ok: false, error: 'MRF inventory missing.' });
      return;
    }
    const result = applyMrfWasteTreatment(mrfInv, category, subMethod, batch);
    if (!result.ok) {
      socket.emit('wasteTreatmentResult', { ok: false, error: result.error });
      return;
    }
    appendEventLog(gameState.shared,{
      day: currentDay,
      message: `Waste treatment (${result.methodLabel}): −${result.totals.wasteTonnes} t F-waste · ${result.summary}`
    });
    updateBufferState();
    broadcastGameState();
    checkGameOver();
    io.emit('wasteTreatmentResult', { ok: true, message: 'Waste treatment applied.', totals: result.totals });
  });

  socket.on('brokerSendToMunicipality', (data) => {
    const { role, items } = data || {};
    const { transportType, transportUnits } = normalizeTransportMeta(data);
    if (role !== 'Broker') {
      socket.emit('inventoryTransferResult', { ok: false, error: 'Only Broker can send waste to Municipality.' });
      return;
    }
    if (emitIfGameInactive(socket, 'inventoryTransferResult')) return;
    const broker = gameState.roles && gameState.roles.broker;
    if (!broker) {
      socket.emit('inventoryTransferResult', { ok: false, error: 'Broker state not found.' });
      return;
    }
    ensureBrokerTransportState(broker);
    const requestedItems = normalizeInventoryTransferItems(items);
    const requestedTotal = requestedItems.reduce((s, it) => s + it.tonnes, 0);
    if (requestedTotal <= 0) {
      socket.emit('inventoryTransferResult', { ok: false, error: 'No valid waste items to send.' });
      return;
    }
    const av = getTransportAvailability(broker, transportType);
    if (transportUnits > av.available) {
      socket.emit('inventoryTransferResult', { ok: false, error: `${transportType} unavailable now. Available: ${av.available}.` });
      return;
    }
    const maxLoad = av.cfg.cap * transportUnits;
    if (requestedTotal > maxLoad) {
      socket.emit('inventoryTransferResult', { ok: false, error: `Selected load ${requestedTotal} t exceeds ${transportType} capacity (${maxLoad} t).` });
      return;
    }
    const transportCost = av.cfg.costPerTrip * transportUnits;
    if (gameState.shared.budgetHKD < transportCost) {
      socket.emit('inventoryTransferResult', { ok: false, error: `Not enough budget for transport (need HKD ${transportCost.toLocaleString()}).` });
      return;
    }
    const muniInv = gameState.roles.municipality && gameState.roles.municipality.inventory;
    const toCurrent = getInventoryTotal(muniInv);
    const toCap = Number(muniInv && muniInv.capacityTonnes || 0);
    if (toCurrent + requestedTotal > toCap) {
      const free = Math.max(0, Math.floor((toCap - toCurrent) * 10) / 10);
      socket.emit('inventoryTransferResult', { ok: false, error: `Municipality inventory capacity exceeded. Free capacity: ${free} t.` });
      return;
    }
    const rem = removeInventoryItemsFromRole('broker', items);
    if (!rem.ok) {
      socket.emit('inventoryTransferResult', { ok: false, error: rem.error });
      return;
    }
    const deliveryDays = Math.max(1, Math.ceil(av.cfg.deliveryDays));
    const roundTripDays = Math.max(1, Math.ceil(av.cfg.deliveryDays + av.cfg.returnDays));
    const arriveDay = currentDay + deliveryDays;
    ensurePendingDeliveries();
    gameState.shared.pendingDeliveries.push({
      targetRole: 'municipality',
      items: rem.items,
      arriveDay,
      departDay: currentDay,
      transportType,
      transportUnits
    });
    gameState.shared.budgetHKD = Math.max(0, gameState.shared.budgetHKD - transportCost);
    const transportCo2Pct = co2KgToPct(av.cfg.co2PerTrip * transportUnits, currentDay);
    gameState.shared.carbonEmissions.value = Math.min(
      gameState.shared.carbonEmissions.limit,
      Math.round((gameState.shared.carbonEmissions.value + transportCo2Pct) * 10) / 10
    );
    addCarbonBreakdownPct(gameState.shared, 'transport', transportCo2Pct);
    broker.transportation.activeTrips.push({
      transportType,
      transportUnits,
      from: 'Broker',
      to: 'Municipality',
      departDay: currentDay,
      returnDay: currentDay + roundTripDays
    });
    broker.transportation.inUseCount = broker.transportation.activeTrips.reduce((s, t) => s + Math.max(0, Number(t.transportUnits || 0)), 0);
    const summary = rem.items.map((it) => `${it.tonnes} t ${it.material} (${it.grade})`).join(', ');
    appendEventLog(gameState.shared,{
      day: currentDay,
      message: `Broker -> Municipality dispatched (in transit): ${summary} | Arrive Day ${arriveDay} | Transport: ${transportType} x${transportUnits} | Cost -HKD ${transportCost.toLocaleString()} | +${transportCo2Pct}% CO2 | Vehicle return Day ${currentDay + roundTripDays}`
    });
    broadcastGameState();
    checkGameOver();
    io.emit('inventoryTransferResult', {
      ok: true,
      from: 'Broker',
      to: 'Municipality',
      totalTonnes: rem.totalTonnes,
      dispatchedOnly: true,
      arriveDay,
      returnDay: currentDay + roundTripDays
    });
  });

  socket.on('brokerSendToMrf', (data) => {
    const { role, items } = data || {};
    const { transportType, transportUnits } = normalizeTransportMeta(data);
    if (role !== 'Broker') {
      socket.emit('inventoryTransferResult', { ok: false, error: 'Only Broker can send waste to MRF.' });
      return;
    }
    if (emitIfGameInactive(socket, 'inventoryTransferResult')) return;
    const broker = gameState.roles && gameState.roles.broker;
    if (!broker) {
      socket.emit('inventoryTransferResult', { ok: false, error: 'Broker state not found.' });
      return;
    }
    ensureBrokerTransportState(broker);
    const requestedItems = normalizeInventoryTransferItems(items);
    const requestedTotal = requestedItems.reduce((s, it) => s + it.tonnes, 0);
    if (requestedTotal <= 0) {
      socket.emit('inventoryTransferResult', { ok: false, error: 'No valid waste items to send.' });
      return;
    }
    const av = getTransportAvailability(broker, transportType);
    if (transportUnits > av.available) {
      socket.emit('inventoryTransferResult', { ok: false, error: `${transportType} unavailable now. Available: ${av.available}.` });
      return;
    }
    const maxLoad = av.cfg.cap * transportUnits;
    if (requestedTotal > maxLoad) {
      socket.emit('inventoryTransferResult', { ok: false, error: `Selected load ${requestedTotal} t exceeds ${transportType} capacity (${maxLoad} t).` });
      return;
    }
    const transportCost = av.cfg.costPerTrip * transportUnits;
    if (gameState.shared.budgetHKD < transportCost) {
      socket.emit('inventoryTransferResult', { ok: false, error: `Not enough budget for transport (need HKD ${transportCost.toLocaleString()}).` });
      return;
    }
    const mrfInv = gameState.roles.mrf && gameState.roles.mrf.inventory;
    const mrfCurrent = getInventoryTotal(mrfInv);
    const mrfCap = Number(mrfInv && mrfInv.capacityTonnes || 0);
    if (mrfCurrent + requestedTotal > mrfCap) {
      const free = Math.max(0, Math.floor((mrfCap - mrfCurrent) * 10) / 10);
      socket.emit('inventoryTransferResult', { ok: false, error: `MRF inventory capacity exceeded. Free capacity: ${free} t.` });
      return;
    }
    const rem = removeInventoryItemsFromRole('broker', items);
    if (!rem.ok) {
      socket.emit('inventoryTransferResult', { ok: false, error: rem.error });
      return;
    }
    const deliveryDays = Math.max(1, Math.ceil(av.cfg.deliveryDays));
    const roundTripDays = Math.max(1, Math.ceil(av.cfg.deliveryDays + av.cfg.returnDays));
    const arriveDay = currentDay + deliveryDays;
    ensurePendingDeliveries();
    gameState.shared.pendingDeliveries.push({
      targetRole: 'mrf',
      items: rem.items,
      arriveDay,
      departDay: currentDay,
      transportType,
      transportUnits
    });
    gameState.shared.budgetHKD = Math.max(0, gameState.shared.budgetHKD - transportCost);
    const transportCo2Pct = co2KgToPct(av.cfg.co2PerTrip * transportUnits, currentDay);
    gameState.shared.carbonEmissions.value = Math.min(
      gameState.shared.carbonEmissions.limit,
      Math.round((gameState.shared.carbonEmissions.value + transportCo2Pct) * 10) / 10
    );
    addCarbonBreakdownPct(gameState.shared, 'transport', transportCo2Pct);
    broker.transportation.activeTrips.push({
      transportType,
      transportUnits,
      from: 'Broker',
      to: 'MRF',
      departDay: currentDay,
      returnDay: currentDay + roundTripDays
    });
    broker.transportation.inUseCount = broker.transportation.activeTrips.reduce((s, t) => s + Math.max(0, Number(t.transportUnits || 0)), 0);
    const summary = rem.items.map((it) => `${it.tonnes} t ${it.material} (${it.grade})`).join(', ');
    appendEventLog(gameState.shared,{
      day: currentDay,
      message: `Broker -> MRF dispatched (in transit): ${summary} | Arrive Day ${arriveDay} | Transport: ${transportType} x${transportUnits} | Cost -HKD ${transportCost.toLocaleString()} | +${transportCo2Pct}% CO2 | Vehicle return Day ${currentDay + roundTripDays}`
    });
    broadcastGameState();
    checkGameOver();
    io.emit('inventoryTransferResult', {
      ok: true,
      from: 'Broker',
      to: 'MRF',
      totalTonnes: rem.totalTonnes,
      dispatchedOnly: true,
      arriveDay,
      returnDay: currentDay + roundTripDays
    });
  });

  socket.on('brokerCollectFromRole', (data) => {
    const { role, source } = data || {};
    if (role !== 'Broker') {
      socket.emit('inventoryTransferResult', { ok: false, error: 'Only Broker can collect from other roles.' });
      return;
    }
    const sourceKey = String(source || '').toLowerCase();
    if (!['municipality', 'mrf'].includes(sourceKey)) {
      socket.emit('inventoryTransferResult', { ok: false, error: 'Invalid source role for collect.' });
      return;
    }
    if (emitIfGameInactive(socket, 'inventoryTransferResult')) return;
    const items = collectAllInventoryItems(sourceKey);
    if (!items.length) {
      socket.emit('inventoryTransferResult', { ok: false, error: 'No inventory available to collect.' });
      return;
    }
    const result = transferInventoryBetweenRoles(sourceKey, 'broker', items);
    if (!result.ok) {
      socket.emit('inventoryTransferResult', { ok: false, error: result.error });
      return;
    }
    const fromLabel = sourceKey === 'municipality' ? 'Municipality' : 'MRF';
    appendEventLog(gameState.shared,{ day: currentDay, message: `Broker collected ${result.totalTonnes} t from ${fromLabel}.` });
    broadcastGameState();
    checkGameOver();
    io.emit('inventoryTransferResult', { ok: true, from: fromLabel, to: 'Broker', totalTonnes: result.totalTonnes });
  });

  socket.on('brokerCollectFromRoleItems', (data) => {
    const { role, source, items } = data || {};
    const { transportType, transportUnits } = normalizeTransportMeta(data);
    if (role !== 'Broker') {
      socket.emit('inventoryTransferResult', { ok: false, error: 'Only Broker can collect from other roles.' });
      return;
    }
    const sourceKey = String(source || '').toLowerCase();
    if (!['municipality', 'mrf'].includes(sourceKey)) {
      socket.emit('inventoryTransferResult', { ok: false, error: 'Invalid source role for collect.' });
      return;
    }
    const fromLabel = sourceKey === 'municipality' ? 'Municipality' : 'MRF';
    if (emitIfGameInactive(socket, 'inventoryTransferResult')) return;
    const broker = gameState.roles && gameState.roles.broker;
    if (!broker) {
      socket.emit('inventoryTransferResult', { ok: false, error: 'Broker state not found.' });
      return;
    }
    ensureBrokerTransportState(broker);
    const requestedItems = normalizeInventoryTransferItems(items);
    const requestedTotal = requestedItems.reduce((s, it) => s + it.tonnes, 0);
    if (requestedTotal <= 0) {
      socket.emit('inventoryTransferResult', {
        ok: false,
        error: 'No valid items to collect (material & waste need kind for grade B/C).'
      });
      return;
    }
    const av = getTransportAvailability(broker, transportType);
    if (transportUnits > av.available) {
      socket.emit('inventoryTransferResult', { ok: false, error: `${transportType} unavailable now. Available: ${av.available}.` });
      return;
    }
    const maxLoad = av.cfg.cap * transportUnits;
    if (requestedTotal > maxLoad) {
      socket.emit('inventoryTransferResult', { ok: false, error: `Selected load ${requestedTotal} t exceeds ${transportType} capacity (${maxLoad} t).` });
      return;
    }
    const transportCost = av.cfg.costPerTrip * transportUnits;
    if (gameState.shared.budgetHKD < transportCost) {
      socket.emit('inventoryTransferResult', { ok: false, error: `Not enough budget for transport (need HKD ${transportCost.toLocaleString()}).` });
      return;
    }
    const brokerInv = gameState.roles.broker.inventory;
    const brCurrent = getInventoryTotal(brokerInv);
    const brCap = Number(brokerInv.capacityTonnes || 0);
    if (brCurrent + requestedTotal > brCap) {
      const free = Math.max(0, Math.floor((brCap - brCurrent) * 10) / 10);
      socket.emit('inventoryTransferResult', { ok: false, error: `Broker inventory capacity insufficient for incoming shipment. Free: ${free} t.` });
      return;
    }
    const reqCheck = consumeBrokerTransferRequest(sourceKey, items);
    if (!reqCheck.ok) {
      socket.emit('inventoryTransferResult', { ok: false, error: reqCheck.error });
      return;
    }
    const rem = removeInventoryItemsFromRole(sourceKey, items);
    if (!rem.ok) {
      addBrokerTransferRequest(sourceKey, items);
      socket.emit('inventoryTransferResult', { ok: false, error: rem.error });
      return;
    }
    const roundTripDays = Math.max(1, Math.ceil(av.cfg.deliveryDays + av.cfg.returnDays));
    const arriveDay = currentDay + roundTripDays;
    ensurePendingDeliveries();
    gameState.shared.pendingDeliveries.push({
      targetRole: 'broker',
      items: rem.items,
      arriveDay,
      departDay: currentDay,
      transportType,
      transportUnits
    });
    gameState.shared.budgetHKD = Math.max(0, gameState.shared.budgetHKD - transportCost);
    const transportCo2Pct = co2KgToPct(av.cfg.co2PerTrip * transportUnits, currentDay);
    gameState.shared.carbonEmissions.value = Math.min(
      gameState.shared.carbonEmissions.limit,
      Math.round((gameState.shared.carbonEmissions.value + transportCo2Pct) * 10) / 10
    );
    addCarbonBreakdownPct(gameState.shared, 'transport', transportCo2Pct);
    broker.transportation.activeTrips.push({
      transportType,
      transportUnits,
      from: fromLabel,
      to: 'Broker',
      departDay: currentDay,
      returnDay: currentDay + roundTripDays
    });
    broker.transportation.inUseCount = broker.transportation.activeTrips.reduce((s, t) => s + Math.max(0, Number(t.transportUnits || 0)), 0);
    const summary = rem.items.map((it) => `${it.tonnes} t ${it.material} (${it.grade})`).join(', ');
    appendEventLog(gameState.shared,{
      day: currentDay,
      message: `Broker collect from ${fromLabel} dispatched (in transit to Broker): ${summary} | Arrive Day ${arriveDay} | Transport: ${transportType} x${transportUnits} | Cost -HKD ${transportCost.toLocaleString()} | +${transportCo2Pct}% CO2 | Vehicle return Day ${currentDay + roundTripDays}`
    });
    broadcastGameState();
    checkGameOver();
    io.emit('inventoryTransferResult', {
      ok: true,
      from: fromLabel,
      to: 'Broker',
      totalTonnes: rem.totalTonnes,
      dispatchedOnly: true,
      arriveDay,
      returnDay: currentDay + roundTripDays
    });
  });

  // ══════════════════════════════════════════════════
  // ── Marketplace: Buy from Vendor (commodity market) ──
  // ══════════════════════════════════════════════════
  socket.on('buyFromVendor', (data) => {
    const { role, material, quantity, maxPricePerTon, grade } = data || {};
    const ROLE_KEY_MAP = { Municipality: 'municipality', MRF: 'mrf', Broker: 'broker' };
    const roleKey = ROLE_KEY_MAP[role];
    if (!roleKey) {
      socket.emit('marketplaceBuyResult', { error: 'Invalid role for vendor purchase.' });
      return;
    }
    // Commodity vendor = Municipality only; Broker/MRF use Trader listings.
    if (role !== 'Municipality') {
      socket.emit('marketplaceBuyResult', {
        error:
          'Only Municipality can buy from the commodity vendor. Broker and MRF must use Trader (listings / player sales).'
      });
      return;
    }
    if (emitIfGameInactive(socket, 'marketplaceBuyResult')) return;
    const mat = String(material || '').toLowerCase();
    if (!MATERIALS.includes(mat)) {
      socket.emit('marketplaceBuyResult', { error: 'Invalid material.' });
      return;
    }
    const buyGrade = String(grade || 'B').toUpperCase();
    if (!['A', 'B', 'C'].includes(buyGrade)) {
      socket.emit('marketplaceBuyResult', { error: 'Invalid grade. Use A, B, or C.' });
      return;
    }
    const vendor = gameState.shared.marketplace?.vendor?.[mat];
    if (!vendor) {
      socket.emit('marketplaceBuyResult', { error: 'Marketplace not available.' });
      return;
    }

    const qty = Math.max(1, Math.floor(Number(quantity) || 0));
    const gradeMult = VENDOR_GRADE_MULTIPLIER[buyGrade] || 1;
    const currentPrice = Math.round(vendor.current * gradeMult * 100) / 100;
    const maxP = Number(maxPricePerTon) || Infinity;

    // Slippage check
    if (currentPrice > maxP) {
      socket.emit('marketplaceBuyResult', { error: `Price moved to $${currentPrice}/t — exceeds your max of $${maxP}/t. Adjust slippage.` });
      return;
    }

    const totalCost = Math.round(currentPrice * qty * 100) / 100;
    const shared = gameState.shared;

    // Budget check
    if (totalCost > shared.budgetHKD) {
      socket.emit('marketplaceBuyResult', { error: `Not enough budget. Need $${totalCost.toLocaleString()}, have $${shared.budgetHKD.toLocaleString()}.` });
      return;
    }

    // Inventory capacity check
    const inv = gameState.roles?.[roleKey]?.inventory;
    if (!inv) {
      socket.emit('marketplaceBuyResult', { error: 'Inventory not found for this role.' });
      return;
    }
    const invNow = getInventoryTotal(inv);
    const invCap = inv.capacityTonnes || INVENTORY_CAPACITY_TONNES[roleKey];
    if (invNow + qty > invCap) {
      socket.emit('marketplaceBuyResult', { error: `Inventory full. ${invNow}/${invCap} t. Free up space first.` });
      return;
    }

    // Execute purchase
    shared.budgetHKD -= totalCost;

    // Vendor sells graded materials (A/B/C) → municipality inventory.materials (material list in UI).
    if (!inv.materials) inv.materials = emptyMaterials();
    if (!inv.materials[mat]) inv.materials[mat] = { A: 0, B: 0, C: 0 };
    inv.materials[mat][buyGrade] = Math.round(((inv.materials[mat][buyGrade] || 0) + qty) * 100) / 100;

    // CO2 from transport
    const co2Kg = qty * (MATERIAL_CO2[mat] || 0.8) * 0.5; // halved for market buy (shorter transport)
    const co2Pct = co2KgToPct(co2Kg, currentDay);
    shared.carbonEmissions.value = Math.min(
      shared.carbonEmissions.limit,
      Math.round((shared.carbonEmissions.value + co2Pct) * 10) / 10
    );
    addCarbonBreakdownPct(shared, 'marketplace', co2Pct);

    const matLabel = mat.charAt(0).toUpperCase() + mat.slice(1);
    appendEventLog(shared,{
      day: currentDay,
      message: `Vendor: ${role} bought ${qty} t ${matLabel} (Grade ${buyGrade}) → materials inventory @ $${Math.round(currentPrice)}/t. Total: −$${totalCost.toLocaleString()}, +${co2Pct}% CO₂`
    });

    socket.emit('marketplaceBuyResult', {
      message: `Bought ${qty} t ${matLabel} (Grade ${buyGrade}) — added to your material inventory. Total: $${totalCost.toLocaleString()}.`
    });

    broadcastGameState();
    checkGameOver();
  });

  // ══════════════════════════════════════════════════
  // ── Marketplace: Buy from Trader (listed items) ──
  // ══════════════════════════════════════════════════
  socket.on('buyFromTrader', (data) => {
    const { role, listingId } = data || {};
    const ROLE_KEY_MAP = { Municipality: 'municipality', MRF: 'mrf', Broker: 'broker' };
    const roleKey = ROLE_KEY_MAP[role];
    if (!roleKey) {
      socket.emit('marketplaceBuyResult', { error: 'Invalid role for trader purchase.' });
      return;
    }
    if (emitIfGameInactive(socket, 'marketplaceBuyResult')) return;

    const listings = gameState.shared.marketplace?.trader;
    if (!listings) {
      socket.emit('marketplaceBuyResult', { error: 'No trader listings.' });
      return;
    }

    const listing = listings.find(l => l.id === listingId);
    if (!listing) {
      socket.emit('marketplaceBuyResult', { error: 'Listing not found.' });
      return;
    }
    if (listing.sold) {
      socket.emit('marketplaceBuyResult', { error: 'Already sold.' });
      return;
    }
    if (listing.expiresDay <= currentDay) {
      socket.emit('marketplaceBuyResult', { error: 'Listing expired.' });
      return;
    }

    const shared = gameState.shared;

    // Budget check
    if (listing.price > shared.budgetHKD) {
      socket.emit('marketplaceBuyResult', { error: `Not enough budget. Need $${listing.price.toLocaleString()}, have $${shared.budgetHKD.toLocaleString()}.` });
      return;
    }

    // Inventory capacity check
    const inv = gameState.roles?.[roleKey]?.inventory;
    if (!inv) {
      socket.emit('marketplaceBuyResult', { error: 'Inventory not found for this role.' });
      return;
    }
    const invNow = getInventoryTotal(inv);
    const invCap = inv.capacityTonnes || INVENTORY_CAPACITY_TONNES[roleKey];
    if (invNow + listing.quantity > invCap) {
      socket.emit('marketplaceBuyResult', { error: `Inventory full. ${invNow}/${invCap} t.` });
      return;
    }

    // Execute purchase
    shared.budgetHKD -= listing.price;
    listing.sold = true;

    // Convert purchased materials into inventory.waste (B/C/F)
    // so they appear immediately on municipality-inventory.html.
    const mat = listing.material;
    const grade = String(listing.grade || 'A').toUpperCase();
    if (!inv.waste) inv.waste = emptyInventoryWaste();
    if (!inv.waste[mat]) inv.waste[mat] = { B: 0, C: 0, F: 0 };
    addWasteByConversion(inv.waste, mat, grade, listing.quantity);

    // CO2 from transport
    const co2Kg = listing.quantity * (MATERIAL_CO2[mat] || 0.8);
    const co2Pct = co2KgToPct(co2Kg, currentDay);
    shared.carbonEmissions.value = Math.min(
      shared.carbonEmissions.limit,
      Math.round((shared.carbonEmissions.value + co2Pct) * 10) / 10
    );
    addCarbonBreakdownPct(shared, 'marketplace', co2Pct);

    const matLabel = mat.charAt(0).toUpperCase() + mat.slice(1);
    appendEventLog(shared,{
      day: currentDay,
      message: `Trader: ${role} bought "${listing.product}" — ${listing.quantity} t ${matLabel} (Grade ${grade}) for $${listing.price.toLocaleString()}. +${co2Pct}% CO₂`
    });

    socket.emit('marketplaceBuyResult', { message: `Purchased "${listing.product}" for $${listing.price.toLocaleString()}.` });

    broadcastGameState();
    checkGameOver();
  });

  socket.on('brokerUpgradeTransportation', (data) => {
    const { role, upgradeType } = data || {};
    if (role !== 'Broker') {
      socket.emit('transportationUpgradeResult', { error: 'Only Broker can upgrade transportation.' });
      return;
    }
    if (!gameState) {
      socket.emit('transportationUpgradeResult', {
        error: 'Game has not started yet. Open the lobby, pick all three roles, then try again.'
      });
      return;
    }
    if (isGameOver) {
      socket.emit('transportationUpgradeResult', { error: 'Game is over.' });
      return;
    }

    const type = String(upgradeType || '').toLowerCase();
    const typeCfg = TRANSPORT_UPGRADE_TABLE[type];
    if (!typeCfg) {
      socket.emit('transportationUpgradeResult', { error: 'Invalid upgrade type.' });
      return;
    }

    const broker = gameState.roles?.broker;
    if (!broker) {
      socket.emit('transportationUpgradeResult', { error: 'Broker state not found.' });
      return;
    }
    if (!broker.transportation) {
      broker.transportation = {
        currentLoadTonnes: 0,
        capacityTonnes: 150,
        inUseCount: 0,
        upgrades: { speed: 0, capacity: 0, green: 0, fleet: 0 }
      };
    }
    if (!broker.transportation.upgrades) {
      broker.transportation.upgrades = { speed: 0, capacity: 0, green: 0, fleet: 0 };
    }

    const currentLevel = Math.max(0, Number(broker.transportation.upgrades[type] || 0));
    if (currentLevel >= 5) {
      socket.emit('transportationUpgradeResult', { error: `${type} is already at max level.` });
      return;
    }
    const nextLevel = currentLevel + 1;
    const tier = typeCfg.tiers[nextLevel];
    if (!tier) {
      socket.emit('transportationUpgradeResult', { error: 'Upgrade tier config missing.' });
      return;
    }

    const shared = gameState.shared;
    if ((shared.budgetHKD || 0) < tier.cost) {
      socket.emit('transportationUpgradeResult', { error: `Not enough budget for upgrade (need HKD ${tier.cost.toLocaleString()}).` });
      return;
    }

    shared.budgetHKD -= tier.cost;
    const co2Pct = Math.round((tier.co2 * UPGRADE_INSTALLATION_CO2_TO_PERCENT) * 10) / 10;
    shared.carbonEmissions.value = Math.min(
      shared.carbonEmissions.limit,
      Math.round((shared.carbonEmissions.value + co2Pct) * 10) / 10
    );
    addCarbonBreakdownPct(shared, 'upgrades', co2Pct);
    broker.transportation.upgrades[type] = nextLevel;

    const allLv = broker.transportation.upgrades;
    const speedLv = Number(allLv.speed || 1);
    const capacityLv = Number(allLv.capacity || 1);
    const greenLv = Number(allLv.green || 1);
    const fleetLv = Number(allLv.fleet || 1);

    const speedMult = TRANSPORT_UPGRADE_TABLE.speed.tiers[speedLv]?.mult ?? 1;
    const capMult = TRANSPORT_UPGRADE_TABLE.capacity.tiers[capacityLv]?.mult ?? 1;
    const greenMult = TRANSPORT_UPGRADE_TABLE.green.tiers[greenLv]?.mult ?? 1;
    const fleetAdd = TRANSPORT_UPGRADE_TABLE.fleet.tiers[fleetLv]?.add ?? 0;

    const baseDeliveryDays = 3;
    const baseReturnDays = 3;
    const baseCapacityT = 10;
    const baseCo2Kg = 150;
    const baseQty = 5;

    const deliveryDays = (baseDeliveryDays * speedMult).toFixed(2);
    const returnDays = (baseReturnDays * speedMult).toFixed(2);
    const capPerTruck = (baseCapacityT * capMult).toFixed(2);
    const co2PerTrip = (baseCo2Kg * greenMult).toFixed(2);
    const fleetQty = baseQty + fleetAdd;

    appendEventLog(shared,{
      day: currentDay,
      message: `Broker transportation upgrade (${type}) Lv.${currentLevel}->Lv.${nextLevel} | Cost -HKD ${tier.cost.toLocaleString()} | +${co2Pct}% CO2 | Qty ${fleetQty} | Capacity ${capPerTruck} t/truck | CO2 ${co2PerTrip} kg/trip | Delivery ${deliveryDays} d | Return ${returnDays} d`
    });

    broadcastGameState();
    checkGameOver();
    socket.emit('transportationUpgradeResult', {
      ok: true,
      upgradeType: type,
      newLevel: nextLevel,
      upgrades: broker.transportation.upgrades
    });
  });

  socket.on('restartGame', (_data, ack) => {
    const player = players.find((p) => p.id === socket.id);
    const reqRole = _data && _data.role;
    // When players navigate between pages, the socket id changes and server-side `player.role`
    // may be null. Rely on the role sent from the client for the restart gate.
    const role = reqRole || (player && player.role);

    // If we don't know the role, refuse the restart gate request.
    if (!role || !AVAILABLE_ROLES.includes(role)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Role not assigned.' });
      return;
    }

    // If the game isn't actually over (gate not active), keep old behavior.
    if (!isRestartGateActive) {
      restartGameSession();
      io.emit('gameRestarted', {
        message: 'Game restarted successfully.',
        day: currentDay,
        maxDay: MAX_DAY,
        allReady: true
      });
      if (typeof ack === 'function') ack({ ok: true, allReady: true });
      return;
    }

    restartReadyRoles.add(role);
    const readyCount = restartReadyRoles.size;

    // Not all three roles are ready yet: don't restart, just ack "waiting".
    if (readyCount < MAX_PLAYERS) {
      if (typeof ack === 'function') {
        ack({
          ok: true,
          allReady: false,
          waiting: true,
          readyCount,
          maxPlayers: MAX_PLAYERS
        });
      }
      return;
    }

    // All three are ready: restart and notify everyone.
    isRestartGateActive = false;
    restartReadyRoles.clear();

    restartGameSession();
    io.emit('gameRestarted', {
      message: 'Game restarted successfully.',
      day: currentDay,
      maxDay: MAX_DAY,
      allReady: true
    });

    if (typeof ack === 'function') ack({ ok: true, allReady: true });
  });

  // ── Disconnect → free role ──
  socket.on('disconnect', () => {
    console.log(`❌ Disconnected: ${socket.id}`);

    const leaving = players.find(p => p.id === socket.id);

    if (leaving && leaving.role) {
      // During an active round, do not release seats when lobby tabs disconnect (everyone navigates to game.html).
      const roundActive = gameState && !isGameOver;
      if (!roundActive) {
        takenRoles = takenRoles.filter(r => r !== leaving.role);
        console.log(`🔓 Freed role: ${leaving.role}.  Taken now: [${takenRoles}]`);
      } else {
        console.log(`🔒 Role kept for active round: ${leaving.role} (socket ${socket.id} left lobby)`);
      }
    }

    players = players.filter(p => p.id !== socket.id);
    console.log(`👥 Players remaining: ${players.length}/${MAX_PLAYERS}`);

    io.emit('roleUpdate', {
      takenRoles: [...takenRoles],
      playerCount: players.length,
      maxPlayers: MAX_PLAYERS,
      difficulty: normalizeDifficulty(gameState ? activeDifficulty : lobbyDifficulty)
    });

    io.emit('lobbyUpdate', {
      playerCount: players.length,
      maxPlayers: MAX_PLAYERS,
      takenRoles: [...takenRoles],
      difficulty: normalizeDifficulty(gameState ? activeDifficulty : lobbyDifficulty)
    });
  });
});

const requestedPort = process.env.PORT ? Number(process.env.PORT) : null;
const BASE_PORT = requestedPort || 3000;

function listenWithFallback(startPort, maxAttempts = 11) {
  let attempt = 0;

  const tryListen = (port) => {
    server.listen(port, () => {
      console.log(`🌐 Server running → http://localhost:${port}`);
    });
  };

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      // If user explicitly requested a port, don't auto-fallback.
      if (requestedPort) {
        console.error(`❌ Port ${requestedPort} is already in use.`);
        console.error(`   - Stop the other process using it, or`);
        console.error(`   - Pick a different port: PORT=3001 node server.js`);
        process.exit(1);
      }

      attempt += 1;
      const nextPort = startPort + attempt;
      if (attempt >= maxAttempts) {
        console.error(`❌ Ports ${startPort}..${startPort + maxAttempts - 1} are all in use.`);
        console.error(`   Try: PORT=4000 node server.js`);
        process.exit(1);
      }
      console.warn(`⚠️  Port ${startPort + attempt - 1} in use, trying ${nextPort}…`);
      tryListen(nextPort);
      return;
    }

    console.error(err);
    process.exit(1);
  });

  tryListen(startPort);
}

tryInitFirestore();
listenWithFallback(BASE_PORT);