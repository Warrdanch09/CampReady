import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Circle,
  ClipboardCheck,
  LayoutDashboard,
  Plus,
  Settings,
  Trash2,
  Truck,
  Users,
  Utensils,
} from "lucide-react";
import { supabase, hasSupabase } from "./supabaseClient";
import AuthScreen from "./AuthScreen";
import { mergeStates, prepareStateForSave, getClientId, stripSyncMetadata } from "./syncState";

// -----------------------------------------------------------------------------
// Constants / seed data
// -----------------------------------------------------------------------------

const uid = (prefix = "id") => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const pct = (done, total) => (total ? Math.round((done / total) * 100) : 0);
const STORAGE_KEY = "campready-mvp-state-v1";

function makeShoppingKey(item = {}) {
  return [
    String(item.name || "").trim().toLowerCase(),
    String(item.unit || "").trim().toLowerCase(),
    String(item.category || "Other").trim().toLowerCase(),
    String(item.store || "Unassigned").trim().toLowerCase(),
  ].join("|");
}

function normalizeShoppingStatuses(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item && (item.key || item.id))
      .map((item) => {
        const bought = item.bought ?? item.have ?? item.checked ?? false;
        const packed = item.packed ?? false;
        return {
          id: String(item.id || item.key),
          key: String(item.key || item.id),
          bought: Boolean(bought),
          packed: Boolean(packed),
          // Keep legacy checked for older code paths/backups, but new UI uses bought + packed.
          checked: Boolean(bought && packed),
        };
      });
  }

  if (value && typeof value === "object") {
    return Object.entries(value).map(([key, checked]) => ({
      id: String(key),
      key: String(key),
      bought: Boolean(checked),
      packed: false,
      checked: Boolean(checked),
    }));
  }

  return [];
}


function stableHash(value) {
  const text = String(value || "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function normalizeRecipesForSync(recipes = []) {
  return (recipes || []).map((meal, mealIndex) => {
    const dayPart = meal.dayKey || meal.dateKey || `${meal.destinationId || "unassigned"}-day-${Number(meal.dayNumber ?? meal.night) || 1}`;
    const mealId = meal.id || `meal-${stableHash(`${meal.name || "meal"}|${meal.type || ""}|${dayPart}|${mealIndex}`)}`;
    return {
      ...meal,
      id: mealId,
      ingredients: (meal.ingredients || []).map((ing, ingIndex) => ({
        ...ing,
        id: ing.id || `ing-${stableHash(`${mealId}|${ing.name || "ingredient"}|${ing.qty || ""}|${ing.unit || ""}|${ing.category || ""}|${ing.store || ""}|${ingIndex}`)}`,
      })),
    };
  });
}

function normalizeFamilyForSync(family = []) {
  return (family || []).map((member) => ({
    ...member,
    id: member.id || uid("member"),
    items: (member.items || []).map((item) => ({
      ...item,
      id: item.id || uid("pack"),
    })),
  }));
}

function normalizeTripForSync(trip) {
  if (!trip || typeof trip !== "object") return trip;
  const nextTrip = { ...trip };
  nextTrip.family = normalizeFamilyForSync(nextTrip.family || []);
  nextTrip.recipes = normalizeRecipesForSync(nextTrip.recipes || []);
  nextTrip.shoppingStatuses = normalizeShoppingStatuses(nextTrip.shoppingStatuses || nextTrip.shoppingChecks);
  delete nextTrip.shoppingChecks;
  delete nextTrip.selectedMeals;
  delete nextTrip.activeMember; // active family member is local UI state, not shared trip data
  return nextTrip;
}

function ensureStableIds(state) {
  if (!state || typeof state !== "object") return state;
  const next = clone(state);

  next.appTemplate = mergeTemplateDefaults(next.appTemplate);
  if (Array.isArray(next.family)) next.family = normalizeFamilyForSync(next.family);
  if (Array.isArray(next.recipes)) next.recipes = normalizeRecipesForSync(next.recipes);
  if (Array.isArray(next.trips)) next.trips = next.trips.map(normalizeTripForSync);
  if (next.trip) next.trip = normalizeTripForSync(next.trip);

  next.shoppingStatuses = normalizeShoppingStatuses(next.shoppingStatuses || next.shoppingChecks);
  delete next.shoppingChecks;
  delete next.selectedMeals;
  delete next.activeMember; // keep this device's selected family member local only

  return next;
}


function migrateImportedBackupState(importedState) {
  if (!importedState || typeof importedState !== "object") return null;

  const clean = stripSyncMetadata(importedState);
  const legacyTrip = clean.trip && typeof clean.trip === "object" ? clean.trip : null;
  const rootScopedData = {
    tasks: clean.tasks,
    family: clean.family,
    recipes: clean.recipes,
    manualShoppingItems: clean.manualShoppingItems,
    shoppingStatuses: clean.shoppingStatuses || clean.shoppingChecks,
  };

  const hasRootScopedData = Boolean(
    rootScopedData.tasks ||
    (Array.isArray(rootScopedData.family) && rootScopedData.family.length) ||
    (Array.isArray(rootScopedData.recipes) && rootScopedData.recipes.length) ||
    (Array.isArray(rootScopedData.manualShoppingItems) && rootScopedData.manualShoppingItems.length) ||
    (rootScopedData.shoppingStatuses && (
      Array.isArray(rootScopedData.shoppingStatuses)
        ? rootScopedData.shoppingStatuses.length
        : Object.keys(rootScopedData.shoppingStatuses).length
    ))
  );

  let trips = Array.isArray(clean.trips) ? clone(clean.trips) : [];
  const targetTripId = clean.activeTripId || legacyTrip?.id || trips[0]?.id || (legacyTrip || hasRootScopedData ? uid("trip") : null);

  if (!trips.length && (legacyTrip || hasRootScopedData)) {
    trips = [{
      id: targetTripId,
      name: legacyTrip?.name || clean.tripName || "Imported Trip",
      departureDate: legacyTrip?.departureDate || clean.departureDate || "",
      destinations: clone(legacyTrip?.destinations || clean.destinations || []),
      status: "Current",
      createdAt: legacyTrip?.createdAt || new Date().toLocaleDateString(),
    }];
  }

  trips = trips.map((trip, index) => {
    const shouldAttachRootData = hasRootScopedData && (
      trip.id === targetTripId ||
      index === 0 ||
      !trip.tasks ||
      !trip.family ||
      !trip.recipes
    );

    const nextTrip = {
      ...trip,
      id: trip.id || (index === 0 && targetTripId ? targetTripId : uid("trip")),
      name: trip.name || legacyTrip?.name || "Imported Trip",
      departureDate: trip.departureDate || legacyTrip?.departureDate || "",
      destinations: clone(trip.destinations || legacyTrip?.destinations || []),
      tasks: shouldAttachRootData ? clone(trip.tasks || rootScopedData.tasks || {}) : clone(trip.tasks || {}),
      family: shouldAttachRootData ? normalizeFamilyForSync(trip.family || rootScopedData.family || []) : normalizeFamilyForSync(trip.family || []),
      recipes: shouldAttachRootData ? normalizeRecipesForSync(trip.recipes || rootScopedData.recipes || []) : normalizeRecipesForSync(trip.recipes || []),
      manualShoppingItems: shouldAttachRootData ? clone(trip.manualShoppingItems || rootScopedData.manualShoppingItems || []) : clone(trip.manualShoppingItems || []),
      shoppingStatuses: shouldAttachRootData
        ? normalizeShoppingStatuses(trip.shoppingStatuses || trip.shoppingChecks || rootScopedData.shoppingStatuses || [])
        : normalizeShoppingStatuses(trip.shoppingStatuses || trip.shoppingChecks || []),
    };

    delete nextTrip.shoppingChecks;
    delete nextTrip.selectedMeals;
    delete nextTrip.activeMember;
    return normalizeTripForSync(nextTrip);
  });

  const migrated = {
    trips,
    appTemplate: mergeTemplateDefaults(clean.appTemplate),
    maintenanceItems: Array.isArray(clean.maintenanceItems) ? clone(clean.maintenanceItems) : [],
    rvConfig: clean.rvConfig || {},
    towVehicle: clean.towVehicle || {},
    rvNotes: Array.isArray(clean.rvNotes) ? clone(clean.rvNotes) : [],
  };

  return ensureStableIds(migrated);
}

const loadSavedState = () => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const saveState = (state) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("CampReady could not save state", e);
  }
};

const clearSavedState = () => {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
};

const categoryOptions = [
  "Dairy","Meat","Pantry","Produce","Snacks","Breads","Drinks",
  "Camp Supplies","Cutlery","Cooking Supplies","Paper Goods","Cleaning Supplies","Frozen Foods","Condiments","Breakfast","Dessert","Other",
];

const maintenanceCategories = [
  "RV Exterior","Chassis","Tires","Plumbing","Electrical","Safety","Generator","Tow Vehicle","Other",
];

const checklistTemplates = {
  prep: {
    label: "RV Prep",
    groups: {
      "Exterior & Roof": ["Wash RV exterior","Wax RV exterior","Inspect roof membrane","Inspect roof seams and vents","Inspect window and slide seals for leaks","Clean awning and inspect fabric"],
      "Tires, Brakes & Suspension": ["Check tire pressure","Add air to tires if needed","Inspect tire sidewalls and tread","Torque lug nuts","Grease suspension","Check trailer brakes","Test breakaway switch"],
      "Systems & Utilities": ["Check propane level","Check battery charge","Test refrigerator","Test furnace / AC","Inspect sewer hose and fittings","Check freshwater hose and power cord"],
    },
  },
  inside: {
    label: "Inside Prep",
    groups: {
      Cleaning: ["Sweep floors","Wipe counters","Clean bathroom","Sanitize fridge","Empty trash"],
      Consumables: ["Check paper plates","Check plastic silverware","Check napkins and paper towels","Check toilet paper","Check trash bags","Check dish soap and hand soap","Check first aid supplies"],
      Linens: ["Pack bedding","Pack pillows","Pack blankets","Pack bath towels","Pack beach towels","Pack kitchen towels"],
    },
  },
  towVehiclePrep: {
    label: "Tow Vehicle Prep",
    groups: {
      "Exterior & Fluids": ["Wash tow vehicle", "Wax tow vehicle", "Check oil", "Check coolant", "Check windshield washer fluid", "Fill fuel tank"],
      "Tires & Safety": ["Check tire pressure", "Inspect tire tread and sidewalls", "Check spare tire", "Check jack and tire tools", "Check emergency kit", "Check mirrors"],
      "Hitch & Towing": ["Inspect hitch receiver", "Inspect hitch pin and clip", "Inspect weight distribution bars", "Inspect sway control", "Confirm brake controller settings", "Test trailer light connection"],
    },
  },
  towVehiclePacking: {
    label: "Tow Vehicle Packing",
    groups: {
      "Cargo & Gear": ["Load firewood", "Load bikes", "Load tools", "Load air compressor", "Load leveling blocks", "Load outdoor games"],
      "Safety & Roadside": ["Pack jumper cables", "Pack tire gauge", "Pack first aid kit", "Pack flashlight", "Pack gloves", "Pack ratchet straps"],
      "Cab Items": ["Pack charging cables", "Pack snacks", "Pack drinks", "Pack trash bags", "Pack travel documents", "Pack sunglasses"],
    },
  },
  departHome: {
    label: "Depart Home",
    groups: {
      "Tow Vehicle": ["Check oil","Fill gas","Check mirrors","Load tools","Load emergency kit"],
      Hookup: ["Hitch trailer","Lock coupler","Attach safety chains","Attach breakaway cable","Connect electrical plug","Raise tongue jack","Install weight distribution bars"],
      "Final Walkaround": ["Check brake lights","Check turn signals","Close roof vents","Close windows","Retract awning","Retract steps","Remove wheel chocks","Lock house doors"],
    },
  },
  campSetup: {
    label: "Camp Setup",
    groups: {
      Leveling: ["Position trailer","Level side-to-side","Chock wheels","Unhitch","Level front-to-back","Lower stabilizers"],
      Utilities: ["Connect power","Check surge protector","Connect freshwater","Connect pressure regulator","Connect sewer if needed","Turn on propane"],
      Setup: ["Open slides","Extend awning","Set outdoor rug","Set chairs","Set grill","Put food away"],
    },
  },
  leaveCamp: {
    label: "Leave Camp",
    groups: {
      Interior: ["Secure loose items","Close cabinets","Clear counters","Close vents","Retract slides"],
      Exterior: ["Pack chairs","Pack outdoor rug","Pack grill","Retract awning","Dump tanks if needed","Disconnect water","Disconnect power"],
      Safety: ["Hitch trailer","Attach chains","Connect electrical","Raise stabilizers","Remove chocks","Check lights","Final walkaround","Check campsite for forgotten items"],
    },
  },
  postTrip: {
    label: "Post Trip",
    groups: {
      Unpacking: ["Remove dirty laundry","Remove leftover food","Unload personal bags","Unload towels","Unload trash"],
      Cleaning: ["Sweep RV","Wipe counters","Clean bathroom","Clean fridge","Wash towels","Wash bedding"],
      Reset: ["Empty tanks if needed","Refill consumables","Recharge batteries","Plug RV into shore power","Inspect for damage","Note repairs needed"],
    },
  },
};

const starterDestinations = [];


function templateItemName(item) {
  return typeof item === "string" ? item : item?.name || "";
}

function normalizeTemplateItem(item) {
  if (typeof item === "string") return { name: item, hidden: false };
  return { name: item?.name || "Checklist item", hidden: Boolean(item?.hidden) };
}

function mergeTemplateDefaults(savedTemplate) {
  const saved = savedTemplate && typeof savedTemplate === "object" ? clone(savedTemplate) : {};
  const merged = {};

  Object.entries(checklistTemplates).forEach(([sectionKey, defaultSection]) => {
    const savedSection = saved[sectionKey] || {};
    const section = {
      label: savedSection.label || defaultSection.label,
      groups: {},
    };

    Object.entries(defaultSection.groups || {}).forEach(([groupName, defaultItems]) => {
      const savedItems = Array.isArray(savedSection.groups?.[groupName]) ? savedSection.groups[groupName] : [];
      const nextItems = savedItems.map(normalizeTemplateItem);
      const existingNames = new Set(nextItems.map((item) => templateItemName(item).toLowerCase()));

      defaultItems.forEach((defaultItem) => {
        const name = templateItemName(defaultItem);
        if (!existingNames.has(name.toLowerCase())) nextItems.push(normalizeTemplateItem(defaultItem));
      });

      section.groups[groupName] = nextItems;
    });

    Object.entries(savedSection.groups || {}).forEach(([groupName, savedItems]) => {
      if (!section.groups[groupName]) section.groups[groupName] = (savedItems || []).map(normalizeTemplateItem);
    });

    merged[sectionKey] = section;
  });

  Object.entries(saved).forEach(([sectionKey, savedSection]) => {
    if (!merged[sectionKey]) {
      merged[sectionKey] = {
        label: savedSection?.label || sectionKey,
        groups: Object.fromEntries(Object.entries(savedSection?.groups || {}).map(([groupName, items]) => [groupName, (items || []).map(normalizeTemplateItem)])),
      };
    }
  });

  return merged;
}

const emptyTripState = { name: "", departureDate: "", destinations: [] };

function isStarterTripRecord(trip) {
  return trip?.id === "trip-starter" || trip?.name === "Memorial Weekend Camping";
}

function isLegacySeedFamilyMember(member) {
  return ["kyle", "adult2", "kid1", "kid2"].includes(member?.id) &&
    ["Kyle", "Adult 2", "Kid 1", "Kid 2"].includes(member?.name || "");
}

function isLegacySeedRecipe(recipe) {
  return ["burgers", "pancakes", "tacos"].includes(recipe?.id);
}

function isLegacySeedMaintenance(item) {
  return typeof item?.id === "string" && item.id.startsWith("maint-");
}

function isLegacySeedShoppingItem(item) {
  return item?.id === "drinks";
}

function isLegacySeedNote(note) {
  return note?.id === "note-starter";
}

function hasMeaningfulConfig(obj) {
  if (!obj || typeof obj !== "object") return false;
  return Object.entries(obj).some(([key, value]) => {
    if (["rvType"].includes(key)) return false;
    return value !== "" && value !== null && value !== undefined;
  });
}

function hasMeaningfulTasks(tasks) {
  if (!tasks || typeof tasks !== "object") return false;
  return Object.values(tasks).some((section) =>
    section && typeof section === "object" && Object.values(section).some((group) =>
      Array.isArray(group) && group.some((task) => task?.done || task?.na)
    )
  );
}

function hasRealUserData(state) {
  if (!state || typeof state !== "object") return false;
  const trips = Array.isArray(state.trips) ? state.trips.filter((t) => !isStarterTripRecord(t) && t?.status !== "Deleted") : [];
  return Boolean(
    trips.length ||
    hasMeaningfulConfig(state.rvConfig) ||
    hasMeaningfulConfig(state.towVehicle) ||
    hasMeaningfulTasks(state.tasks) ||
    (Array.isArray(state.family) && state.family.some((m) => !isLegacySeedFamilyMember(m))) ||
    (Array.isArray(state.recipes) && state.recipes.some((r) => !isLegacySeedRecipe(r))) ||
    (Array.isArray(state.manualShoppingItems) && state.manualShoppingItems.length > 0) ||
    normalizeShoppingStatuses(state.shoppingStatuses || state.shoppingChecks).some((s) => s.bought || s.packed || s.checked) ||
    (Array.isArray(state.maintenanceItems) && state.maintenanceItems.some((i) => !isLegacySeedMaintenance(i))) ||
    (Array.isArray(state.rvNotes) && state.rvNotes.some((n) => hasMeaningfulConfig(n)))
  );
}

function sanitizeSeedData(state) {
  if (!state || typeof state !== "object") return state;
  const next = clone(state);
  if (Array.isArray(next.trips)) {
    next.trips = next.trips.filter((trip) => !isStarterTripRecord(trip));
  }
  if (Array.isArray(next.family)) next.family = next.family.filter((m) => !isLegacySeedFamilyMember(m));
  if (Array.isArray(next.recipes)) next.recipes = normalizeRecipesForSync(next.recipes.filter((r) => !isLegacySeedRecipe(r)));
  if (Array.isArray(next.manualShoppingItems)) next.manualShoppingItems = next.manualShoppingItems.filter((i) => !isLegacySeedShoppingItem(i));
  if (Array.isArray(next.maintenanceItems)) next.maintenanceItems = next.maintenanceItems.filter((i) => !isLegacySeedMaintenance(i));
  if (Array.isArray(next.rvNotes)) next.rvNotes = next.rvNotes.filter((n) => !isLegacySeedNote(n));
  if (isLegacySeedFamilyMember({ id: next.activeMember, name: next.activeMember === "kyle" ? "Kyle" : "" })) next.activeMember = null;
  if (!next.trips?.some((trip) => trip.id === next.activeTripId)) {
    next.activeTripId = next.trips?.[0]?.id || null;
  }
  if (isStarterTripRecord(next.trip) || !next.activeTripId) {
    next.trip = next.trips?.[0] ? { ...clone(next.trips[0]), status: undefined, createdAt: undefined } : clone(emptyTripState);
  }
  return hasRealUserData(next) ? ensureStableIds(next) : null;
}

const defaultMaintenanceItems = [];
const defaultRecipes = [];

function packTemplate(nights) {
  return [
    { id: uid("pack"), name: "Shirts", qty: nights + 1, packed: false },
    { id: uid("pack"), name: "Pants / shorts", qty: nights + 1, packed: false },
    { id: uid("pack"), name: "Underwear", qty: nights + 2, packed: false },
    { id: uid("pack"), name: "Socks", qty: nights + 2, packed: false },
    { id: uid("pack"), name: "Pajamas", qty: 1, packed: false },
    { id: uid("pack"), name: "Sweatshirt / jacket", qty: 1, packed: false },
    { id: uid("pack"), name: "Swimsuit", qty: 1, packed: false },
    { id: uid("pack"), name: "Shoes / sandals", qty: 1, packed: false },
    { id: uid("pack"), name: "Toiletries", qty: 1, packed: false },
  ];
}

const defaultFamily = [];

// -----------------------------------------------------------------------------
// Utility functions
// -----------------------------------------------------------------------------

function todayISO() { return new Date().toISOString().slice(0, 10); }

function parseLocalDate(dateString) {
  const [year, month, day] = String(dateString || todayISO()).split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function formatDate(date) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function parseDateOnly(dateString) {
  if (!dateString) return null;
  const [year, month, day] = String(dateString).split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatDateRangeLabel(start, end) {
  if (!start || !end) return "";
  return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

function buildDestinationDateRanges(departureDate, destinations) {
  let cursor = parseDateOnly(departureDate);
  return (destinations || []).map((dest) => {
    if (!cursor) return "";
    const nights = Math.max(1, Number(dest.nights) || 1);
    const start = cursor;
    const end = addDays(start, nights);
    cursor = end;
    return formatDateRangeLabel(start, end);
  });
}

function formatDayLabel(date) {
  if (!date) return "Unscheduled Day";
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function buildTripMealDays(departureDate, destinations = []) {
  const depart = parseDateOnly(departureDate);
  const safeDestinations = destinations.length ? destinations : [{ id: "unassigned", name: "Destination", nights: 1 }];
  const days = [];
  let cursor = depart || parseDateOnly(todayISO());

  safeDestinations.forEach((dest, destIndex) => {
    const nights = Math.max(1, Number(dest.nights) || 1);
    for (let dayIndex = 1; dayIndex <= nights; dayIndex += 1) {
      const date = cursor ? addDays(cursor, dayIndex - 1) : null;
      const firstDayOfStop = dayIndex === 1;
      const multiDestination = safeDestinations.length > 1;
      const previousDest = destIndex === 0 ? null : safeDestinations[destIndex - 1];
      const routeLabel = destIndex === 0
        ? `Home → ${dest.name || "Destination"}`
        : `${previousDest?.name || "Previous Stop"} → ${dest.name || "Destination"}`;
      days.push({
        key: `${dest.id}-day-${dayIndex}`,
        destinationId: dest.id,
        destinationName: dest.name || "Destination",
        dayNumber: dayIndex,
        date,
        dateKey: date ? date.toISOString().slice(0, 10) : "",
        label: `${formatDayLabel(date)} — ${firstDayOfStop && multiDestination ? `Travel Day: ${routeLabel}` : (dest.name || "Destination")}`,
        shortLabel: `${formatDayLabel(date)}${firstDayOfStop && multiDestination ? " • Travel Day" : ""}`,
        routeLabel: firstDayOfStop && multiDestination ? routeLabel : "",
        isTravelDay: firstDayOfStop && multiDestination,
      });
    }
    if (cursor) cursor = addDays(cursor, nights);
  });

  const lastDest = safeDestinations[safeDestinations.length - 1];
  if (lastDest) {
    const returnDate = cursor || null;
    const routeLabel = `${lastDest.name || "Last Destination"} → Home`;
    days.push({
      key: `${lastDest.id || "destination"}-return-home`,
      destinationId: lastDest.id,
      destinationName: lastDest.name || "Last Destination",
      dayNumber: Math.max(1, Number(lastDest.nights) || 1) + 1,
      date: returnDate,
      dateKey: returnDate ? returnDate.toISOString().slice(0, 10) : "",
      label: `${formatDayLabel(returnDate)} — Travel Day: ${routeLabel}`,
      shortLabel: `${formatDayLabel(returnDate)} • Travel Day`,
      routeLabel,
      isTravelDay: true,
      isReturnHomeDay: true,
    });
  }

  return days;
}

function daysBetween(a, b) { return Math.ceil((b.getTime() - a.getTime()) / 86400000); }

function addFrequency(date, value, unit) {
  const next = new Date(date);
  const amount = Number(value) || 1;
  if (unit === "days") next.setDate(next.getDate() + amount);
  else if (unit === "weeks") next.setDate(next.getDate() + amount * 7);
  else if (unit === "years") next.setFullYear(next.getFullYear() + amount);
  else if (unit === "trips") next.setDate(next.getDate() + amount * 30);
  else next.setMonth(next.getMonth() + amount);
  return next;
}

function maintenanceStatus(item) {
  const start = parseLocalDate(item.lastDone);
  const due = addFrequency(start, item.frequencyValue, item.frequencyUnit);
  const now = new Date();
  const totalDays = Math.max(1, daysBetween(start, due));
  const elapsedDays = Math.max(0, daysBetween(start, now));
  const daysRemaining = daysBetween(now, due);
  const percent = Math.min(100, Math.max(0, Math.round((elapsedDays / totalDays) * 100)));
  const status = daysRemaining < 0 ? "Overdue" : percent >= 80 ? "Due Soon" : "On Track";
  return { due, totalDays, elapsedDays, daysRemaining, percent, status };
}

function totalNights(destinations) {
  return destinations.reduce((sum, d) => sum + (Number(d.nights) || 1), 0);
}

function taskName(task) { return typeof task === "string" ? task : task.name; }
function taskHidden(task) { return typeof task === "object" && task.hidden; }

function buildSection(template, sectionKey, prefix = sectionKey) {
  const groups = {};
  Object.entries(template[sectionKey].groups).forEach(([group, list]) => {
    groups[group] = list
      .filter((item) => !taskHidden(item))
      .map((item, i) => ({ id: `${prefix}-${group}-${i}`, name: taskName(item), done: false, na: false }));
  });
  return groups;
}

function buildTasks(template, destinations) {
  const tasks = {
    prep: buildSection(template, "prep"),
    inside: buildSection(template, "inside"),
    towVehiclePrep: buildSection(template, "towVehiclePrep"),
    towVehiclePacking: buildSection(template, "towVehiclePacking"),
    departHome: buildSection(template, "departHome"),
    postTrip: buildSection(template, "postTrip"),
  };
  destinations.forEach((dest) => {
    tasks[`${dest.id}-campSetup`] = buildSection(template, "campSetup", `${dest.id}-campSetup`);
    tasks[`${dest.id}-leaveCamp`] = buildSection(template, "leaveCamp", `${dest.id}-leaveCamp`);
  });
  return tasks;
}

function buildShoppingList(recipes, manualItems) {
  const map = new Map();

  // CampReady now treats every planned meal as part of the shopping list.
  // This avoids a separate selectedMeals sync conflict path and matches the
  // intended workflow: if it is on the meal plan, its ingredients are needed.
  (recipes || []).forEach((meal) => {
    meal?.ingredients?.forEach((ing) => {
      const key = makeShoppingKey(ing);
      const existing = map.get(key) || { ...ing, key, checkKey: key, category: ing.category || "Other", store: ing.store || "Unassigned", qty: 0, sources: [], manualIds: [] };
      existing.qty += Number(ing.qty) || 1;
      existing.sources.push(meal.name);
      map.set(key, existing);
    });
  });

  manualItems.forEach((item) => {
    const key = makeShoppingKey(item);
    const existing = map.get(key) || { ...item, key, checkKey: key, category: item.category || "Other", store: item.store || "Unassigned", qty: 0, sources: [], manualIds: [] };
    existing.qty += Number(item.qty) || 1;
    existing.sources = Array.from(new Set([...(existing.sources || []), "Manual"]));
    existing.manualIds.push(item.id);
    map.set(key, existing);
  });
  return Array.from(map.values()).sort(
    (a, b) => (a.store || "Unassigned").localeCompare(b.store || "Unassigned") || a.name.localeCompare(b.name)
  );
}

// -----------------------------------------------------------------------------
// Shared UI primitives
// -----------------------------------------------------------------------------

function Card({ children, className = "" }) {
  return <div className={`rounded-3xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}>{children}</div>;
}

function Progress({ value, tone = "default" }) {
  const safeValue = Math.max(0, Math.min(100, value || 0));
  const fillClass = tone === "risk" ? "bg-gradient-to-r from-green-500 via-yellow-400 to-red-500" : "bg-slate-900";
  return (
    <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
      <div className={`h-full ${fillClass}`} style={{ width: `${safeValue}%` }} />
    </div>
  );
}

function LengthInput({ feet, inches, onFeetChange, onInchesChange }) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2">
      <input className="w-full rounded-2xl border px-4 py-2" type="number" value={feet ?? ""} onChange={(e) => onFeetChange(e.target.value)} placeholder="32" />
      <span className="text-sm font-semibold text-slate-500">ft</span>
      <input className="w-full rounded-2xl border px-4 py-2" type="number" value={inches ?? ""} onChange={(e) => onInchesChange(e.target.value)} placeholder="0" />
      <span className="text-sm font-semibold text-slate-500">in</span>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block min-w-0">
      <div className="mb-1 text-xs font-semibold text-slate-500">{label}</div>
      {children}
    </label>
  );
}

function HelpLabel({ label, help }) {
  const [open, setOpen] = useState(false);
  const helpId = useMemo(() => uid("help"), []);
  return (
    <span className="inline-flex max-w-full items-center gap-2 align-middle">
      {open && (
        <button type="button" aria-label="Close help" className="fixed inset-0 z-40 cursor-default bg-transparent"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); }} />
      )}
      <span className="min-w-0 break-words">{label}</span>
      <span className="relative inline-flex shrink-0">
        <button type="button"
          aria-label={typeof label === "string" ? `Help for ${label}` : "Help"}
          aria-expanded={open}
          aria-describedby={open ? helpId : undefined}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((p) => !p); }}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          className="relative z-50 inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 bg-white text-[11px] font-bold text-slate-500"
        >?</button>
        {open && (
          <span id={helpId} role="tooltip"
            className="absolute left-0 top-full z-50 mt-2 w-[min(18rem,calc(100vw-3rem))] rounded-xl border border-slate-200 bg-white p-3 text-xs font-normal text-slate-600 shadow-xl">
            {help}
          </span>
        )}
      </span>
    </span>
  );
}

function CollapsibleCard({ title, open, onToggle, action, children }) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={onToggle} className="flex-1 text-left">
          <h2 className="text-xl font-bold">{open ? "▾" : "▸"} {title}</h2>
        </button>
        {action}
      </div>
      {open && <div className="mt-4">{children}</div>}
    </Card>
  );
}

function NestedSection({ title, open, onToggle, children, className = "" }) {
  return (
    <div className={`rounded-2xl border border-slate-200 bg-slate-50 p-3 ${className}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-center justify-between text-left">
        <span className="text-sm font-bold text-slate-700">{open ? "▾" : "▸"} {title}</span>
      </button>
      {open && <div className="mt-3 space-y-3">{children}</div>}
    </div>
  );
}

function CheckRow({ checked, label, sub, onClick, strikeOnChecked = true }) {
  return (
    <button type="button" onClick={onClick}
      className={`flex w-full items-start gap-3 rounded-2xl border p-3 text-left ${checked ? "border-green-200 bg-green-50" : "border-slate-200 bg-white"}`}>
      {checked ? <CheckCircle2 className="mt-0.5" size={20} /> : <Circle className="mt-0.5" size={20} />}
      <span>
        <span className={checked && strikeOnChecked ? "text-slate-500 line-through" : ""}>{label}</span>
        {sub && <span className="block text-xs text-slate-500">{sub}</span>}
      </span>
    </button>
  );
}

function Tab({ id, active, setActive, icon: Icon, label }) {
  const isActive = active === id;
  return (
    <button type="button" onClick={() => setActive(id)}
      className={`flex flex-col items-center gap-1 rounded-2xl border p-3 text-sm font-semibold shadow-sm ${isActive ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white"}`}>
      <Icon size={18} />{label}
    </button>
  );
}

// Sync status badge — only shown when Supabase is configured
function SyncBadge({ status }) {
  if (!hasSupabase) return null;
  const map = {
    offline: ["📵 Offline — saved locally", "text-amber-600"],
    pending: ["↑ Syncing local changes...", "text-blue-500"],
    saving:  ["Saving...",                  "text-slate-400"],
    saved:   ["✓ Synced",                   "text-green-600"],
    error:   ["⚠ Sync error",              "text-red-500"],
  };
  const cfg = map[status];
  if (!cfg) return null;
  return <span className={`text-xs font-semibold ${cfg[1]}`}>{cfg[0]}</span>;
}

// -----------------------------------------------------------------------------
// Root component — handles auth and initial cloud load
// -----------------------------------------------------------------------------

const SYNC_TIMEOUT_MS = 8000;

function withTimeout(promise, label, ms = SYNC_TIMEOUT_MS) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

async function loadAndMergeUserState(userId) {
  const localState = sanitizeSeedData(loadSavedState());

  try {
    const { data, error } = await withTimeout(
      supabase
        .from("user_data")
        .select("data")
        .eq("id", userId)
        .maybeSingle(),
      "Initial cloud load"
    );

    if (error) throw error;

    const cloudData = data?.data || null;
    const merged = cloudData && localState
      ? mergeStates(localState, cloudData)
      : cloudData || localState || null;

    if (merged) {
      // Initial hydration is intentionally read-only against Supabase.
      // Never write during login/session restore, because an empty or stale
      // local snapshot can otherwise replace valid cloud data before the app
      // has finished hydrating. Normal user edits will push after hydration.
      saveState(merged);
    }

    return merged;
  } catch (error) {
    console.warn("Cloud load failed or timed out, using local data:", error);
    return localState;
  }
}

export default function App() {
  const [authReady, setAuthReady] = useState(false);
  const [dataReady, setDataReady] = useState(!hasSupabase);
  const [cloudHydrated, setCloudHydrated] = useState(!hasSupabase);
  const [user, setUser] = useState(null);
  const [initialData, setInitialData] = useState(null);
  const [passwordRecovery, setPasswordRecovery] = useState(false);

  const hydrateUser = useCallback(async (nextUser, { blockScreen = true } = {}) => {
    if (!hasSupabase || !nextUser) {
      setInitialData(sanitizeSeedData(loadSavedState()));
      setCloudHydrated(true);
      setDataReady(true);
      return;
    }

    setCloudHydrated(false);
    if (blockScreen) setDataReady(false);

    try {
      const merged = await loadAndMergeUserState(nextUser.id);
      setInitialData(sanitizeSeedData(merged) || sanitizeSeedData(loadSavedState()));
    } catch (error) {
      console.warn("Hydration failed, continuing with local data:", error);
      setInitialData(sanitizeSeedData(loadSavedState()));
    } finally {
      // Critical mobile fix: never leave the app permanently on Loading CampReady
      // if Supabase/auth stalls while the tab is backgrounded or waking up.
      setCloudHydrated(true);
      setDataReady(true);
    }
  }, []);

  useEffect(() => {
    if (!hasSupabase) {
      setCloudHydrated(true);
      setAuthReady(true);
      setDataReady(true);
      return;
    }

    let mounted = true;

    const boot = async () => {
      try {
        const { data: { session } } = await withTimeout(
          supabase.auth.getSession(),
          "Auth session load"
        );
        if (!mounted) return;

        setInitialData(sanitizeSeedData(loadSavedState()));
        setDataReady(true);

        if (session?.user) {
          setUser(session.user);
          setCloudHydrated(false);
          // Local-first: render immediately, then hydrate/sync in the background.
          hydrateUser(session.user, { blockScreen: false });
        } else {
          setCloudHydrated(true);
        }
      } catch (error) {
        console.warn("Auth boot failed or timed out, falling back to signed-out/local mode:", error);
        if (!mounted) return;
        setUser(null);
        setCloudHydrated(true);
        setInitialData(sanitizeSeedData(loadSavedState()));
        setDataReady(true);
      } finally {
        if (mounted) setAuthReady(true);
      }
    };

    boot();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!mounted) return;

      if (event === "SIGNED_OUT") {
        setUser(null);
        setCloudHydrated(true);
        setInitialData(null);
        setPasswordRecovery(false);
        setDataReady(true);
        return;
      }

      if (event === "PASSWORD_RECOVERY") {
        setUser(session?.user ?? null);
        setPasswordRecovery(true);
        setAuthReady(true);
        setDataReady(true);
        return;
      }

      if (event === "TOKEN_REFRESHED" && session?.user) {
        // Token refreshes are frequent on mobile wake/resume. Do not block the
        // whole UI for a cloud pull here; focus/realtime sync will catch changes.
        setUser(session.user);
        setAuthReady(true);
        setDataReady(true);
        return;
      }

      if ((event === "SIGNED_IN" || event === "USER_UPDATED") && session?.user) {
        setUser(session.user);
        setCloudHydrated(false);
        setInitialData(sanitizeSeedData(loadSavedState()));
        setDataReady(true);
        setAuthReady(true);
        hydrateUser(session.user, { blockScreen: false });
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [hydrateUser]);

  const handleSignOut = async () => {
    if (hasSupabase) await supabase.auth.signOut();
    clearSavedState();
    setPasswordRecovery(false);
  };

  const handleAuth = async (nextUser) => {
    setUser(nextUser);
    setCloudHydrated(false);
    setInitialData(sanitizeSeedData(loadSavedState()));
    setDataReady(true);
    setAuthReady(true);
    // Do not block login on cloud sync; sync runs in the background.
    hydrateUser(nextUser, { blockScreen: false });
  };

  if (!authReady) return <LoadingScreen />;

  if (hasSupabase && passwordRecovery && user) {
    return <ResetPasswordScreen onComplete={() => setPasswordRecovery(false)} onSignOut={handleSignOut} />;
  }

  if (hasSupabase && !user) return <AuthScreen onAuth={handleAuth} />;
  return <CampReadyApp user={user} initialData={initialData} cloudHydrated={cloudHydrated} onSignOut={handleSignOut} />;
}

function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100">
      <div className="text-center">
        <div className="mb-3 text-5xl">🏕️</div>
        <p className="font-medium text-slate-500">Loading CampReady…</p>
      </div>
    </div>
  );
}

// Shown after the user clicks a password-reset email link
function ResetPasswordScreen({ onComplete, onSignOut }) {
  const [password, setPassword]   = useState("");
  const [confirm, setConfirm]     = useState("");
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState("");
  const [success, setSuccess]     = useState(false);

  const handleReset = async () => {
    setError("");
    if (password.length < 6) { setError("Password must be at least 6 characters."); return; }
    if (password !== confirm)  { setError("Passwords don't match."); return; }
    setLoading(true);
    try {
      const { error: err } = await supabase.auth.updateUser({ password });
      if (err) throw err;
      setSuccess(true);
      setTimeout(() => onComplete(), 2000);
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mb-3 text-5xl">🏕️</div>
          <h1 className="text-3xl font-bold text-slate-900">CampReady</h1>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-5 text-xl font-bold">Set a new password</h2>
          {error   && <div className="mb-4 rounded-2xl border border-red-200   bg-red-50   px-4 py-3 text-sm text-red-700">{error}</div>}
          {success && <div className="mb-4 rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">Password updated! Taking you back to the app…</div>}
          {!success && (
            <>
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-500">New password</label>
                  <input type="password" autoComplete="new-password"
                    className="w-full rounded-2xl border px-4 py-3 text-sm outline-none focus:border-slate-400"
                    placeholder="At least 6 characters"
                    value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-500">Confirm new password</label>
                  <input type="password" autoComplete="new-password"
                    className="w-full rounded-2xl border px-4 py-3 text-sm outline-none focus:border-slate-400"
                    placeholder="Same password again"
                    value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                </div>
              </div>
              <button type="button" onClick={handleReset} disabled={loading}
                className="mt-5 w-full rounded-2xl bg-slate-900 px-4 py-3 font-semibold text-white disabled:opacity-60">
                {loading ? "Updating…" : "Set new password"}
              </button>
              <button type="button" onClick={onSignOut}
                className="mt-3 block w-full text-center text-sm font-semibold text-slate-400 hover:text-slate-600">
                Cancel — sign out
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Main app
// -----------------------------------------------------------------------------

function CampReadyApp({ user, initialData, cloudHydrated, onSignOut }) {
  // Keep raw sync metadata for merging, but strip it before initializing UI state.
  const rawInitialState = useMemo(() => sanitizeSeedData(initialData || loadSavedState()), [initialData]);
  const uiInitialState = useMemo(() => stripSyncMetadata(rawInitialState), [rawInitialState]);

  const getInitial = (key, fallback) => {
    if (uiInitialState?.[key] !== undefined) return uiInitialState[key];
    return fallback;
  };

  // Start as 'offline' if we're already offline when the component mounts
  const [syncStatus, setSyncStatus] = useState(() =>
    hasSupabase && typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "idle"
  );
  const syncTimerRef   = useRef(null);
  const isOnlineRef    = useRef(typeof navigator !== "undefined" ? navigator.onLine : true);
  const stateRef       = useRef(rawInitialState || null);   // raw sync state with metadata
  const pendingSyncRef = useRef(false);  // true when localStorage is ahead of cloud
  const suppressPushRef = useRef(false); // true when state just arrived from cloud — prevents push loop
  const clientIdRef = useRef(getClientId());
  const lastAppliedInitialRef = useRef(null); // tracks late cloud hydration after login/session restore

  const [activeTab, setActiveTab]           = useState("home");
  const [activeChecklist, setActiveChecklist] = useState("prep");
  const [trip, setTrip]                     = useState(() => clone(emptyTripState));
  const [trips, setTrips]                   = useState(() => getInitial("trips", []));
  const [activeTripId, setActiveTripId]     = useState(null);
  const [appTemplate, setAppTemplate]       = useState(() => mergeTemplateDefaults(getInitial("appTemplate", checklistTemplates)));
  const [tasks, setTasks]                   = useState({});
  const [family, setFamily]                 = useState([]);
  const [activeMember, setActiveMember]     = useState(null);
  const [recipes, setRecipes]               = useState([]);
  const [manualShoppingItems, setManualShoppingItems] = useState([]);
  const [shoppingStatuses, setShoppingStatuses] = useState([]);
  const [maintenanceItems, setMaintenanceItems] = useState(() => getInitial("maintenanceItems", []));
  const [rvConfig, setRvConfig]             = useState(() => getInitial("rvConfig", { rvType: "Travel Trailer", year: "", make: "", model: "", trim: "", vin: "", licensePlate: "", heightFt: "", heightIn: "", lengthFt: "", lengthIn: "", height: "", length: "", gvwr: "", emptyWeight: "", trailerAxleLimit: "", tireSize: "", tireLoadRating: "", tirePsi: "", tirePurchaseDate: "", batteryType: "", batteryPurchaseDate: "", roofType: "", propaneTankQty: "", propaneTankCapacity: "", freshTankQty: "", freshTankCapacity: "", grayTankQty: "", grayTankCapacity: "", blackTankQty: "", blackTankCapacity: "", notes: "" }));
  const [towVehicle, setTowVehicle]         = useState(() => getInitial("towVehicle", { year: "", make: "", model: "", trim: "", vin: "", licensePlate: "", lengthFt: "", lengthIn: "", length: "", engine: "", fuelCapacity: "", tireSize: "", tireLoadRating: "", tirePsi: "", tirePurchaseDate: "", batteryPurchaseDate: "", gvwr: "", gcwr: "", frontGawr: "", rearGawr: "", hitchRating: "", hitchTongueRating: "", measuredTongueWeight: "", tongueWeightPercent: "", loadedTrailerWeight: "", loadedTowVehicleWeight: "" }));
  const [rvNotes, setRvNotes]               = useState(() => getInitial("rvNotes", []));
  const [catScaleLogs, setCatScaleLogs]     = useState(() => getInitial("catScaleLogs", []));

  // Checklist sidebar nav
  const checklistNav = useMemo(() => [
    { key: "prep", label: "RV Prep" },
    { key: "inside", label: "Inside Prep" },
    { key: "towVehiclePrep", label: "Tow Vehicle Prep" },
    { key: "towVehiclePacking", label: "Tow Vehicle Packing" },
    { key: "departHome", label: "Depart Home" },
    ...trip.destinations.flatMap((dest) => [
      { key: `destination-${dest.id}`, label: dest.name || "Destination", header: true },
      { key: `${dest.id}-campSetup`, label: "Camp Setup", level: 1 },
      { key: `${dest.id}-leaveCamp`, label: "Leave Camp", level: 1 },
    ]),
    { key: "postTrip", label: "Post Trip" },
  ], [trip.destinations]);

  // Overall progress stat
  const stats = useMemo(() => {
    let done = 0, total = 0;
    Object.values(tasks || {}).forEach((section) =>
      Object.values(section || {}).forEach((group) =>
        (group || []).forEach((task) => {
          if (!task.na) {
            total += 1;
            if (task.done) done += 1;
          }
        })
      )
    );
    return { done, total, percent: pct(done, total) };
  }, [tasks]);

  const sortedMeals = useMemo(() => recipes.slice().sort((a, b) => {
    const ai = trip.destinations.findIndex((d) => d.id === a.destinationId);
    const bi = trip.destinations.findIndex((d) => d.id === b.destinationId);
    const rank = { Breakfast: 1, Lunch: 2, Dinner: 3, Dessert: 4, Snack: 5, Drinks: 6 };
    return (ai - bi) || ((Number(a.dayNumber ?? a.night) || 1) - (Number(b.dayNumber ?? b.night) || 1)) || ((rank[a.type] || 99) - (rank[b.type] || 99)) || a.name.localeCompare(b.name);
  }), [recipes, trip.destinations]);

  const shoppingList = useMemo(
    () => buildShoppingList(recipes, manualShoppingItems),
    [recipes, manualShoppingItems]
  );

  const shoppingStatusMap = useMemo(() => {
    const map = {};
    normalizeShoppingStatuses(shoppingStatuses).forEach((status) => {
      map[status.key] = status;
    });
    return map;
  }, [shoppingStatuses]);

  const toggleShoppingStatus = useCallback((key, field = "bought") => {
    setShoppingStatuses((prev) => {
      const normalized = normalizeShoppingStatuses(prev);
      const exists = normalized.find((item) => item.key === key);
      if (exists) {
        return normalized.map((item) => {
          if (item.key !== key) return item;
          const nextValue = !Boolean(item[field]);
          const next = { ...item, [field]: nextValue };
          next.checked = Boolean(next.bought && next.packed);
          return next;
        });
      }
      const next = { id: key, key, bought: false, packed: false, checked: false, [field]: true };
      next.checked = Boolean(next.bought && next.packed);
      return [...normalized, next];
    });
  }, []);

  const makeActiveTripRecord = useCallback((record = {}) => ({
    ...record,
    id: activeTripId || record.id,
    name: trip?.name || record.name || "",
    departureDate: trip?.departureDate || record.departureDate || "",
    destinations: clone(trip?.destinations || record.destinations || []),
    tasks: clone(tasks || record.tasks || {}),
    family: normalizeFamilyForSync(family || record.family || []),
    recipes: normalizeRecipesForSync(recipes || record.recipes || []),
    manualShoppingItems: clone(manualShoppingItems || record.manualShoppingItems || []),
    shoppingStatuses: normalizeShoppingStatuses(shoppingStatuses || record.shoppingStatuses || []),
  }), [activeTripId, trip, tasks, family, recipes, manualShoppingItems, shoppingStatuses]);

  const loadTripRecordIntoUi = useCallback((record) => {
    if (!record) return;
    const opened = {
      ...clone(record),
      name: record.name || "",
      departureDate: record.departureDate || "",
      destinations: clone(record.destinations || []),
    };
    delete opened.status;
    delete opened.createdAt;
    delete opened.trashedAt;
    delete opened.deletedAt;

    setTrip(opened);
    setTasks(record.tasks ? clone(record.tasks) : buildTasks(appTemplate, opened.destinations));
    const normalizedFamily = normalizeFamilyForSync(record.family || []);
    setFamily(clone(normalizedFamily));
    setActiveMember(normalizedFamily?.[0]?.id || null);
    setRecipes(normalizeRecipesForSync(record.recipes || []));
    setManualShoppingItems(clone(record.manualShoppingItems || []));
    setShoppingStatuses(normalizeShoppingStatuses(record.shoppingStatuses || record.shoppingChecks || []));
  }, [appTemplate]);

  // Keep the active trip card in sync with edits made inside the trip header.
  // Without this, going Home -> Open Trip can reload the older trip snapshot from
  // the Trips list and appear to "lose" recently entered details.
  useEffect(() => {
    if (!activeTripId || !trip) return;
    setTrips((prev) => {
      let changed = false;
      const next = prev.map((record) => {
        if (record.id !== activeTripId) return record;
        const updated = makeActiveTripRecord(record);
        if (JSON.stringify(record) !== JSON.stringify(updated)) changed = true;
        return updated;
      });
      return changed ? next : prev;
    });
  }, [activeTripId, trip, tasks, family, recipes, manualShoppingItems, shoppingStatuses, makeActiveTripRecord]);

  // ── Online / offline detection ─────────────────────────────────────────────
  // When the device comes back online, push any changes made while offline.

  // Applies a fully-merged state object to all component state setters.
  // Called after a reconnect merge so the UI immediately reflects remote changes.
  const applyMergedState = useCallback((merged, options = {}) => {
    // Save raw sync metadata for future merges, but never let another device's
    // currently-open trip selection hijack this device's screen.
    suppressPushRef.current = true;
    saveState(merged);
    stateRef.current = merged;
    const ui = stripSyncMetadata(merged) || {};

    if (ui.appTemplate !== undefined) setAppTemplate(mergeTemplateDefaults(ui.appTemplate));
    if (ui.trips !== undefined) setTrips(ui.trips);
    if (ui.maintenanceItems !== undefined) setMaintenanceItems(ui.maintenanceItems);
    if (ui.rvConfig !== undefined) setRvConfig(ui.rvConfig);
    if (ui.towVehicle !== undefined) setTowVehicle(ui.towVehicle);
    if (ui.rvNotes !== undefined) setRvNotes(ui.rvNotes);
    if (ui.catScaleLogs !== undefined) setCatScaleLogs(ui.catScaleLogs);

    // Only refresh the open trip UI when explicitly requested. Automatic realtime
    // merges update the Trips records but do not overwrite fields the user may be
    // actively typing into on this device.
    if (options.forceActiveTrip && activeTripId && Array.isArray(ui.trips)) {
      const activeRecord = ui.trips.find((record) => record.id === activeTripId);
      if (activeRecord) loadTripRecordIntoUi(activeRecord);
    }
  }, [activeTripId, loadTripRecordIntoUi]);

  // Auth can render the app from local/default state before the cloud pull finishes.
  // When the late cloud hydration arrives, explicitly apply it to the already-mounted app.
  // Without this, sign out -> sign in can show empty/default state; the next local edit can
  // then push that empty state back to Supabase.
  useEffect(() => {
    if (!rawInitialState || !hasRealUserData(rawInitialState)) return;

    const signature = `${rawInitialState.lastModified || 0}-${rawInitialState?.__sync?.updatedAt || 0}`;
    if (lastAppliedInitialRef.current === signature) return;
    lastAppliedInitialRef.current = signature;

    const current = stateRef.current;
    const merged = current && hasRealUserData(current)
      ? mergeStates(current, rawInitialState)
      : rawInitialState;

    if (JSON.stringify(merged) !== JSON.stringify(current)) {
      applyMergedState(merged);
    }
  }, [rawInitialState, applyMergedState]);

  useEffect(() => {
    const handleOnline = async () => {
      isOnlineRef.current = true;
      if (pendingSyncRef.current && stateRef.current && hasSupabase && user) {
        setSyncStatus("pending");
        try {
          // Fetch whatever cloud state exists right now — another device may have
          // made changes while we were both offline, so we must merge rather than
          // blindly overwrite.
          const { data } = await withTimeout(
            supabase
              .from("user_data")
              .select("data")
              .eq("id", user.id)
              .single(),
            "Reconnect cloud pull"
          );

          const cloudData = data?.data;
          const finalState = cloudData
            ? mergeStates(stateRef.current, cloudData)
            : stateRef.current;

          // Apply merged state to the running UI so the user sees remote additions
          // (e.g. checklist items their spouse added) immediately.
          applyMergedState(finalState);

          // Push the merged result to cloud so all devices converge.
          const { error } = await withTimeout(
            supabase
              .from("user_data")
              .upsert({ id: user.id, data: finalState }, { onConflict: "id" }),
            "Reconnect cloud push"
          );
          if (error) throw error;

          pendingSyncRef.current = false;
          setSyncStatus("saved");
          setTimeout(() => setSyncStatus("idle"), 2500);
        } catch (e) {
          console.error("Reconnect sync failed:", e);
          setSyncStatus("error");
        }
      } else {
        setSyncStatus("idle");
      }
    };

    const handleOffline = () => {
      isOnlineRef.current = false;
      setSyncStatus("offline");
    };

    window.addEventListener("online",  handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online",  handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [user, applyMergedState]);

  // ── Real-time sync ────────────────────────────────────────────────────────
  // Listen for changes pushed by other devices via Supabase Realtime.
  // Requires: ALTER TABLE public.user_data REPLICA IDENTITY FULL;
  // and Realtime enabled for the table in the Supabase dashboard.
  useEffect(() => {
    if (!hasSupabase || !user) return;

    const channel = supabase
      .channel(`user-data-${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "user_data", filter: `id=eq.${user.id}` },
        (payload) => {
          const cloudData = payload.new?.data;
          if (!cloudData || !stateRef.current) return;

          const cloudTime = cloudData.lastModified || 0;
          const localTime = stateRef.current.lastModified || 0;

          // Skip if timestamps are identical — this is almost certainly our own
          // push bouncing back from Supabase. No need to merge with ourselves.
          if (cloudTime === localTime) return;

          // Always merge regardless of which timestamp is newer.
          // Bug fix: the old `cloudTime > localTime` guard was blocking ALL updates
          // from device A when device B had been active more recently — even when
          // device A had NEW items (maintenance entries, trips, etc.) that device B
          // had never seen. The merge function handles conflicts correctly on its own.
          const merged = mergeStates(stateRef.current, cloudData);

          // Only apply if the merge actually produces a different result.
          // This avoids unnecessary re-renders when there's nothing new.
          if (JSON.stringify(merged) === JSON.stringify(stateRef.current)) return;

          applyMergedState(merged);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user, applyMergedState]);

  const refreshFromCloud = useCallback(async ({ forceActiveTrip = true } = {}) => {
    if (!hasSupabase || !user || !isOnlineRef.current) return;
    setSyncStatus("pending");
    try {
      const { data } = await withTimeout(
        supabase
          .from("user_data")
          .select("data")
          .eq("id", user.id)
          .single(),
        "Manual cloud refresh"
      );

      const cloudData = data?.data;
      if (!cloudData) {
        setSyncStatus("idle");
        return;
      }

      const merged = stateRef.current ? mergeStates(stateRef.current, cloudData) : cloudData;
      applyMergedState(merged, { forceActiveTrip });
      setSyncStatus("saved");
      setTimeout(() => setSyncStatus("idle"), 2000);
    } catch (error) {
      console.error("Manual refresh failed:", error);
      setSyncStatus("error");
    }
  }, [user, applyMergedState]);

  // ── Window focus sync ─────────────────────────────────────────────────────
  // When the user switches back to this tab/window, do a lightweight pull
  // to catch any changes from other devices. Fallback for when real-time
  // isn't set up or misses an event.
  useEffect(() => {
    if (!hasSupabase || !user) return;

    const handleFocus = async () => {
      if (!isOnlineRef.current || !stateRef.current) return;
      try {
        const { data } = await withTimeout(
          supabase
            .from("user_data")
            .select("data")
            .eq("id", user.id)
            .single(),
          "Focus cloud pull"
        );

        const cloudData = data?.data;
        if (!cloudData) return;

        const cloudTime = cloudData.lastModified || 0;
        const localTime = stateRef.current.lastModified || 0;

        // Skip if timestamps match — nothing has changed
        if (cloudTime === localTime) return;

        // Always merge. The old cloudTime > localTime guard had the same problem
        // as the real-time listener: it would miss new items on cloud when local
        // was more recently active.
        const merged = mergeStates(stateRef.current, cloudData);
        if (JSON.stringify(merged) !== JSON.stringify(stateRef.current)) {
          applyMergedState(merged);
        }
      } catch {
        // Silently fail — focus sync is best-effort
      }
    };

    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [user, applyMergedState]);
  const pushToSupabase = useCallback(async (stateObj) => {
    if (!hasSupabase || !user) return;
    setSyncStatus("saving");

    try {
      // Match the Family Food Hub pattern: every push first pulls the current
      // cloud snapshot, merges, then writes the converged snapshot back. This
      // prevents a stale tab from overwriting changes made on another device
      // when realtime/focus events were missed.
      const { data, error: readError } = await withTimeout(
        supabase
          .from("user_data")
          .select("data")
          .eq("id", user.id)
          .maybeSingle(),
        "Sync cloud pull"
      );

      if (readError) throw readError;

      const cloudData = data?.data || null;
      const finalState = cloudData ? mergeStates(stateObj, cloudData) : stateObj;

      const { error } = await withTimeout(
        supabase
          .from("user_data")
          .upsert({ id: user.id, data: finalState }, { onConflict: "id" }),
        "Sync cloud push"
      );
      if (error) throw error;

      if (JSON.stringify(finalState) !== JSON.stringify(stateObj)) {
        applyMergedState(finalState);
      } else {
        saveState(finalState);
        stateRef.current = finalState;
      }

      setSyncStatus("saved");
      setTimeout(() => setSyncStatus("idle"), 2500);
    } catch (e) {
      console.error("Sync error:", e);
      pendingSyncRef.current = true;
      setSyncStatus("error");
    }
  }, [user, applyMergedState]);

  const getCurrentUiState = useCallback(() => ({
    trips,
    appTemplate,
    maintenanceItems,
    rvConfig,
    towVehicle,
    rvNotes,
    catScaleLogs,
  }), [trips, appTemplate, maintenanceItems, rvConfig, towVehicle, rvNotes, catScaleLogs]);

  const exportBackup = useCallback(() => {
    const backup = {
      app: "CampReady",
      backupVersion: 1,
      exportedAt: new Date().toISOString(),
      userEmail: user?.email || null,
      state: getCurrentUiState(),
    };

    const dateStamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `campready-backup-${dateStamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [getCurrentUiState, user]);

  const importBackup = useCallback(async (file) => {
    if (!file) return;

    const text = await file.text();
    const parsed = JSON.parse(text);
    const importedState = parsed?.state || parsed;

    if (!importedState || typeof importedState !== "object") {
      throw new Error("Backup file did not contain valid CampReady data.");
    }

    const confirmed = window.confirm(
      "Import this backup? This will replace the current local CampReady data on this device and then sync the imported data when online."
    );
    if (!confirmed) return;

    const migratedImportedState = migrateImportedBackupState(importedState);

    if (!migratedImportedState || !hasRealUserData(migratedImportedState)) {
      throw new Error("Backup file did not contain importable CampReady data.");
    }

    // Import is an intentional restore/replace operation, so prepare it as a fresh
    // local authoritative state rather than merging it into older local defaults.
    const prepared = prepareStateForSave(null, migratedImportedState, clientIdRef.current, Date.now());

    applyMergedState(prepared, { forceActiveTrip: true });
    pendingSyncRef.current = true;

    if (isOnlineRef.current && hasSupabase && user) {
      setSyncStatus("pending");
      await pushToSupabase(prepared);
      pendingSyncRef.current = false;
    } else {
      setSyncStatus("offline");
    }
  }, [applyMergedState, pushToSupabase, user]);

  // Save to localStorage on every change (immediate, always).
  // Only attempt Supabase write when online; set pendingSync flag when offline
  // so the reconnect handler knows to push when signal returns.
  useEffect(() => {
    // This update came from the cloud — don't push it right back (loop prevention)
    // and don't overwrite the merged metadata we already saved in applyMergedState.
    if (suppressPushRef.current) {
      suppressPushRef.current = false;
      return;
    }

    const rawState = {
      trips,
      appTemplate,
      maintenanceItems,
      rvConfig,
      towVehicle,
      rvNotes,
      catScaleLogs,
    };
    if (!hasRealUserData(rawState) && !hasRealUserData(stateRef.current)) {
      return;
    }

    const stateObj = prepareStateForSave(stateRef.current, rawState, clientIdRef.current);

    saveState(stateObj);       // always write locally, even offline
    stateRef.current = stateObj;

    if (hasSupabase && user && !cloudHydrated) {
      // Critical data-loss guard: do not push anything created during login
      // until the initial cloud record has been read and applied/merged.
      pendingSyncRef.current = true;
      setSyncStatus("pending");
      return;
    }

    if (!isOnlineRef.current) {
      pendingSyncRef.current = true;
      setSyncStatus("offline");
      return;
    }

    if (hasSupabase && user) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = setTimeout(async () => {
        await pushToSupabase(stateObj);
        pendingSyncRef.current = false;
      }, 900);
    }
  }, [trips, appTemplate, maintenanceItems, rvConfig, towVehicle, rvNotes, catScaleLogs, pushToSupabase, user, cloudHydrated]);

  // Clean up timer on unmount
  useEffect(() => () => clearTimeout(syncTimerRef.current), []);

  // ── Trip management ────────────────────────────────────────────────────────
  const saveTripRecord = (newTrip) => {
    const record = {
      ...clone(newTrip),
      id: newTrip.id || uid("trip"),
      name: newTrip.name,
      destinations: clone(newTrip.destinations || []),
      tasks: clone(newTrip.tasks || {}),
      family: normalizeFamilyForSync(newTrip.family || []),
      recipes: normalizeRecipesForSync(newTrip.recipes || []),
      manualShoppingItems: clone(newTrip.manualShoppingItems || []),
      shoppingStatuses: normalizeShoppingStatuses(newTrip.shoppingStatuses || []),
      status: "Current",
      createdAt: new Date().toLocaleDateString(),
    };
    setTrips((prev) => [record, ...prev.map((t) => ({ ...t, status: t.status === "Current" ? "Past" : t.status }))]);
    setActiveTripId(record.id);
  };

  const startTrip = () => {
    const destination = { id: uid("dest"), name: "Destination TBD", nights: 3 };
    const newTripTasks = buildTasks(appTemplate, [destination]);
    const newTrip = {
      id: uid("trip"),
      name: "New Camping Trip",
      departureDate: "",
      destinations: [destination],
      tasks: newTripTasks,
      family: [],
      recipes: [],
      manualShoppingItems: [],
      shoppingStatuses: [],
    };
    saveTripRecord(newTrip);
    setTrip(newTrip);
    setTasks(newTripTasks);
    setFamily([]);
    setActiveMember(null);
    setRecipes([]);
    setManualShoppingItems([]);
    setShoppingStatuses([]);
    setActiveChecklist("prep");
    setActiveTab("trip");
  };

  const openTrip = (record) => {
    setActiveTripId(record.id);
    loadTripRecordIntoUi(record);
    setActiveChecklist("prep");
    setActiveTab("trip");
  };

  const duplicateTrip = (id) => {
    const source = trips.find((t) => t.id === id);
    if (!source) return;
    const copy = clone(source);
    const newTrip = {
      ...copy,
      id: uid("trip"),
      name: `Copy of ${source.name || "Trip"}`,
      status: "Current",
      createdAt: new Date().toLocaleDateString(),
      archivedAt: undefined,
      trashedAt: undefined,
      deletedAt: undefined,
    };
    setTrips((prev) => [newTrip, ...prev.map((t) => ({ ...t, status: t.status === "Current" ? "Past" : t.status }))]);
    setActiveTripId(newTrip.id);
    loadTripRecordIntoUi(newTrip);
    setActiveChecklist("prep");
    setActiveTab("trip");
  };

  const archiveTrip = (id) => {
    const tripToArchive = trips.find((t) => t.id === id);
    const tripName = tripToArchive?.name || "this trip";
    const confirmed = window.confirm(`Archive "${tripName}"? You can restore it from the archived trips section.`);
    if (!confirmed) return;
    const archivedAt = new Date().toISOString();
    setTrips((prev) => prev.map((t) => (
      t.id === id ? { ...t, status: "Archived", archivedAt, trashedAt: undefined, deletedAt: undefined } : t
    )));
    if (activeTripId === id) setActiveTab("home");
  };

  const restoreArchivedTrip = (id) => {
    setTrips((prev) => prev.map((t) => (
      t.id === id ? { ...t, status: "Past", archivedAt: undefined } : t
    )));
  };

  const trashTrip = (id) => {
    const tripToTrash = trips.find((t) => t.id === id);
    const tripName = tripToTrash?.name || "this trip";
    const confirmed = window.confirm(`Move "${tripName}" to the trash? You can restore it from the Trips trash bin.`);
    if (!confirmed) return;

    const trashedAt = new Date().toISOString();
    setTrips((prev) => prev.map((t) => (
      t.id === id
        ? { ...t, status: "Trash", trashedAt, deletedAt: undefined }
        : t
    )));

    if (activeTripId === id) {
      setActiveTab("home");
    }
  };

  const restoreTrip = (id) => {
    setTrips((prev) => prev.map((t) => (
      t.id === id
        ? { ...t, status: "Past", trashedAt: undefined, deletedAt: undefined }
        : t
    )));
  };

  const permanentlyDeleteTrip = (id) => {
    const tripToDelete = trips.find((t) => t.id === id);
    const tripName = tripToDelete?.name || "this trip";
    const confirmed = window.confirm(`Permanently delete "${tripName}"? This cannot be restored from the trash.`);
    if (!confirmed) return;

    const deletedAt = new Date().toISOString();
    setTrips((prev) => prev.map((t) => (
      t.id === id
        ? { ...t, status: "Deleted", trashedAt: t.trashedAt || deletedAt, deletedAt }
        : t
    )));
  };

  const resetCheckboxesOnly = () => {
    setTasks((prev) => {
      const next = clone(prev);
      Object.values(next).forEach((section) =>
        Object.values(section).forEach((group) =>
          group.forEach((task) => { task.done = false; task.na = false; })
        )
      );
      return next;
    });
    setFamily((prev) => prev.map((m) => ({ ...m, items: m.items.map((i) => ({ ...i, packed: false })) })));
    setShoppingStatuses([]);
  };

  const resetAppData = () => {
    clearSavedState();
    setActiveChecklist("prep");
    setTrip(clone(emptyTripState));
    setTrips([]);
    setActiveTripId(null);
    setAppTemplate(checklistTemplates);
    setTasks({});
    setFamily([]);
    setActiveMember(null);
    setRecipes([]);
    setManualShoppingItems([]);
    setShoppingStatuses([]);
    setMaintenanceItems([]);
    setRvConfig({ rvType: "Travel Trailer", year: "", make: "", model: "", trim: "", vin: "", licensePlate: "", heightFt: "", heightIn: "", lengthFt: "", lengthIn: "", height: "", length: "", gvwr: "", emptyWeight: "", trailerAxleLimit: "", tireSize: "", tireLoadRating: "", tirePsi: "", tirePurchaseDate: "", batteryType: "", batteryPurchaseDate: "", roofType: "", propaneTankQty: "", propaneTankCapacity: "", freshTankQty: "", freshTankCapacity: "", grayTankQty: "", grayTankCapacity: "", blackTankQty: "", blackTankCapacity: "", notes: "" });
    setTowVehicle({ year: "", make: "", model: "", trim: "", vin: "", licensePlate: "", lengthFt: "", lengthIn: "", length: "", engine: "", fuelCapacity: "", tireSize: "", tireLoadRating: "", tirePsi: "", tirePurchaseDate: "", batteryPurchaseDate: "", gvwr: "", gcwr: "", frontGawr: "", rearGawr: "", hitchRating: "", hitchTongueRating: "", measuredTongueWeight: "", tongueWeightPercent: "", loadedTrailerWeight: "", loadedTowVehicleWeight: "" });
    setRvNotes([]);
    setCatScaleLogs([]);
    setActiveTab("home");
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-100 p-4 text-slate-900">
      <div className="mx-auto max-w-6xl space-y-4">

        {activeTab === "home" ? (
          <HomeHeader syncStatus={syncStatus} user={user} onSignOut={onSignOut} onRefresh={refreshFromCloud} />
        ) : activeTab === "maintenance" ? (
          <MaintenanceHeader setActiveTab={setActiveTab} syncStatus={syncStatus} user={user} onSignOut={onSignOut} onRefresh={refreshFromCloud} />
        ) : activeTab === "template" ? null : (
          <TripHeader trip={trip} setTrip={setTrip} setTasks={setTasks} appTemplate={appTemplate} stats={stats} setActiveTab={setActiveTab} syncStatus={syncStatus} onRefresh={refreshFromCloud} />
        )}

        {activeTab !== "home" && activeTab !== "template" && activeTab !== "maintenance" && (
          <nav className="grid grid-cols-5 gap-2">
            <Tab id="trip"       active={activeTab} setActive={setActiveTab} icon={LayoutDashboard} label="Dashboard" />
            <Tab id="checklists" active={activeTab} setActive={setActiveTab} icon={ClipboardCheck}  label="Lists"      />
            <Tab id="packing"    active={activeTab} setActive={setActiveTab} icon={Users}           label="Packing"    />
            <Tab id="food"       active={activeTab} setActive={setActiveTab} icon={Utensils}        label="Food"       />
            <Tab id="settings"   active={activeTab} setActive={setActiveTab} icon={Settings}        label="Settings"   />
          </nav>
        )}

        {activeTab === "home"       && <HomePage trips={trips} activeTripId={activeTripId} startTrip={startTrip} openTrip={openTrip} duplicateTrip={duplicateTrip} archiveTrip={archiveTrip} restoreArchivedTrip={restoreArchivedTrip} trashTrip={trashTrip} restoreTrip={restoreTrip} permanentlyDeleteTrip={permanentlyDeleteTrip} openTemplate={() => setActiveTab("template")} openMaintenance={() => setActiveTab("maintenance")} onRefresh={refreshFromCloud} />}
        {activeTab === "template"   && <TemplateEditor appTemplate={appTemplate} setAppTemplate={setAppTemplate} goHome={() => setActiveTab("home")} />}
        {activeTab === "trip"       && <TripDashboard tasks={tasks} family={family} shoppingList={shoppingList} shoppingChecks={shoppingStatusMap} setActiveTab={setActiveTab} setActiveChecklist={setActiveChecklist} navItems={checklistNav} />}
        {activeTab === "checklists" && <ChecklistView tasks={tasks} setTasks={setTasks} activeChecklist={activeChecklist} setActiveChecklist={setActiveChecklist} navItems={checklistNav} />}
        {activeTab === "packing"    && <PackingView family={family} setFamily={setFamily} activeMember={activeMember} setActiveMember={setActiveMember} />}
        {activeTab === "food"       && <FoodView trip={trip} destinations={trip.destinations} recipes={sortedMeals} setRecipes={setRecipes} shoppingList={shoppingList} shoppingChecks={shoppingStatusMap} toggleShoppingStatus={toggleShoppingStatus} manualShoppingItems={manualShoppingItems} setManualShoppingItems={setManualShoppingItems} />}
        {activeTab === "maintenance" && <MaintenanceView maintenanceItems={maintenanceItems} setMaintenanceItems={setMaintenanceItems} rvConfig={rvConfig} setRvConfig={setRvConfig} towVehicle={towVehicle} setTowVehicle={setTowVehicle} rvNotes={rvNotes} setRvNotes={setRvNotes} catScaleLogs={catScaleLogs} setCatScaleLogs={setCatScaleLogs} />}
        {activeTab === "settings"   && <SettingsView family={family} setFamily={setFamily} resetCheckboxesOnly={resetCheckboxesOnly} rebuildTrip={() => { setTasks(buildTasks(appTemplate, trip.destinations)); resetCheckboxesOnly(); }} resetAppData={resetAppData} exportBackup={exportBackup} importBackup={importBackup} user={user} onSignOut={onSignOut} />}

      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Home / headers
// -----------------------------------------------------------------------------

function HomeHeader({ syncStatus, user, onSignOut, onRefresh }) {
  return (
    <header className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-slate-500">CampReady</div>
        <div className="flex items-center gap-3">
          <SyncBadge status={syncStatus} />
          {onRefresh && (
            <button type="button" onClick={() => onRefresh()} className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
              Refresh
            </button>
          )}
          {user && (
            <div className="flex items-center gap-2">
              <span className="hidden text-xs text-slate-400 sm:block">{user.email}</span>
              <button
                type="button"
                onClick={onSignOut}
                className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
      <h1 className="mt-1 text-2xl font-bold md:text-3xl">RV Camping Trip Planner</h1>
      <p className="mt-2 text-sm text-slate-600">Start a trip, manage templates, maintain your RV, and prep for camping.</p>
    </header>
  );
}

function MaintenanceHeader({ setActiveTab, syncStatus, user, onSignOut, onRefresh }) {
  return (
    <header className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={() => setActiveTab("home")} className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold hover:bg-slate-100">← Back to Home</button>
        <div className="flex items-center gap-3">
          <SyncBadge status={syncStatus} />
          {onRefresh && (
            <button type="button" onClick={() => onRefresh()} className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
              Refresh
            </button>
          )}
          {user && (
            <button type="button" onClick={onSignOut} className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
              Sign out
            </button>
          )}
        </div>
      </div>
      <div className="mt-4 text-sm font-medium text-slate-500">CampReady</div>
      <h1 className="mt-1 text-2xl font-bold md:text-3xl">RV Maintenance Tracker</h1>
      <p className="mt-2 text-sm text-slate-600">Configuration, component notes, towing specs, and maintenance timeline.</p>
    </header>
  );
}

function HomePage({ trips, activeTripId, startTrip, openTrip, duplicateTrip, archiveTrip, restoreArchivedTrip, trashTrip, restoreTrip, permanentlyDeleteTrip, openTemplate, openMaintenance, onRefresh }) {
  const activeTrips = (trips || []).filter((t) => t.status !== "Trash" && t.status !== "Deleted" && t.status !== "Archived");
  const archivedTrips = (trips || []).filter((t) => t.status === "Archived");
  const trashedTrips = (trips || []).filter((t) => t.status === "Trash");

  return (
    <div className="space-y-4">
      <Card>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold">Trips</h2>
            <p className="text-sm text-slate-600">Current and previous camping trips.</p>
          </div>
          <div className="flex shrink-0 gap-2">
            {onRefresh && <button type="button" onClick={() => onRefresh({ forceActiveTrip: false })} className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">Refresh</button>}
            <button type="button" onClick={startTrip} className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white">+ New Trip</button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {activeTrips.map((t) => (
            <div key={t.id} className={`rounded-3xl border p-4 ${t.id === activeTripId ? "border-slate-900 bg-slate-50" : "border-slate-200 bg-white"}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-slate-500">{t.status} • Created {t.createdAt}</div>
                  <h3 className="text-lg font-bold">{t.name}</h3>
                  <p className="text-sm text-slate-600">{(t.destinations || []).map((d) => d.name).join(" → ")}</p>
                </div>
                <button
                  type="button"
                  onClick={() => trashTrip(t.id)}
                  className="rounded-xl border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-100"
                  title="Move trip to trash"
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-3">
                <button type="button" onClick={() => openTrip(t)} className="rounded-2xl bg-slate-900 px-4 py-2 font-semibold text-white">Open</button>
                <button type="button" onClick={() => duplicateTrip?.(t.id)} className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Duplicate</button>
                <button type="button" onClick={() => archiveTrip?.(t.id)} className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Archive</button>
              </div>
            </div>
          ))}
        </div>

        {activeTrips.length === 0 && (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">
            No active trips. Create a new trip or restore one from the trash.
          </div>
        )}

        {archivedTrips.length > 0 && (
          <details className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <summary className="cursor-pointer text-sm font-bold text-slate-700">Archived Trips ({archivedTrips.length})</summary>
            <div className="mt-3 space-y-2">
              {archivedTrips.map((t) => (
                <div key={t.id} className="rounded-2xl border border-slate-200 bg-white p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-sm font-bold">{t.name}</div>
                      <div className="text-xs text-slate-500">Archived {t.archivedAt ? new Date(t.archivedAt).toLocaleString() : "recently"}</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => openTrip(t)} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50">Open</button>
                      <button type="button" onClick={() => restoreArchivedTrip?.(t.id)} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50">Restore</button>
                      <button type="button" onClick={() => duplicateTrip?.(t.id)} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50">Duplicate</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}

        {trashedTrips.length > 0 && (
          <details className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <summary className="cursor-pointer text-sm font-bold text-slate-700">Trash Bin ({trashedTrips.length})</summary>
            <div className="mt-3 space-y-2">
              {trashedTrips.map((t) => (
                <div key={t.id} className="rounded-2xl border border-slate-200 bg-white p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-sm font-bold">{t.name}</div>
                      <div className="text-xs text-slate-500">Moved to trash {t.trashedAt ? new Date(t.trashedAt).toLocaleString() : "recently"}</div>
                    </div>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => restoreTrip(t.id)} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50">Restore</button>
                      <button type="button" onClick={() => permanentlyDeleteTrip(t.id)} className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-100">Delete Forever</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="mt-4 flex justify-end">
          <button type="button" onClick={openTemplate} className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">Edit RV Template</button>
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <h2 className="mb-2 text-xl font-bold">RV maintenance</h2>
          <p className="mb-4 text-sm text-slate-600">Track recurring service and ownership details.</p>
          <button type="button" onClick={openMaintenance} className="flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-300 bg-white px-4 py-3 font-semibold hover:bg-slate-50"><Truck size={18} />Open maintenance</button>
        </Card>
      </div>
    </div>
  );
}

function TripHeader({ trip, setTrip, setTasks, appTemplate, stats, setActiveTab, syncStatus, onRefresh }) {
  const dateRanges = useMemo(
    () => buildDestinationDateRanges(trip.departureDate, trip.destinations),
    [trip.departureDate, trip.destinations]
  );

  const updateDestination = (id, updates) => {
    setTrip((prev) => ({
      ...prev,
      destinations: prev.destinations.map((d) => {
        if (d.id !== id) return d;

        // Allow the nights input to be temporarily blank while the user edits it.
        // We normalize blank/invalid values to 1 anywhere calculations need a number.
        if (Object.prototype.hasOwnProperty.call(updates, "nights")) {
          const nextNights = updates.nights === "" ? "" : Math.max(1, Number(updates.nights) || 1);
          return { ...d, ...updates, nights: nextNights };
        }

        return { ...d, ...updates };
      }),
    }));
  };

  const addDestination = () => {
    const destination = { id: uid("dest"), name: "Destination TBD", nights: 1 };

    setTrip((prev) => ({
      ...prev,
      destinations: [...prev.destinations, destination],
    }));

    setTasks?.((prev) => ({
      ...prev,
      [`${destination.id}-campSetup`]: buildSection(appTemplate, "campSetup", `${destination.id}-campSetup`),
      [`${destination.id}-leaveCamp`]: buildSection(appTemplate, "leaveCamp", `${destination.id}-leaveCamp`),
    }));
  };

  const removeDestination = (id) => {
    setTrip((prev) => {
      if (prev.destinations.length === 1) return prev;
      return { ...prev, destinations: prev.destinations.filter((d) => d.id !== id) };
    });

    setTasks?.((prev) => {
      const next = { ...(prev || {}) };
      delete next[`${id}-campSetup`];
      delete next[`${id}-leaveCamp`];
      return next;
    });
  };

  const moveDestination = (id, direction) => {
    setTrip((prev) => {
      const fromIndex = prev.destinations.findIndex((d) => d.id === id);
      if (fromIndex < 0) return prev;

      const toIndex = fromIndex + direction;
      if (toIndex < 0 || toIndex >= prev.destinations.length) return prev;

      const destinations = [...prev.destinations];
      const [moved] = destinations.splice(fromIndex, 1);
      destinations.splice(toIndex, 0, moved);

      // Preserve destination ids so meals, stop-specific checklists, and other
      // trip-linked data stay attached to the correct stop after reordering.
      return { ...prev, destinations };
    });
  };

  return (
    <header className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setActiveTab("home")}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold hover:bg-slate-100"
        >
          ← Back to Home
        </button>
        <div className="flex items-center gap-3">
          <SyncBadge status={syncStatus} />
          {onRefresh && (
            <button
              type="button"
              onClick={() => onRefresh()}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              Refresh
            </button>
          )}
          <div className="text-xs font-semibold text-slate-500">Active Trip</div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[1fr_220px]">
        <div>
          <input
            className="w-full bg-transparent text-2xl font-bold outline-none md:text-3xl"
            value={trip.name}
            onChange={(e) => setTrip({ ...trip, name: e.target.value })}
          />

          <div className="mt-3 max-w-xs">
            <label className="block text-xs font-semibold text-slate-500">
              Departure Date
              <input
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm font-normal text-slate-900"
                type="date"
                value={trip.departureDate || ""}
                onChange={(e) => setTrip({ ...trip, departureDate: e.target.value })}
              />
            </label>
          </div>

          <div className="mt-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-semibold text-slate-500">Destinations / Stops</div>
              <button
                type="button"
                onClick={addDestination}
                className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                + Add Stop
              </button>
            </div>

            {trip.destinations.map((dest, index) => (
              <div key={dest.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-2">
                {dateRanges[index] && (
                  <div className="mb-1 px-1 text-xs font-semibold text-slate-500">
                    {dateRanges[index]}
                  </div>
                )}

                <div className="grid grid-cols-[minmax(0,1fr)_72px_auto] items-center gap-2">
                  <input
                    className="min-w-0 rounded-xl border bg-white px-3 py-2 text-sm"
                    value={dest.name}
                    onChange={(e) => updateDestination(dest.id, { name: e.target.value })}
                    placeholder="Destination"
                  />

                  <label className="rounded-xl border bg-white px-2 py-1 text-[10px] font-semibold uppercase leading-tight text-slate-500">
                    Nights
                    <input
                      className="mt-0.5 w-full bg-transparent text-center text-sm font-normal text-slate-900 outline-none"
                      type="number"
                      min="1"
                      value={dest.nights ?? ""}
                      onChange={(e) => updateDestination(dest.id, { nights: e.target.value })}
                      onBlur={(e) => {
                        if (e.target.value === "") updateDestination(dest.id, { nights: 1 });
                      }}
                    />
                  </label>

                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveDestination(dest.id, -1)}
                      disabled={index === 0}
                      className="h-8 w-8 rounded-lg border bg-white text-sm font-bold disabled:opacity-30"
                      aria-label="Move stop up"
                      title="Move stop up"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveDestination(dest.id, 1)}
                      disabled={index === trip.destinations.length - 1}
                      className="h-8 w-8 rounded-lg border bg-white text-sm font-bold disabled:opacity-30"
                      aria-label="Move stop down"
                      title="Move stop down"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => removeDestination(dest.id)}
                      disabled={trip.destinations.length === 1}
                      className="h-8 w-8 rounded-lg border bg-white text-sm font-bold text-red-600 disabled:opacity-30"
                      aria-label="Delete stop"
                      title="Delete stop"
                    >
                      ×
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1 flex justify-between text-sm"><span>Overall progress</span><span>{stats.percent}%</span></div>
          <Progress value={stats.percent} />
          <div className="mt-1 text-xs text-slate-500">{stats.done} of {stats.total} tasks complete</div>
        </div>
      </div>
    </header>
  );
}

// -----------------------------------------------------------------------------
// Trip dashboard / checklists / packing
// -----------------------------------------------------------------------------

function TripDashboard({ tasks, family, shoppingList, shoppingChecks, setActiveTab, setActiveChecklist, navItems }) {
  const cards = navItems.filter((n) => !n.header).map((item) => {
    const all = Object.values(tasks[item.key] || {}).flat();
    const active = all.filter((t) => !t.na);
    const done = active.filter((t) => t.done).length;
    return { key: item.key, label: item.label, done, total: active.length, percent: pct(done, active.length) };
  });
  const packed = family.reduce((sum, m) => sum + m.items.filter((i) => i.packed).length, 0);
  const packTotal = family.reduce((sum, m) => sum + m.items.length, 0);
  const foodDone = shoppingList.filter((i) => shoppingChecks[i.checkKey || i.key || `${i.name}-${i.unit}-${i.category || "Other"}-${i.store || "Unassigned"}`]).length;
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {cards.map((c) => (
        <Card key={c.key}>
          <button type="button" onClick={() => { setActiveChecklist(c.key); setActiveTab("checklists"); }} className="w-full text-left">
            <div className="flex justify-between"><h3 className="font-bold">{c.label}</h3><span>{c.percent}%</span></div>
            <Progress value={c.percent} />
            <p className="mt-2 text-sm text-slate-500">{c.done} of {c.total} complete</p>
          </button>
        </Card>
      ))}
      <Card>
        <button type="button" onClick={() => setActiveTab("packing")} className="w-full text-left">
          <div className="flex justify-between"><h3 className="font-bold">Family Packing</h3><span>{pct(packed, packTotal)}%</span></div>
          <Progress value={pct(packed, packTotal)} />
          <p className="mt-2 text-sm text-slate-500">{packed} of {packTotal} packed</p>
        </button>
      </Card>
      <Card>
        <button type="button" onClick={() => setActiveTab("food")} className="w-full text-left">
          <div className="flex justify-between"><h3 className="font-bold">Food List</h3><span>{pct(foodDone, shoppingList.length)}%</span></div>
          <Progress value={pct(foodDone, shoppingList.length)} />
          <p className="mt-2 text-sm text-slate-500">{foodDone} of {shoppingList.length} packed / bought</p>
        </button>
      </Card>
    </div>
  );
}

function ChecklistView({ tasks, setTasks, activeChecklist, setActiveChecklist, navItems }) {
  const [newItem, setNewItem] = useState("");
  const groups = Object.keys(tasks[activeChecklist] || {});
  const [group, setGroup] = useState(groups[0] || "");
  const activeGroup = groups.includes(group) ? group : groups[0];

  const toggleTask = (groupName, taskId) =>
    setTasks((prev) => ({ ...prev, [activeChecklist]: { ...prev[activeChecklist], [groupName]: prev[activeChecklist][groupName].map((t) => t.id === taskId ? { ...t, done: !t.done, na: false } : t) } }));
  const toggleNA = (groupName, taskId) =>
    setTasks((prev) => ({ ...prev, [activeChecklist]: { ...prev[activeChecklist], [groupName]: prev[activeChecklist][groupName].map((t) => t.id === taskId ? { ...t, na: !t.na, done: false } : t) } }));
  const addItem = () => {
    if (!newItem.trim() || !activeGroup) return;
    setTasks((prev) => ({ ...prev, [activeChecklist]: { ...prev[activeChecklist], [activeGroup]: [...prev[activeChecklist][activeGroup], { id: uid("custom"), name: newItem.trim(), done: false, na: false }] } }));
    setNewItem("");
  };

  return (
    <div className="grid gap-4 md:grid-cols-[260px_1fr]">
      <Card>
        <div className="space-y-2">
          {navItems.map((item) =>
            item.header ? (
              <div key={item.key} className="pt-3 text-xs font-bold uppercase text-slate-500">{item.label}</div>
            ) : (
              <button key={item.key} type="button"
                onClick={() => { setActiveChecklist(item.key); setGroup(Object.keys(tasks[item.key] || {})[0] || ""); }}
                className={`w-full rounded-2xl px-3 py-2 text-left font-semibold ${item.level ? "ml-4 w-[calc(100%-1rem)]" : ""} ${activeChecklist === item.key ? "bg-slate-900 text-white" : "bg-slate-100"}`}>
                {item.label}
              </button>
            )
          )}
        </div>
      </Card>
      <Card>
        <h2 className="mb-4 text-xl font-bold">{navItems.find((n) => n.key === activeChecklist)?.label || "Checklist"}</h2>
        <div className="mb-5 rounded-3xl border border-slate-200 bg-slate-50 p-3">
          <div className="mb-2 text-sm font-semibold">Add custom list item</div>
          <div className="grid gap-2 sm:grid-cols-[1fr_220px_auto]">
            <input className="rounded-2xl border px-4 py-2" placeholder="New checklist item" value={newItem} onChange={(e) => setNewItem(e.target.value)} />
            <select className="rounded-2xl border bg-white px-4 py-2" value={activeGroup || ""} onChange={(e) => setGroup(e.target.value)}>
              {groups.map((g) => <option key={g}>{g}</option>)}
            </select>
            <button type="button" onClick={addItem} className="rounded-2xl bg-slate-900 px-4 py-2 text-white"><Plus size={18} /></button>
          </div>
        </div>
        <div className="space-y-5">
          {Object.entries(tasks[activeChecklist] || {}).map(([groupName, groupTasks]) => (
            <div key={groupName}>
              <h3 className="mb-2 font-bold">{groupName}</h3>
              <div className="space-y-2">
                {groupTasks.map((task) => (
                  <div key={task.id} className={`rounded-2xl border p-3 ${task.na ? "border-slate-200 bg-slate-100 opacity-70" : task.done ? "border-green-200 bg-green-50" : "border-slate-200 bg-white"}`}>
                    <div className="grid gap-2 sm:grid-cols-[auto_1fr_auto]">
                      <button type="button" onClick={() => toggleTask(groupName, task.id)}>{task.done ? <CheckCircle2 size={20} /> : <Circle size={20} />}</button>
                      <div className={task.done ? "text-slate-500 line-through" : task.na ? "text-slate-400" : ""}>{task.name}</div>
                      <button type="button" onClick={() => toggleNA(groupName, task.id)} className={`rounded-xl border px-3 py-2 text-sm font-semibold ${task.na ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white"}`}>N/A</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function PackingView({ family, setFamily, activeMember, setActiveMember }) {
  const [newItem, setNewItem] = useState("");
  const [newQty, setNewQty] = useState(1);
  const member = family.find((m) => m.id === activeMember) || family[0];

  const addItem = () => {
    if (!newItem.trim() || !member) return;
    setFamily((prev) => prev.map((m) => m.id === member.id ? { ...m, items: [...(m.items || []), { id: uid("pack"), name: newItem.trim(), qty: Number(newQty) || 1, packed: false }] } : m));
    setNewItem(""); setNewQty(1);
  };
  const update = (itemId, updates) => setFamily((prev) => prev.map((m) => member && m.id === member.id ? { ...m, items: (m.items || []).map((item) => item.id === itemId ? { ...item, ...updates } : item) } : m));
  const remove = (itemId) => setFamily((prev) => prev.map((m) => member && m.id === member.id ? { ...m, items: (m.items || []).filter((item) => item.id !== itemId) } : m));

  return (
    <Card>
      <div className="mb-4 flex gap-2 overflow-x-auto pb-2">
        {family.map((m) => (
          <button key={m.id} type="button" onClick={() => setActiveMember(m.id)} className={`whitespace-nowrap rounded-2xl px-4 py-2 font-semibold ${activeMember === m.id ? "bg-slate-900 text-white" : "bg-slate-100"}`}>{m.emoji} {m.name}</button>
        ))}
      </div>
      <div className="mb-4 grid gap-2 sm:grid-cols-[80px_1fr_auto]">
        <input className="rounded-2xl border px-3 py-2 text-center" type="number" min="1" value={newQty ?? ""} onChange={(e) => setNewQty(e.target.value)} />
        <input className="rounded-2xl border px-4 py-2" placeholder={`Add item for ${member?.name || "member"}`} value={newItem} onChange={(e) => setNewItem(e.target.value)} />
        <button type="button" onClick={addItem} className="rounded-2xl bg-slate-900 px-4 text-white"><Plus size={18} /></button>
      </div>
      <div className="space-y-2">
        {member?.items.map((item, index) => (
          <div key={item.id || `${item.name}-${index}`} className={`rounded-2xl border p-3 ${item.packed ? "border-green-200 bg-green-50" : "border-slate-200 bg-white"}`}>
            <div className="grid gap-2 sm:grid-cols-[auto_80px_1fr_auto]">
              <button type="button" onClick={() => update(item.id, { packed: !item.packed })}>{item.packed ? <CheckCircle2 size={20} /> : <Circle size={20} />}</button>
              <input className="rounded-xl border px-3 py-2 text-center" type="number" min="1" value={item.qty ?? ""} onChange={(e) => update(item.id, { qty: e.target.value })} />
              <input className={`rounded-xl border px-3 py-2 ${item.packed ? "text-slate-500 line-through" : ""}`} value={item.name} onChange={(e) => update(item.id, { name: e.target.value })} />
              <button type="button" onClick={() => remove(item.id)} className="rounded-xl border border-slate-200 p-2"><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// -----------------------------------------------------------------------------
// Food
// -----------------------------------------------------------------------------

function FoodView({ trip, destinations, recipes, setRecipes, shoppingList, shoppingChecks, toggleShoppingStatus, manualShoppingItems, setManualShoppingItems }) {
  const tripDays = useMemo(() => buildTripMealDays(trip?.departureDate, destinations || []), [trip?.departureDate, destinations]);
  const firstDay = tripDays[0];
  const [mealForm, setMealForm] = useState({ name: "", type: "Dinner", dayKey: firstDay?.key || "", destinationId: firstDay?.destinationId || destinations[0]?.id || "", dayNumber: firstDay?.dayNumber || 1, dateKey: firstDay?.dateKey || "", notes: "", ingredients: [] });
  const [ingredient, setIngredient] = useState({ name: "", qty: 1, unit: "pack", category: "Pantry" });
  const [editingIngredientId, setEditingIngredientId] = useState(null);
  const [manualItem, setManualItem] = useState({ name: "", qty: 1, unit: "", category: "Camp Supplies", store: "Unassigned" });
  const [editingMealId, setEditingMealId] = useState(null);
  const [storeFilter, setStoreFilter] = useState("All");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [openSections, setOpenSections] = useState({ meals: true, addMeal: true, shopping: true });
  const [openMealDays, setOpenMealDays] = useState({});
  const [openStores, setOpenStores] = useState({});
  const [openCategories, setOpenCategories] = useState({});

  useEffect(() => {
    if (!mealForm.dayKey && firstDay?.key) {
      setMealForm((prev) => ({ ...prev, dayKey: firstDay.key, destinationId: firstDay.destinationId, dayNumber: firstDay.dayNumber, dateKey: firstDay.dateKey }));
    }
  }, [firstDay?.key]);

  const toggleOpen = (key) => setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  const toggleMealDay = (key) => setOpenMealDays((prev) => ({ ...prev, [key]: !(prev[key] ?? true) }));
  const toggleStore = (key) => setOpenStores((prev) => ({ ...prev, [key]: !(prev[key] ?? true) }));
  const toggleCategory = (key) => setOpenCategories((prev) => ({ ...prev, [key]: !(prev[key] ?? true) }));

  const mealTypeRank = { Breakfast: 1, Lunch: 2, Dinner: 3, Dessert: 4, Snack: 5, Drinks: 6 };
  const mealTypes = ["Breakfast", "Lunch", "Dinner", "Dessert", "Snack", "Drinks"];
  const selectedDay = tripDays.find((day) => day.key === mealForm.dayKey) || firstDay;

  const storeFilters = ["All", ...Array.from(new Set(shoppingList.map((i) => i.store || "Unassigned")))];
  const categoryFilters = ["All", ...Array.from(new Set(shoppingList.map((i) => i.category || "Other")))];
  const filteredShopping = shoppingList.filter((item) => (storeFilter === "All" || item.store === storeFilter) && (categoryFilter === "All" || item.category === categoryFilter));
  const groupedStores = Array.from(new Set(filteredShopping.map((i) => i.store || "Unassigned")));

  const getMealDayKey = (meal) => {
    if (meal.dayKey) return meal.dayKey;
    const fallback = tripDays.find((day) => day.destinationId === meal.destinationId && Number(day.dayNumber) === (Number(meal.dayNumber ?? meal.night) || 1));
    return fallback?.key || `${meal.destinationId || "unassigned"}-day-${Number(meal.dayNumber ?? meal.night) || 1}`;
  };

  const mealsForDay = (day) => recipes
    .filter((meal) => getMealDayKey(meal) === day.key)
    .slice()
    .sort((a, b) => (mealTypeRank[a.type] || 99) - (mealTypeRank[b.type] || 99) || a.name.localeCompare(b.name));

  const resetIngredientForm = () => {
    setIngredient({ name: "", qty: 1, unit: "pack", category: "Pantry" });
    setEditingIngredientId(null);
  };

  const addIngredient = () => {
    if (!ingredient.name.trim()) return;
    setMealForm((prev) => {
      const nextIngredient = {
        ...ingredient,
        id: editingIngredientId || ingredient.id || uid("ing"),
        name: ingredient.name.trim(),
        qty: Number(ingredient.qty) || 1,
        store: ingredient.store || "Unassigned",
      };
      if (editingIngredientId) {
        return {
          ...prev,
          ingredients: (prev.ingredients || []).map((ing) => (ing.id === editingIngredientId ? nextIngredient : ing)),
        };
      }
      return {
        ...prev,
        ingredients: [...(prev.ingredients || []), nextIngredient],
      };
    });
    resetIngredientForm();
  };

  const startEditIngredient = (ing) => {
    const id = ing.id || uid("ing");
    setMealForm((prev) => ({
      ...prev,
      ingredients: (prev.ingredients || []).map((item) => (item === ing || item.id === ing.id ? { ...item, id } : item)),
    }));
    setIngredient({
      id,
      name: ing.name || "",
      qty: ing.qty ?? 1,
      unit: ing.unit || "pack",
      category: ing.category || "Pantry",
      store: ing.store || "Unassigned",
    });
    setEditingIngredientId(id);
  };

  const resetMealForm = () => {
    const day = tripDays[0];
    setMealForm({ name: "", type: "Dinner", dayKey: day?.key || "", destinationId: day?.destinationId || destinations[0]?.id || "", dayNumber: day?.dayNumber || 1, dateKey: day?.dateKey || "", notes: "", ingredients: [] });
    setEditingMealId(null);
    resetIngredientForm();
  };

  const saveMeal = () => {
    if (!mealForm.name.trim()) return;
    const day = tripDays.find((item) => item.key === mealForm.dayKey) || selectedDay;
    const meal = {
      ...mealForm,
      id: mealForm.id || uid("meal"),
      name: mealForm.name.trim(),
      type: mealForm.type || "Dinner",
      dayKey: day?.key || mealForm.dayKey || "",
      destinationId: day?.destinationId || mealForm.destinationId || destinations[0]?.id || "",
      dayNumber: day?.dayNumber || Number(mealForm.dayNumber ?? mealForm.night) || 1,
      dateKey: day?.dateKey || mealForm.dateKey || "",
      notes: mealForm.notes || "",
      ingredients: mealForm.ingredients || [],
    };
    delete meal.night;
    setRecipes((prev) => (mealForm.id ? prev.map((m) => (m.id === meal.id ? meal : m)) : [...prev, meal]));
    resetMealForm();
  };

  const startEdit = (meal) => {
    const mealDayKey = getMealDayKey(meal);
    const day = tripDays.find((item) => item.key === mealDayKey);
    setMealForm({
      ...clone(meal),
      dayKey: mealDayKey,
      destinationId: day?.destinationId || meal.destinationId || destinations[0]?.id || "",
      dayNumber: day?.dayNumber || Number(meal.dayNumber ?? meal.night) || 1,
      dateKey: day?.dateKey || meal.dateKey || "",
      notes: meal.notes || "",
      ingredients: (meal.ingredients || []).map((ing) => ({ ...ing, id: ing.id || uid("ing") })),
    });
    setEditingMealId(meal.id);
    setOpenSections((prev) => ({ ...prev, addMeal: true }));
  };

  const deleteMeal = (mealId) => setRecipes((prev) => prev.filter((m) => m.id !== mealId));

  const addManual = () => {
    if (!manualItem.name.trim()) return;
    setManualShoppingItems((prev) => [...prev, { ...manualItem, id: uid("manual"), name: manualItem.name.trim(), qty: Number(manualItem.qty) || 1, sources: ["Manual"] }]);
    setManualItem({ name: "", qty: 1, unit: "", category: "Camp Supplies", store: "Unassigned" });
  };

  const updateStore = (item, store) => {
    setRecipes((prev) => prev.map((meal) => ({
      ...meal,
      ingredients: (meal.ingredients || []).map((ing) => makeShoppingKey(ing) === item.key ? { ...ing, store } : ing),
    })));
    setManualShoppingItems((prev) => prev.map((m) => item.manualIds?.includes(m.id) ? { ...m, store } : m));
  };

  const renderSectionHeader = (key, title, subtitle) => (
    <button type="button" onClick={() => toggleOpen(key)} className="mb-3 flex w-full items-center justify-between gap-3 text-left">
      <span>
        <span className="text-xl font-bold">{openSections[key] ? "▾" : "▸"} {title}</span>
        {subtitle && <span className="block text-sm font-normal text-slate-500">{subtitle}</span>}
      </span>
    </button>
  );

  return (
    <div className="space-y-4">
      <Card>
        {renderSectionHeader("meals", "Meals", "Planned by trip date/day instead of night number.")}
        {openSections.meals && (
          <div className="space-y-3">
            {tripDays.map((day) => {
              const dayMeals = mealsForDay(day);
              const isOpen = openMealDays[day.key] ?? true;
              return (
                <div key={day.key} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <button type="button" onClick={() => toggleMealDay(day.key)} className="flex w-full items-start justify-between gap-3 text-left">
                    <div>
                      <div className="font-bold">{isOpen ? "▾" : "▸"} {day.label}</div>
                      {day.routeLabel && <div className="text-xs font-semibold text-slate-500">{day.routeLabel}</div>}
                    </div>
                    <div className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-500">{dayMeals.length} meals</div>
                  </button>
                  {isOpen && (
                    <div className="mt-3 space-y-2">
                      {dayMeals.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 bg-white p-3 text-sm text-slate-500">No meals planned for this day.</div>}
                      {dayMeals.map((meal) => (
                        <div key={meal.id} className="rounded-2xl border border-slate-200 bg-white p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="font-bold">{meal.name}</div>
                              <div className="text-xs text-slate-500">{meal.type} • {(meal.ingredients || []).length} ingredients</div>
                              {meal.notes && <div className="mt-2 whitespace-pre-wrap rounded-xl bg-slate-50 p-2 text-sm text-slate-600">{meal.notes}</div>}
                            </div>
                            <div className="flex gap-2">
                              <button type="button" onClick={() => startEdit(meal)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold">Edit</button>
                              <button type="button" onClick={() => deleteMeal(meal.id)} className="rounded-xl border border-slate-200 bg-white p-2"><Trash2 size={16} /></button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card>
        {renderSectionHeader("addMeal", editingMealId ? "Edit Meal" : "Add Meal", "Meals can be saved with or without ingredients.")}
        {openSections.addMeal && (
          <div className="space-y-4">
            {editingMealId && <button type="button" onClick={resetMealForm} className="rounded-xl border px-3 py-2 text-sm font-semibold">Cancel edit</button>}
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Meal Name"><input className="w-full rounded-2xl border px-4 py-2" value={mealForm.name} onChange={(e) => setMealForm({ ...mealForm, name: e.target.value })} /></Field>
              <Field label="Meal Type">
                <select className="w-full rounded-2xl border bg-white px-4 py-2" value={mealForm.type} onChange={(e) => setMealForm({ ...mealForm, type: e.target.value })}>
                  {mealTypes.map((x) => <option key={x}>{x}</option>)}
                </select>
              </Field>
              <Field label="Trip Day / Date">
                <select className="w-full rounded-2xl border bg-white px-4 py-2" value={mealForm.dayKey} onChange={(e) => {
                  const day = tripDays.find((item) => item.key === e.target.value);
                  setMealForm({ ...mealForm, dayKey: e.target.value, destinationId: day?.destinationId || "", dayNumber: day?.dayNumber || 1, dateKey: day?.dateKey || "" });
                }}>
                  {tripDays.map((day) => <option key={day.key} value={day.key}>{day.label}</option>)}
                </select>
              </Field>
            </div>

            <Field label="Meal Notes / Recipe"><textarea className="min-h-24 w-full rounded-2xl border px-4 py-2" value={mealForm.notes || ""} placeholder="Recipe steps, prep notes, links, cooking instructions..." onChange={(e) => setMealForm({ ...mealForm, notes: e.target.value })} /></Field>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="mb-3 text-sm font-bold">Ingredients</div>
              <Field label="Ingredient"><input className="w-full rounded-2xl border px-4 py-2" value={ingredient.name} onChange={(e) => setIngredient({ ...ingredient, name: e.target.value })} /></Field>
              <div className="mt-3 grid grid-cols-[64px_90px_1fr_auto] gap-3">
                <Field label="Qty"><input className="w-full rounded-2xl border px-2 py-2 text-center" type="number" min="0" value={ingredient.qty ?? ""} onChange={(e) => setIngredient({ ...ingredient, qty: e.target.value })} /></Field>
                <Field label="Unit"><input className="w-full rounded-2xl border px-3 py-2" value={ingredient.unit} onChange={(e) => setIngredient({ ...ingredient, unit: e.target.value })} /></Field>
                <Field label="Category">
                  <select className="w-full rounded-2xl border bg-white px-3 py-2" value={ingredient.category} onChange={(e) => setIngredient({ ...ingredient, category: e.target.value })}>
                    {categoryOptions.map((cat) => <option key={cat}>{cat}</option>)}
                  </select>
                </Field>
                <Field label={editingIngredientId ? "Save" : "Add"}><button type="button" onClick={addIngredient} className="rounded-2xl bg-slate-900 px-4 py-2 text-white">{editingIngredientId ? "Save" : <Plus size={18} />}</button></Field>
              </div>
              {editingIngredientId && <button type="button" onClick={resetIngredientForm} className="mt-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold">Cancel ingredient edit</button>}
              <div className="mt-3 space-y-2">
                {(mealForm.ingredients || []).map((ing, index) => (
                  <div key={ing.id || `${ing.name}-${index}`} className={`flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 text-sm ${editingIngredientId === ing.id ? "ring-2 ring-slate-300" : ""}`}>
                    <span className="min-w-0 flex-1 break-words">{ing.qty} {ing.unit} {ing.name} • {ing.category}</span>
                    <div className="flex shrink-0 gap-2">
                      <button type="button" onClick={() => startEditIngredient(ing)} className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold">Edit</button>
                      <button type="button" onClick={() => setMealForm((prev) => ({ ...prev, ingredients: (prev.ingredients || []).filter((item, i) => (ing.id ? item.id !== ing.id : i !== index)) }))}><Trash2 size={15} /></button>
                    </div>
                  </div>
                ))}
                {(!mealForm.ingredients || mealForm.ingredients.length === 0) && <div className="text-xs text-slate-500">No ingredients yet. You can still save this meal and add recipe notes.</div>}
              </div>
            </div>
            <button type="button" onClick={saveMeal} className="w-full rounded-2xl bg-slate-900 px-4 py-3 font-semibold text-white">{editingMealId ? "Save meal changes" : "Save meal"}</button>
          </div>
        )}
      </Card>

      <Card>
        {renderSectionHeader("shopping", "Shopping List", "Grouped by store and category. Track bought/have separately from packed.")}
        {openSections.shopping && (
          <div>
            <FilterChips label="Store" values={storeFilters} value={storeFilter} onChange={setStoreFilter} />
            <FilterChips label="Category" values={categoryFilters} value={categoryFilter} onChange={setCategoryFilter} />
            <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_80px_90px_150px_150px_auto]">
              <Field label="Manual Item"><input className="w-full rounded-2xl border px-4 py-2" value={manualItem.name} onChange={(e) => setManualItem({ ...manualItem, name: e.target.value })} /></Field>
              <Field label="Qty"><input className="w-full rounded-2xl border px-3 py-2" type="number" min="0" value={manualItem.qty ?? ""} onChange={(e) => setManualItem({ ...manualItem, qty: e.target.value })} /></Field>
              <Field label="Unit"><input className="w-full rounded-2xl border px-3 py-2" value={manualItem.unit} onChange={(e) => setManualItem({ ...manualItem, unit: e.target.value })} /></Field>
              <Field label="Category"><select className="w-full rounded-2xl border bg-white px-3 py-2" value={manualItem.category} onChange={(e) => setManualItem({ ...manualItem, category: e.target.value })}>{categoryOptions.map((cat) => <option key={cat}>{cat}</option>)}</select></Field>
              <Field label="Store"><select className="w-full rounded-2xl border bg-white px-3 py-2" value={manualItem.store} onChange={(e) => setManualItem({ ...manualItem, store: e.target.value })}>{["Unassigned","Walmart","Target","Costco","Sam's Club","Dillons","Amazon","Other"].map((s) => <option key={s}>{s}</option>)}</select></Field>
              <Field label="Add"><button type="button" onClick={addManual} className="rounded-2xl bg-slate-900 px-4 py-2 text-white"><Plus size={18} /></button></Field>
            </div>
            <div className="space-y-4">
              {groupedStores.map((store) => {
                const storeItems = filteredShopping.filter((i) => (i.store || "Unassigned") === store);
                const storeOpen = openStores[store] ?? true;
                const categories = Array.from(new Set(storeItems.map((i) => i.category || "Other")));
                return (
                  <div key={store} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <button type="button" onClick={() => toggleStore(store)} className="flex w-full items-center justify-between text-left">
                      <h3 className="font-bold">{storeOpen ? "▾" : "▸"} Store: {store}</h3>
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-500">{storeItems.length} items</span>
                    </button>
                    {storeOpen && (
                      <div className="mt-3 space-y-3">
                        {categories.map((category) => {
                          const categoryKey = `${store}|${category}`;
                          const categoryOpen = openCategories[categoryKey] ?? true;
                          const categoryItems = storeItems
                            .filter((item) => (item.category || "Other") === category)
                            .slice()
                            .sort((a, b) => {
                              const aStatus = shoppingChecks[a.checkKey || a.key] || {};
                              const bStatus = shoppingChecks[b.checkKey || b.key] || {};
                              const aDone = Boolean(aStatus.bought || aStatus.checked) && Boolean(aStatus.packed);
                              const bDone = Boolean(bStatus.bought || bStatus.checked) && Boolean(bStatus.packed);
                              return Number(aDone) - Number(bDone) || a.name.localeCompare(b.name);
                            });
                          return (
                            <div key={categoryKey} className="rounded-xl border border-slate-200 bg-white p-3">
                              <button type="button" onClick={() => toggleCategory(categoryKey)} className="flex w-full items-center justify-between text-left">
                                <div className="text-sm font-bold">{categoryOpen ? "▾" : "▸"} {category}</div>
                                <div className="text-xs text-slate-500">{categoryItems.length}</div>
                              </button>
                              {categoryOpen && (
                                <div className="mt-2 space-y-2">
                                  {categoryItems.map((item) => {
                                    const key = item.checkKey || item.key || makeShoppingKey(item);
                                    const status = shoppingChecks[key] || {};
                                    const bought = Boolean(status.bought || status.checked);
                                    const packed = Boolean(status.packed);
                                    return (
                                      <div key={key} className={`rounded-2xl border p-3 ${bought && packed ? "border-green-200 bg-green-50" : "border-slate-200 bg-white"}`}>
                                        <div className="grid gap-2 sm:grid-cols-[1fr_120px_120px_160px_auto] sm:items-center">
                                          <div>
                                            <div className={bought && packed ? "text-slate-500 line-through" : ""}>{item.qty} {item.unit} {item.name}</div>
                                            <div className="text-xs text-slate-500">From: {(item.sources || []).join(", ")}</div>
                                          </div>
                                          <button type="button" onClick={() => toggleShoppingStatus(key, "bought")} className={`rounded-xl border px-3 py-2 text-sm font-semibold ${bought ? "border-green-200 bg-green-100 text-green-800" : "border-slate-200 bg-white"}`}>{bought ? "✓ Bought/Have" : "Bought/Have"}</button>
                                          <button type="button" onClick={() => toggleShoppingStatus(key, "packed")} className={`rounded-xl border px-3 py-2 text-sm font-semibold ${packed ? "border-green-200 bg-green-100 text-green-800" : "border-slate-200 bg-white"}`}>{packed ? "✓ Packed" : "Packed"}</button>
                                          <select className="rounded-xl border bg-white px-3 py-2" value={item.store || "Unassigned"} onChange={(e) => updateStore(item, e.target.value)}>{["Unassigned","Walmart","Target","Costco","Sam's Club","Dillons","Amazon","Other"].map((s) => <option key={s}>{s}</option>)}</select>
                                          {(item.sources || []).includes("Manual") && <button type="button" onClick={() => setManualShoppingItems((prev) => prev.filter((x) => !item.manualIds.includes(x.id)))}><Trash2 size={16} /></button>}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {filteredShopping.length === 0 && <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">No shopping items yet.</div>}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function FilterChips({ label, values, value, onChange }) {
  return (
    <div className="mb-3">
      <div className="mb-2 text-xs font-semibold text-slate-500">{label}</div>
      <div className="flex flex-wrap gap-2">
        {values.map((v) => (
          <button key={v} type="button" onClick={() => onChange(v)} className={`rounded-full border px-4 py-2 text-sm font-semibold ${value === v ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700"}`}>{v}</button>
        ))}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Maintenance / configuration / weight
// -----------------------------------------------------------------------------

function MaintenanceView({ maintenanceItems, setMaintenanceItems, rvConfig, setRvConfig, towVehicle, setTowVehicle, rvNotes, setRvNotes, catScaleLogs, setCatScaleLogs }) {
  const [open, setOpen] = useState({ config: true, rvTires: false, rvTanks: false, tow: false, towTires: false, weight: false, weightTow: true, weightTrailer: true, weightCat: false, weightMargins: true, notes: false, addComponent: false, timeline: true, addMaint: false });
  const toggle = (key) => setOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  return (
    <div className="space-y-4">
      <RVConfigSection rvConfig={rvConfig} setRvConfig={setRvConfig} open={open} toggle={toggle} />
      <TowVehicleSection rvConfig={rvConfig} towVehicle={towVehicle} setTowVehicle={setTowVehicle} open={open} toggle={toggle} />
      <WeightSection rvConfig={rvConfig} setRvConfig={setRvConfig} towVehicle={towVehicle} setTowVehicle={setTowVehicle} catScaleLogs={catScaleLogs} setCatScaleLogs={setCatScaleLogs} open={open} toggle={toggle} />
      <ComponentNotes rvNotes={rvNotes} setRvNotes={setRvNotes} open={open.notes} addOpen={open.addComponent} toggleNotes={() => toggle("notes")} toggleAdd={() => toggle("addComponent")} />
      <MaintenanceTimeline maintenanceItems={maintenanceItems} setMaintenanceItems={setMaintenanceItems} open={open.timeline} addOpen={open.addMaint} toggleTimeline={() => toggle("timeline")} toggleAdd={() => toggle("addMaint")} />
    </div>
  );
}

function RVConfigSection({ rvConfig, setRvConfig, open, toggle }) {
  const lengthLabel = rvConfig.rvType === "Travel Trailer" ? "Length with Hitch" : rvConfig.rvType === "Fifth Wheel" ? "Length to Kingpin / Gooseneck Coupler" : "Length";
  const set = (patch) => setRvConfig({ ...rvConfig, ...patch });
  return (
    <CollapsibleCard title="RV Configuration" open={open.config} onToggle={() => toggle("config")}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="RV Type"><select className="w-full rounded-2xl border bg-white px-4 py-2" value={rvConfig.rvType} onChange={(e) => set({ rvType: e.target.value })}>{["Travel Trailer","Fifth Wheel","Motorhome Class A","Motorhome Class B / Camper Van","Motorhome Class C","Truck Camper","Other"].map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Year"><input className="w-full rounded-2xl border px-4 py-2" value={rvConfig.year ?? ""} placeholder="2024" onChange={(e) => set({ year: e.target.value })} /></Field>
          <Field label="Make"><input className="w-full rounded-2xl border px-4 py-2" value={rvConfig.make ?? ""} placeholder="Grand Design" onChange={(e) => set({ make: e.target.value })} /></Field>
          <Field label="Model"><input className="w-full rounded-2xl border px-4 py-2" value={rvConfig.model ?? ""} placeholder="Imagine" onChange={(e) => set({ model: e.target.value })} /></Field>
          <Field label="Trim / Floorplan"><input className="w-full rounded-2xl border px-4 py-2" value={rvConfig.trim ?? ""} placeholder="2600RB" onChange={(e) => set({ trim: e.target.value })} /></Field>
          <Field label="VIN"><input className="w-full rounded-2xl border px-4 py-2" value={rvConfig.vin ?? ""} placeholder="17-digit VIN" onChange={(e) => set({ vin: e.target.value })} /></Field>
          <Field label="License Plate"><input className="w-full rounded-2xl border px-4 py-2" value={rvConfig.licensePlate ?? ""} placeholder="Plate #" onChange={(e) => set({ licensePlate: e.target.value })} /></Field>
          <Field label="Height"><LengthInput feet={rvConfig.heightFt ?? ""} inches={rvConfig.heightIn ?? ""} onFeetChange={(v) => set({ heightFt: v })} onInchesChange={(v) => set({ heightIn: v })} /></Field>
          <Field label={lengthLabel}><LengthInput feet={rvConfig.lengthFt ?? ""} inches={rvConfig.lengthIn ?? ""} onFeetChange={(v) => set({ lengthFt: v })} onInchesChange={(v) => set({ lengthIn: v })} /></Field>
          <Field label="Roof Type"><input className="w-full rounded-2xl border px-4 py-2" value={rvConfig.roofType ?? ""} placeholder="TPO / EPDM / Fiberglass" onChange={(e) => set({ roofType: e.target.value })} /></Field>
        </div>
        <NestedSection title="Tires & Batteries" open={open.rvTires} onToggle={() => toggle("rvTires")}><TireBatteryFields data={rvConfig} setData={setRvConfig} rvMode /></NestedSection>
        <NestedSection title="Tank Configuration" open={open.rvTanks} onToggle={() => toggle("rvTanks")}><TankFields rvConfig={rvConfig} setRvConfig={setRvConfig} /></NestedSection>
        <Field label="General RV Notes"><textarea className="min-h-24 w-full rounded-2xl border px-4 py-2" value={rvConfig.notes ?? ""} placeholder="Dealer info, warranty notes, preferred tire pressure, service details..." onChange={(e) => set({ notes: e.target.value })} /></Field>
      </div>
    </CollapsibleCard>
  );
}

function TireBatteryFields({ data, setData, rvMode = false }) {
  const set = (patch) => setData((prev) => ({ ...prev, ...patch }));
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3">
        <div className="text-sm font-semibold text-slate-700">Tires</div>
        <Field label="Tire Size"><input className="w-full rounded-2xl border px-4 py-2" value={data.tireSize ?? ""} placeholder={rvMode ? "ST225/75R15" : "275/65R20"} onChange={(e) => set({ tireSize: e.target.value })} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={<HelpLabel label="Load Rating" help="Tire load range or load index. Future: use axle weights to validate tire capacity margins." />}><input className="w-full rounded-2xl border px-4 py-2" value={data.tireLoadRating ?? ""} placeholder="Load Range E / 123" onChange={(e) => set({ tireLoadRating: e.target.value })} /></Field>
          <Field label={<HelpLabel label="PSI" help="Current or target cold tire inflation pressure. Future: calculate recommended PSI from actual axle weights." />}><input className="w-full rounded-2xl border px-4 py-2" type="number" value={data.tirePsi ?? ""} placeholder={rvMode ? "80" : "65"} onChange={(e) => set({ tirePsi: e.target.value })} /></Field>
        </div>
        <Field label="Last Tire Purchase Date"><input className="w-full rounded-2xl border px-4 py-2" type="date" value={data.tirePurchaseDate ?? ""} onChange={(e) => set({ tirePurchaseDate: e.target.value })} /></Field>
      </div>
      <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3">
        <div className="text-sm font-semibold text-slate-700">Batteries</div>
        {rvMode && <Field label="Battery Type"><input className="w-full rounded-2xl border px-4 py-2" value={data.batteryType ?? ""} placeholder="Lead acid / AGM / Lithium" onChange={(e) => set({ batteryType: e.target.value })} /></Field>}
        <Field label="Last Battery Purchase Date"><input className="w-full rounded-2xl border px-4 py-2" type="date" value={data.batteryPurchaseDate ?? ""} onChange={(e) => set({ batteryPurchaseDate: e.target.value })} /></Field>
      </div>
    </div>
  );
}

function TankFields({ rvConfig, setRvConfig }) {
  const set = (patch) => setRvConfig((prev) => ({ ...prev, ...patch }));
  const rows = [["Propane","propaneTankQty","propaneTankCapacity","Capacity (lb)","30"],["Fresh","freshTankQty","freshTankCapacity","Capacity (gal)","52"],["Gray","grayTankQty","grayTankCapacity","Capacity (gal)","39"],["Black","blackTankQty","blackTankCapacity","Capacity (gal)","39"]];
  return <>{rows.map(([label, qtyKey, capKey, capLabel, placeholder]) => <div key={label} className="grid gap-3 sm:grid-cols-[110px_1fr]"><Field label={`${label} Qty`}><input className="w-full rounded-2xl border px-3 py-2" type="number" value={rvConfig[qtyKey] ?? ""} placeholder="1" onChange={(e) => set({ [qtyKey]: e.target.value })} /></Field><Field label={`${label} ${capLabel}`}><input className="w-full rounded-2xl border px-4 py-2" type="number" value={rvConfig[capKey] ?? ""} placeholder={placeholder} onChange={(e) => set({ [capKey]: e.target.value })} /></Field></div>)}</>;
}

function TowVehicleSection({ rvConfig, towVehicle, setTowVehicle, open, toggle }) {
  const lengthLabel = rvConfig.rvType === "Travel Trailer" ? "Length to Hitch Ball" : rvConfig.rvType === "Fifth Wheel" ? "Length to Kingpin / Goose Ball" : "Length";
  const set = (patch) => setTowVehicle({ ...towVehicle, ...patch });
  const fieldMeta = { year: ["Year","2024"], make: ["Make","Ford"], model: ["Model","F-150"], trim: ["Trim","Lariat"], engine: ["Engine / Chassis","3.5L EcoBoost"], fuelCapacity: ["Fuel Capacity (gal)","36"], vin: ["VIN","17-digit VIN"], licensePlate: ["License Plate","Plate #"] };
  return (
    <CollapsibleCard title={rvConfig.rvType.includes("Motorhome") ? "Vehicle / Motorhome Profile" : "Tow Vehicle"} open={open.tow} onToggle={() => toggle("tow")}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(fieldMeta).map(([key, [label, placeholder]]) => <Field key={key} label={label}><input className="w-full rounded-2xl border px-4 py-2" value={towVehicle[key] ?? ""} placeholder={placeholder} onChange={(e) => set({ [key]: e.target.value })} /></Field>)}
          <Field label={lengthLabel}><LengthInput feet={towVehicle.lengthFt ?? ""} inches={towVehicle.lengthIn ?? ""} onFeetChange={(v) => set({ lengthFt: v })} onInchesChange={(v) => set({ lengthIn: v })} /></Field>
        </div>
        <NestedSection title="Tow Vehicle Tires & Batteries" open={open.towTires} onToggle={() => toggle("towTires")}><TireBatteryFields data={towVehicle} setData={setTowVehicle} /></NestedSection>
      </div>
    </CollapsibleCard>
  );
}

function WeightSection({ rvConfig, setRvConfig, towVehicle, setTowVehicle, catScaleLogs = [], setCatScaleLogs, open, toggle }) {
  const towable = ["Travel Trailer", "Fifth Wheel", "Truck Camper", "Other"].includes(rvConfig.rvType);
  const usesPinWeight = rvConfig.rvType === "Fifth Wheel";
  const hitchLoadName = usesPinWeight ? "Pin Weight" : "Tongue Weight";
  const hitchLoadLower = usesPinWeight ? "pin" : "tongue";
  const defaultTrailerWeight = Number(rvConfig.gvwr) || Number(rvConfig.emptyWeight) || 0;
  const trailerWeight = Number(towVehicle.loadedTrailerWeight) || defaultTrailerWeight;
  const defaultTonguePercent = usesPinWeight ? 22 : 12;
  const enteredTongueWeight = Number(towVehicle.measuredTongueWeight) || 0;
  const enteredTonguePercent = Number(towVehicle.tongueWeightPercent) || 0;
  const tongueWeight = enteredTongueWeight || (enteredTonguePercent && trailerWeight ? Math.round((trailerWeight * enteredTonguePercent) / 100) : Math.round((trailerWeight * defaultTonguePercent) / 100));
  const calculatedTonguePercent = enteredTongueWeight && trailerWeight ? Number(((enteredTongueWeight / trailerWeight) * 100).toFixed(1)) : "";
  const calculatedTongueWeight = enteredTonguePercent && trailerWeight ? Math.round((trailerWeight * enteredTonguePercent) / 100) : "";
  const calculatedPayload = Number(towVehicle.gvwr) && Number(towVehicle.loadedTowVehicleWeight) ? Number(towVehicle.gvwr) - Number(towVehicle.loadedTowVehicleWeight) : 0;
  const gcwrMargin = Number(towVehicle.gcwr) && Number(towVehicle.loadedTowVehicleWeight) ? Number(towVehicle.gcwr) - Number(towVehicle.loadedTowVehicleWeight) - trailerWeight : 0;
  const payloadMargin = calculatedPayload ? calculatedPayload - tongueWeight : 0;
  const hitchMargin = Number(towVehicle.hitchRating) ? Number(towVehicle.hitchRating) - trailerWeight : 0;
  const hitchTongueMargin = Number(towVehicle.hitchTongueRating) ? Number(towVehicle.hitchTongueRating) - tongueWeight : 0;
  const trailerPayload = (Number(rvConfig.gvwr) || 0) - (Number(rvConfig.emptyWeight) || 0);
  const trailerCargo = Math.max(0, trailerWeight - (Number(rvConfig.emptyWeight) || 0));
  const estimatedTrailerAxleWeight = Math.max(0, trailerWeight - tongueWeight);
  const trailerAxleMargin = (Number(rvConfig.trailerAxleLimit) || 0) - estimatedTrailerAxleWeight;

  return (
    <CollapsibleCard title="Weight Ratings & Calculations" open={open.weight} onToggle={() => toggle("weight")}>
      <div className="space-y-4">
        <NestedSection title="Tow Vehicle" open={open.weightTow} onToggle={() => toggle("weightTow")}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <NumberField label={<HelpLabel label="GVWR (lb)" help="Gross Vehicle Weight Rating for the tow vehicle or motorhome." />} value={towVehicle.gvwr} onChange={(v) => setTowVehicle({ ...towVehicle, gvwr: v })} />
            <NumberField label="Loaded Vehicle Weight (lb)" value={towVehicle.loadedTowVehicleWeight} onChange={(v) => setTowVehicle({ ...towVehicle, loadedTowVehicleWeight: v })} />
            <NumberField label={<HelpLabel label="Front GAWR (lb)" help="Gross Axle Weight Rating for the front axle." />} value={towVehicle.frontGawr} onChange={(v) => setTowVehicle({ ...towVehicle, frontGawr: v })} />
            <NumberField label={<HelpLabel label="Rear GAWR (lb)" help="Gross Axle Weight Rating for the rear axle." />} value={towVehicle.rearGawr} onChange={(v) => setTowVehicle({ ...towVehicle, rearGawr: v })} />
            <Field label={<HelpLabel label="Payload" help="Calculated as tow vehicle GVWR minus loaded vehicle weight." />}><input readOnly className="w-full rounded-2xl border bg-slate-100 px-4 py-2" value={calculatedPayload || ""} /></Field>
            <NumberField label={<HelpLabel label="GCWR (lb)" help="Gross Combined Weight Rating." />} value={towVehicle.gcwr} onChange={(v) => setTowVehicle({ ...towVehicle, gcwr: v })} />
            <NumberField label={<HelpLabel label="GTWR / Hitch Tow Capacity (lb)" help="Maximum trailer/towed load rating. Use the lowest rated component." />} value={towVehicle.hitchRating} onChange={(v) => setTowVehicle({ ...towVehicle, hitchRating: v })} />
            <NumberField label={<HelpLabel label="Hitch Tongue Capacity (lb)" help="Maximum vertical tongue or pin load rating." />} value={towVehicle.hitchTongueRating} onChange={(v) => setTowVehicle({ ...towVehicle, hitchTongueRating: v })} />
          </div>
        </NestedSection>

        <NestedSection title="Trailer" open={open.weightTrailer} onToggle={() => toggle("weightTrailer")}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <NumberField label="Trailer GVWR (lb)" value={rvConfig.gvwr} onChange={(v) => setRvConfig({ ...rvConfig, gvwr: v })} />
            <NumberField label="Trailer Empty Weight (lb)" value={rvConfig.emptyWeight} onChange={(v) => setRvConfig({ ...rvConfig, emptyWeight: v })} />
            <Field label="Trailer Payload (lb)"><input readOnly className="w-full rounded-2xl border bg-slate-100 px-4 py-2" value={trailerPayload || ""} /></Field>
            <NumberField label={<HelpLabel label="Trailer Axle Limit (lb)" help="Combined rating of the trailer axle(s)." />} value={rvConfig.trailerAxleLimit} onChange={(v) => setRvConfig({ ...rvConfig, trailerAxleLimit: v })} />
            <NumberField label={<HelpLabel label={towable ? "Loaded Trailer Weight (lb)" : "Towed Load Weight (lb)"} help="Defaults to RV GVWR when blank." />} value={towVehicle.loadedTrailerWeight} onChange={(v) => setTowVehicle({ ...towVehicle, loadedTrailerWeight: v })} placeholder={defaultTrailerWeight ? `Default ${defaultTrailerWeight} lb` : ""} />
          </div>
          <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3">
            <div className="mb-2 text-xs font-semibold text-slate-500">
              <HelpLabel label={towable ? hitchLoadName : "Hitch / Carrier Load"} help={`Enter either an actual ${hitchLoadLower} weight or percentage. Travel trailers default to 12%, fifth wheels to 22%.`} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField label={`${hitchLoadName} (lb)`} value={towVehicle.measuredTongueWeight || calculatedTongueWeight || ""} placeholder={trailerWeight ? `Default ${tongueWeight} lb` : ""} onChange={(v) => setTowVehicle({ ...towVehicle, measuredTongueWeight: v, tongueWeightPercent: v ? "" : towVehicle.tongueWeightPercent })} />
              <NumberField label="Percent (%)" value={towVehicle.tongueWeightPercent || calculatedTonguePercent || ""} placeholder={`Default ${defaultTonguePercent}%`} onChange={(v) => setTowVehicle({ ...towVehicle, tongueWeightPercent: v, measuredTongueWeight: v ? "" : towVehicle.measuredTongueWeight })} />
            </div>
          </div>
        </NestedSection>

        <CatScaleSection
          rvConfig={rvConfig}
          towVehicle={towVehicle}
          setTowVehicle={setTowVehicle}
          logs={catScaleLogs}
          setLogs={setCatScaleLogs}
        />

        <div className="rounded-2xl border border-blue-100 bg-blue-50 p-3 text-xs text-blue-800">
          Manual margins use the weight fields above. CAT Scale logs calculate their own real-world margins separately; use the CAT section's apply button when you want a saved scale entry to update the manual trailer/tongue fields.
        </div>

        <NestedSection title="Margins" open={open.weightMargins} onToggle={() => toggle("weightMargins")}>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Tow Vehicle Limits</div>
              <div className="grid gap-3">
                <MarginCard label="GCWR margin" value={gcwrMargin} active={!!towVehicle.gcwr} />
                <MarginCard label={`Payload margin after ${hitchLoadLower}`} value={payloadMargin} active={!!calculatedPayload} />
                <MarginCard label="GTWR / hitch tow margin" value={hitchMargin} active={!!towVehicle.hitchRating} />
                <MarginCard label="Hitch tongue margin" value={hitchTongueMargin} active={!!towVehicle.hitchTongueRating} />
              </div>
            </div>
            <div>
              <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Trailer Limits</div>
              <div className="grid gap-3">
                <MarginCard label="Trailer GVWR margin" value={(Number(rvConfig.gvwr) || 0) - trailerWeight} active={!!rvConfig.gvwr} />
                <MarginCard label="Trailer payload margin" value={trailerPayload - trailerCargo} active={!!rvConfig.gvwr && !!rvConfig.emptyWeight} />
                <MarginCard label="Trailer axle margin" value={trailerAxleMargin} active={!!rvConfig.trailerAxleLimit && !!trailerWeight} />
              </div>
            </div>
          </div>
        </NestedSection>
      </div>
    </CollapsibleCard>
  );
}

function CatScaleSection({ rvConfig, towVehicle, setTowVehicle, logs = [], setLogs }) {
  const [form, setForm] = useState(() => emptyCatScaleLog(rvConfig.rvType));
  const [selectedId, setSelectedId] = useState(null);
  const [openMain, setOpenMain] = useState(false);
  const [openEntry, setOpenEntry] = useState(true);
  const [openResults, setOpenResults] = useState(true);
  const [openHistory, setOpenHistory] = useState(true);
  const isFifthWheel = rvConfig.rvType === "Fifth Wheel";
  const isTravelTrailer = rvConfig.rvType === "Travel Trailer";
  const supported = isFifthWheel || isTravelTrailer;
  const safeLogs = Array.isArray(logs) ? logs.filter((log) => log && typeof log === "object") : [];
  const sortedLogs = safeLogs.slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const selectedLog = sortedLogs.find((log) => log.id === selectedId) || sortedLogs[0] || null;
  const selectedResults = selectedLog ? calculateCatScaleResults(selectedLog, rvConfig, towVehicle) : null;

  useEffect(() => {
    setForm((prev) => ({ ...prev, rvType: rvConfig.rvType }));
  }, [rvConfig.rvType]);

  const updateForm = (path, value) => {
    setForm((prev) => setNestedValue(prev, path, value));
  };

  const saveLog = () => {
    const now = new Date().toISOString();
    const id = form.id || uid("cat-scale");
    const nextLog = {
      ...form,
      id,
      rvType: rvConfig.rvType,
      date: form.date || new Date().toISOString().slice(0, 10),
      createdAt: form.createdAt || now,
      updatedAt: now,
    };
    setLogs((prev = []) => [nextLog, ...(Array.isArray(prev) ? prev : []).filter((log) => log.id !== id)]);
    setSelectedId(id);
    setForm(emptyCatScaleLog(rvConfig.rvType));
  };

  const editLog = (log) => {
    setForm(clone(log));
    setSelectedId(log.id);
    setOpenEntry(true);
  };

  const deleteLog = (id) => {
    const confirmed = window.confirm("Delete this CAT Scale log entry?");
    if (!confirmed) return;
    setLogs((prev = []) => (Array.isArray(prev) ? prev : []).filter((log) => log.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const applySelectedToManualWeights = () => {
    if (!selectedResults || !setTowVehicle) return;
    setTowVehicle((prev) => ({
      ...prev,
      loadedTowVehicleWeight: selectedResults.finalTowVehicleWeight ? String(selectedResults.finalTowVehicleWeight) : prev.loadedTowVehicleWeight,
      loadedTrailerWeight: selectedResults.estimatedTrailerWeight ? String(selectedResults.estimatedTrailerWeight) : prev.loadedTrailerWeight,
      measuredTongueWeight: selectedResults.hitchLoad ? String(selectedResults.hitchLoad) : prev.measuredTongueWeight,
      tongueWeightPercent: "",
    }));
  };

  return (
    <NestedSection title="CAT Scale Logs" open={openMain} onToggle={() => setOpenMain((prev) => !prev)}>
      {!supported && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
          CAT Scale calculations are currently set up for Travel Trailer and Fifth Wheel RV types. Select one of those RV types to enter weigh-ins.
        </div>
      )}

      {supported && (
        <div className="space-y-4">
          <NestedSection title="Enter / Edit Weigh-In" open={openEntry} onToggle={() => setOpenEntry((prev) => !prev)}>
            <div className="rounded-2xl border border-slate-200 bg-white p-3">
              <div className="mb-3 grid gap-3 sm:grid-cols-2">
                <Field label="Scale Date"><input className="w-full rounded-2xl border px-4 py-2" type="date" value={form.date || ""} onChange={(e) => updateForm("date", e.target.value)} /></Field>
                <Field label="Trip / Reason"><input className="w-full rounded-2xl border px-4 py-2" value={form.reason || ""} placeholder="Rocky Mountains trip / loaded for camping" onChange={(e) => updateForm("reason", e.target.value)} /></Field>
              </div>

              <CatWeighInput title="Vehicle Only" values={form.vehicleOnly} onChange={(key, value) => updateForm(`vehicleOnly.${key}`, value)} includeTrailer={false} />
              <CatWeighInput title={isFifthWheel ? "Vehicle + Fifth Wheel" : "Vehicle + Trailer, No Weight Distribution"} values={form.hitchedNoWd} onChange={(key, value) => updateForm(`hitchedNoWd.${key}`, value)} includeTrailer />
              {isTravelTrailer && <CatWeighInput title="Vehicle + Trailer, With Weight Distribution" values={form.hitchedWd} onChange={(key, value) => updateForm(`hitchedWd.${key}`, value)} includeTrailer />}

              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={saveLog} className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white">Save CAT Scale Log</button>
                {form.id && <button type="button" onClick={() => setForm(emptyCatScaleLog(rvConfig.rvType))} className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold">Cancel Edit</button>}
              </div>
            </div>
          </NestedSection>

          <NestedSection title="Calculated Results" open={openResults} onToggle={() => setOpenResults((prev) => !prev)}>
            {selectedResults ? (
              <div className="space-y-3">
                <CatScaleResults results={selectedResults} rvType={selectedLog.rvType || rvConfig.rvType} />
                <div className="rounded-2xl border border-blue-100 bg-blue-50 p-3 text-xs text-blue-800">
                  CAT Scale results are calculated independently from the manual margins. Apply this log only when you want the manual weight fields to use the selected scale data.
                </div>
                <button type="button" onClick={applySelectedToManualWeights} className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-slate-50">
                  Apply selected CAT weights to manual fields
                </button>
              </div>
            ) : (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">Save a CAT Scale log to see calculated results.</div>
            )}
          </NestedSection>

          <NestedSection title={`Saved Weigh-In Log (${sortedLogs.length})`} open={openHistory} onToggle={() => setOpenHistory((prev) => !prev)}>
            <div className="space-y-2">
              {!sortedLogs.length && <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">No CAT Scale entries saved yet.</div>}
              {sortedLogs.map((log) => (
                <div key={log.id} className={`rounded-2xl border p-3 ${selectedLog?.id === log.id ? "border-slate-900 bg-slate-50" : "border-slate-200 bg-white"}`}>
                  <button type="button" onClick={() => setSelectedId(log.id)} className="w-full text-left">
                    <div className="font-bold">{formatDisplayDate(log.date)} • {log.reason || "CAT Scale weigh-in"}</div>
                    <div className="text-xs text-slate-500">{log.rvType || rvConfig.rvType}</div>
                  </button>
                  <div className="mt-3 flex gap-2">
                    <button type="button" onClick={() => editLog(log)} className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold">Edit</button>
                    <button type="button" onClick={() => deleteLog(log.id)} className="rounded-xl border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700">Delete</button>
                  </div>
                </div>
              ))}
            </div>
          </NestedSection>
        </div>
      )}
    </NestedSection>
  );
}

function CatWeighInput({ title, values = {}, onChange, includeTrailer }) {
  return (
    <div className="mb-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 text-sm font-bold text-slate-700">{title}</div>
      <div className="grid gap-3 sm:grid-cols-3">
        <NumberField label="Front / Steer Axle (lb)" value={values.front || ""} onChange={(v) => onChange("front", v)} />
        <NumberField label="Drive Axle (lb)" value={values.drive || ""} onChange={(v) => onChange("drive", v)} />
        {includeTrailer && <NumberField label="Trailer Axle (lb)" value={values.trailer || ""} onChange={(v) => onChange("trailer", v)} />}
      </div>
    </div>
  );
}

function CatScaleResults({ results, rvType }) {
  const isTravelTrailer = rvType === "Travel Trailer";
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3">
      <div className="mb-3 text-sm font-bold text-slate-700">Calculated CAT Scale Results</div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <MarginCard label="Vehicle-only weight" value={results.vehicleOnlyWeight} active={results.vehicleOnlyWeight > 0} />
        <MarginCard label="Combined weight" value={results.combinedWeight} active={results.combinedWeight > 0} />
        <MarginCard label={rvType === "Fifth Wheel" ? "Pin weight" : "Tongue weight"} value={results.hitchLoad} active={results.hitchLoad > 0} />
        <MarginCard label="Estimated trailer weight" value={results.estimatedTrailerWeight} active={results.estimatedTrailerWeight > 0} />
        <MarginCard label="Tow vehicle GVWR margin" value={results.towVehicleGvwrMargin} active={results.hasTowVehicleGvwr} />
        <MarginCard label="Front GAWR margin" value={results.frontGawrMargin} active={results.hasFrontGawr} />
        <MarginCard label="Rear GAWR margin" value={results.rearGawrMargin} active={results.hasRearGawr} />
        <MarginCard label="GCWR margin" value={results.gcwrMargin} active={results.hasGcwr} />
        <MarginCard label="GTWR / hitch tow margin" value={results.hitchTowMargin} active={results.hasHitchRating} />
        <MarginCard label={rvType === "Fifth Wheel" ? "Hitch pin capacity margin" : "Hitch tongue capacity margin"} value={results.hitchTongueMargin} active={results.hasHitchTongueRating} />
        <MarginCard label="Trailer GVWR margin" value={results.trailerGvwrMargin} active={results.hasTrailerGvwr} />
        <MarginCard label="Trailer axle margin" value={results.trailerAxleMargin} active={results.hasTrailerAxleLimit} />
        {isTravelTrailer && <MarginCard label="Front axle restoration" value={results.frontAxleRestoration} active={results.hasWdAndNoWd} />}
      </div>
      {isTravelTrailer && results.hasWdAndNoWd && (
        <p className="mt-3 text-xs text-slate-500">
          For travel trailers, tongue weight is estimated from the no-weight-distribution weigh-in. Final safety margins use the weight-distribution weigh-in because those are the axle loads used while driving.
        </p>
      )}
    </div>
  );
}

function emptyCatScaleLog(rvType = "Travel Trailer") {
  return {
    id: "",
    rvType,
    date: new Date().toISOString().slice(0, 10),
    reason: "",
    vehicleOnly: { front: "", drive: "" },
    hitchedNoWd: { front: "", drive: "", trailer: "" },
    hitchedWd: { front: "", drive: "", trailer: "" },
  };
}

function setNestedValue(object, path, value) {
  const parts = path.split(".");
  const next = clone(object);
  let cursor = next;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor[parts[i]] = cursor[parts[i]] || {};
    cursor = cursor[parts[i]];
  }
  cursor[parts[parts.length - 1]] = value;
  return next;
}

function catNum(value) {
  return Number(value) || 0;
}

function catPairTotal(entry = {}) {
  return catNum(entry.front) + catNum(entry.drive);
}

function catTripleTotal(entry = {}) {
  return catPairTotal(entry) + catNum(entry.trailer);
}

function calculateCatScaleResults(log, rvConfig = {}, towVehicle = {}) {
  const rvType = log.rvType || rvConfig.rvType || "Travel Trailer";
  const isTravelTrailer = rvType === "Travel Trailer";
  const finalHitched = isTravelTrailer && catTripleTotal(log.hitchedWd) ? log.hitchedWd : log.hitchedNoWd;
  const vehicleOnlyWeight = catPairTotal(log.vehicleOnly);
  const noWdTowVehicleWeight = catPairTotal(log.hitchedNoWd);
  const finalTowVehicleWeight = catPairTotal(finalHitched);
  const combinedWeight = catTripleTotal(finalHitched);
  const hitchLoad = Math.max(0, noWdTowVehicleWeight - vehicleOnlyWeight);
  const trailerAxleWeight = catNum(finalHitched?.trailer);
  const estimatedTrailerWeight = trailerAxleWeight + hitchLoad;

  const frontOnly = catNum(log.vehicleOnly?.front);
  const frontNoWd = catNum(log.hitchedNoWd?.front);
  const frontFinal = catNum(finalHitched?.front);
  const frontLostNoWd = Math.max(0, frontOnly - frontNoWd);
  const frontRestored = Math.max(0, frontFinal - frontNoWd);
  const frontAxleRestoration = frontLostNoWd ? Math.round((frontRestored / frontLostNoWd) * 100) : 0;

  const towVehicleGvwr = catNum(towVehicle.gvwr);
  const frontGawr = catNum(towVehicle.frontGawr);
  const rearGawr = catNum(towVehicle.rearGawr);
  const gcwr = catNum(towVehicle.gcwr);
  const hitchRating = catNum(towVehicle.hitchRating);
  const hitchTongueRating = catNum(towVehicle.hitchTongueRating);
  const trailerGvwr = catNum(rvConfig.gvwr);
  const trailerAxleLimit = catNum(rvConfig.trailerAxleLimit);

  return {
    vehicleOnlyWeight,
    combinedWeight,
    finalTowVehicleWeight,
    hitchLoad,
    estimatedTrailerWeight,
    towVehicleGvwrMargin: towVehicleGvwr - finalTowVehicleWeight,
    frontGawrMargin: frontGawr - catNum(finalHitched?.front),
    rearGawrMargin: rearGawr - catNum(finalHitched?.drive),
    gcwrMargin: gcwr - combinedWeight,
    hitchTowMargin: hitchRating - estimatedTrailerWeight,
    hitchTongueMargin: hitchTongueRating - hitchLoad,
    trailerGvwrMargin: trailerGvwr - estimatedTrailerWeight,
    trailerAxleMargin: trailerAxleLimit - trailerAxleWeight,
    frontAxleRestoration,
    hasTowVehicleGvwr: !!towVehicleGvwr && !!finalTowVehicleWeight,
    hasFrontGawr: !!frontGawr && !!catNum(finalHitched?.front),
    hasRearGawr: !!rearGawr && !!catNum(finalHitched?.drive),
    hasGcwr: !!gcwr && !!combinedWeight,
    hasHitchRating: !!hitchRating && !!estimatedTrailerWeight,
    hasHitchTongueRating: !!hitchTongueRating && !!hitchLoad,
    hasTrailerGvwr: !!trailerGvwr && !!estimatedTrailerWeight,
    hasTrailerAxleLimit: !!trailerAxleLimit && !!trailerAxleWeight,
    hasWdAndNoWd: isTravelTrailer && !!catTripleTotal(log.hitchedWd) && !!catTripleTotal(log.hitchedNoWd),
  };
}

function formatDisplayDate(dateString) {
  if (!dateString) return "No date";
  const [year, month, day] = String(dateString).split("-").map(Number);
  if (!year || !month || !day) return dateString;
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function NumberField({ label, value, onChange, placeholder = "" }) {
  return <Field label={label}><input className="w-full rounded-2xl border px-4 py-2" type="number" value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} /></Field>;
}

function MarginCard({ label, value, active }) {
  const status = !active ? "Missing rating" : value < 0 ? "Over" : value < 250 ? "Tight" : "OK";
  const cls = !active ? "border-slate-200 bg-slate-50" : value < 0 ? "border-red-200 bg-red-50" : value < 250 ? "border-yellow-200 bg-yellow-50" : "border-green-200 bg-green-50";
  return <div className={`rounded-2xl border p-3 ${cls}`}><div className="text-xs font-semibold text-slate-500">{label}</div><div className="text-2xl font-bold">{active ? `${value} lb` : "—"}</div><div className="text-sm text-slate-600">{status}</div></div>;
}

function ComponentNotes({ rvNotes, setRvNotes, open, addOpen, toggleNotes, toggleAdd }) {
  const [newNote, setNewNote] = useState({ label: "", brand: "", model: "", serialNumber: "", notes: "" });
  const [editingId, setEditingId] = useState(null);
  const addNote = () => {
    if (!newNote.label.trim() && !newNote.brand.trim() && !newNote.model.trim() && !newNote.serialNumber.trim()) return;
    setRvNotes((prev) => [...prev, { ...newNote, id: uid("rv-note"), label: newNote.label.trim() || "Component" }]);
    setNewNote({ label: "", brand: "", model: "", serialNumber: "", notes: "" });
  };
  const update = (id, patch) => setRvNotes((prev) => prev.map((n) => n.id === id ? { ...n, ...patch } : n));
  return (
    <CollapsibleCard title="Component Notes" open={open} onToggle={toggleNotes}>
      <p className="mb-4 text-sm text-slate-600">Track brands, model numbers, serial numbers, and notes for appliances, awnings, electronics, and other RV components.</p>
      <NestedSection title="Add Component" open={addOpen} onToggle={toggleAdd} className="mb-4">
        <ComponentNoteForm note={newNote} setNote={(patch) => setNewNote((prev) => ({ ...prev, ...patch }))} action={<button type="button" onClick={addNote} className="rounded-xl bg-slate-900 px-4 py-2 text-white"><Plus size={18} /></button>} />
      </NestedSection>
      <div className="space-y-3">
        {rvNotes.map((note) => (
          <div key={note.id} className="rounded-2xl border border-slate-200 bg-white p-3">
            {editingId === note.id ? (
              <div className="space-y-3">
                <ComponentNoteForm note={note} setNote={(patch) => update(note.id, patch)} />
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setEditingId(null)} className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white">Done</button>
                  <button type="button" onClick={() => setRvNotes((prev) => prev.filter((n) => n.id !== note.id))} className="rounded-xl border px-3 py-2 text-sm font-semibold">Delete</button>
                </div>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-bold">{note.label || "Component"}</h3>
                  <div className="mt-1 grid gap-1 text-sm text-slate-600 sm:grid-cols-3">
                    <div><b>Brand:</b> {note.brand || "—"}</div>
                    <div><b>Model:</b> {note.model || "—"}</div>
                    <div><b>Serial:</b> {note.serialNumber || "—"}</div>
                  </div>
                  {note.notes && <p className="mt-2 text-sm text-slate-600">{note.notes}</p>}
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setEditingId(note.id)} className="rounded-xl border px-3 py-2 text-sm font-semibold">Edit</button>
                  <button type="button" onClick={() => setRvNotes((prev) => prev.filter((n) => n.id !== note.id))} className="rounded-xl border p-2"><Trash2 size={16} /></button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </CollapsibleCard>
  );
}

function ComponentNoteForm({ note, setNote, action }) {
  const apply = (patch) => { if (typeof setNote === "function") setNote(patch); };
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto]">
        <Field label="Item"><input className="w-full rounded-xl border px-3 py-2" value={note.label ?? ""} onChange={(e) => apply({ label: e.target.value })} /></Field>
        <Field label="Brand"><input className="w-full rounded-xl border px-3 py-2" value={note.brand ?? ""} onChange={(e) => apply({ brand: e.target.value })} /></Field>
        <Field label="Model"><input className="w-full rounded-xl border px-3 py-2" value={note.model ?? ""} onChange={(e) => apply({ model: e.target.value })} /></Field>
        <Field label="Serial Number"><input className="w-full rounded-xl border px-3 py-2" value={note.serialNumber ?? ""} onChange={(e) => apply({ serialNumber: e.target.value })} /></Field>
        {action && <Field label="Add">{action}</Field>}
      </div>
      <Field label="Notes"><textarea className="min-h-16 w-full rounded-xl border px-3 py-2" value={note.notes ?? ""} onChange={(e) => apply({ notes: e.target.value })} /></Field>
    </>
  );
}

function MaintenanceTimeline({ maintenanceItems, setMaintenanceItems, open, addOpen, toggleTimeline, toggleAdd }) {
  const [form, setForm] = useState({ name: "", category: "RV Exterior", frequencyValue: 6, frequencyUnit: "months", lastDone: todayISO(), notes: "" });
  const [editingId, setEditingId] = useState(null);
  const [sort, setSort] = useState("dueNext");
  const [statusFilter, setStatusFilter] = useState("All");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const statusPriority = { Overdue: 0, "Due Soon": 1, "On Track": 2 };

  const add = () => {
    if (!form.name.trim()) return;
    setMaintenanceItems((prev) => [...prev, { ...form, id: uid("maint"), name: form.name.trim(), frequencyValue: Number(form.frequencyValue) || 1 }]);
    setForm({ name: "", category: "RV Exterior", frequencyValue: 6, frequencyUnit: "months", lastDone: todayISO(), notes: "" });
  };
  const update = (id, patch) => setMaintenanceItems((prev) => prev.map((item) => item.id === id ? { ...item, ...patch } : item));
  const categories = ["All", ...Array.from(new Set(maintenanceItems.map((i) => i.category || "Other")))];

  const items = maintenanceItems
    .filter((i) => statusFilter === "All" || maintenanceStatus(i).status === statusFilter)
    .filter((i) => categoryFilter === "All" || i.category === categoryFilter)
    .slice()
    .sort((a, b) => {
      const as = maintenanceStatus(a), bs = maintenanceStatus(b);
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "category") return a.category.localeCompare(b.category) || as.daysRemaining - bs.daysRemaining;
      if (sort === "overdueFirst") return ((statusPriority[as.status] ?? 3) - (statusPriority[bs.status] ?? 3)) || as.daysRemaining - bs.daysRemaining;
      return as.daysRemaining - bs.daysRemaining;
    });

  return (
    <CollapsibleCard title="Maintenance Timeline" open={open} onToggle={toggleTimeline}>
      <NestedSection title="Add Maintenance Item" open={addOpen} onToggle={toggleAdd} className="mb-4">
        <MaintenanceForm form={form} setForm={setForm} onSubmit={add} />
      </NestedSection>
      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <Field label="Sort">
          <select className="w-full rounded-2xl border bg-white px-4 py-2" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="dueNext">Due soonest</option>
            <option value="overdueFirst">Overdue first, then due soon</option>
            <option value="category">Category</option>
            <option value="name">Name</option>
          </select>
        </Field>
        <Field label="Status">
          <select className="w-full rounded-2xl border bg-white px-4 py-2" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            {["All","Overdue","Due Soon","On Track"].map((x) => <option key={x}>{x}</option>)}
          </select>
        </Field>
        <Field label="Category">
          <select className="w-full rounded-2xl border bg-white px-4 py-2" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            {categories.map((x) => <option key={x}>{x}</option>)}
          </select>
        </Field>
      </div>
      <div className="space-y-3">
        {items.map((item) => (
          <MaintenanceCard key={item.id} item={item} editing={editingId === item.id} setEditing={(val) => setEditingId(val ? item.id : null)} update={(patch) => update(item.id, patch)} remove={() => setMaintenanceItems((prev) => prev.filter((i) => i.id !== item.id))} />
        ))}
      </div>
    </CollapsibleCard>
  );
}

function MaintenanceForm({ form, setForm, onSubmit }) {
  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));
  return (
    <div className="space-y-3">
      <Field label="Maintenance Item"><input className="w-full rounded-2xl border px-4 py-2" value={form.name} onChange={(e) => set({ name: e.target.value })} /></Field>
      <div className="grid gap-3 sm:grid-cols-[1fr_76px_120px]">
        <Field label="Category"><select className="w-full rounded-2xl border bg-white px-4 py-2" value={form.category} onChange={(e) => set({ category: e.target.value })}>{maintenanceCategories.map((cat) => <option key={cat}>{cat}</option>)}</select></Field>
        <Field label="Every"><input className="w-full rounded-2xl border px-2 py-2 text-center" type="number" value={form.frequencyValue ?? ""} onChange={(e) => set({ frequencyValue: e.target.value })} /></Field>
        <Field label="Frequency"><select className="w-full rounded-2xl border bg-white px-4 py-2" value={form.frequencyUnit} onChange={(e) => set({ frequencyUnit: e.target.value })}>{["days","weeks","months","years","trips"].map((x) => <option key={x} value={x}>{x}</option>)}</select></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-[180px_1fr_auto]">
        <Field label="Last Done"><input className="w-full rounded-2xl border px-4 py-2" type="date" value={form.lastDone} onChange={(e) => set({ lastDone: e.target.value })} /></Field>
        <Field label="Notes"><input className="w-full rounded-2xl border px-4 py-2" value={form.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
        {onSubmit && <Field label="Add"><button type="button" onClick={onSubmit} className="rounded-2xl bg-slate-900 px-4 py-2 text-white"><Plus size={18} /></button></Field>}
      </div>
    </div>
  );
}

function MaintenanceCard({ item, editing, setEditing, update, remove }) {
  const info = maintenanceStatus(item);
  const cls = info.status === "Overdue" ? "border-red-200 bg-red-50" : info.status === "Due Soon" ? "border-yellow-200 bg-yellow-50" : "border-green-200 bg-green-50";
  if (editing) return (
    <Card className={cls}>
      <MaintenanceForm form={item} setForm={(updater) => update(typeof updater === "function" ? updater(item) : updater)} />
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={() => setEditing(false)} className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white">Done</button>
        <button type="button" onClick={remove} className="rounded-xl border px-3 py-2 text-sm font-semibold">Delete</button>
      </div>
    </Card>
  );
  return (
    <Card className={cls}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-slate-500">{item.category}</div>
          <h3 className="text-lg font-bold">{item.name}</h3>
          <p className="text-sm text-slate-600">Every {item.frequencyValue} {item.frequencyUnit} • Last done {formatDate(parseLocalDate(item.lastDone))}</p>
        </div>
        <div className="rounded-full border bg-white px-3 py-1 text-sm font-bold">{info.status}</div>
      </div>
      <div className="mt-4">
        <div className="mb-1 flex justify-between text-sm">
          <span>Due {formatDate(info.due)}</span>
          <span>{info.daysRemaining < 0 ? `${Math.abs(info.daysRemaining)} days overdue` : `${info.daysRemaining} days left`}</span>
        </div>
        <Progress value={info.percent} tone="risk" />
      </div>
      {item.notes && <p className="mt-3 text-sm text-slate-600">{item.notes}</p>}
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <button type="button" onClick={() => update({ lastDone: todayISO() })} className="rounded-2xl bg-slate-900 px-4 py-2 font-semibold text-white">Mark done today</button>
        <button type="button" onClick={() => setEditing(true)} className="rounded-2xl border bg-white px-4 py-2 font-semibold">Edit</button>
        <button type="button" onClick={remove} className="rounded-2xl border bg-white px-4 py-2 font-semibold">Delete</button>
      </div>
    </Card>
  );
}

// -----------------------------------------------------------------------------
// Template / settings
// -----------------------------------------------------------------------------

function TemplateEditor({ appTemplate, setAppTemplate, goHome }) {
  const [sectionKey, setSectionKey] = useState(Object.keys(appTemplate)[0]);
  const [groupName, setGroupName] = useState(Object.keys(appTemplate[sectionKey].groups)[0]);
  const [newItem, setNewItem] = useState("");
  const section = appTemplate[sectionKey];
  const changeSection = (key) => { setSectionKey(key); setGroupName(Object.keys(appTemplate[key].groups)[0]); };
  const addItem = () => {
    if (!newItem.trim()) return;
    setAppTemplate((prev) => ({ ...prev, [sectionKey]: { ...prev[sectionKey], groups: { ...prev[sectionKey].groups, [groupName]: [...prev[sectionKey].groups[groupName], { name: newItem.trim(), hidden: false }] } } }));
    setNewItem("");
  };
  const toggleHidden = (group, idx) => setAppTemplate((prev) => ({ ...prev, [sectionKey]: { ...prev[sectionKey], groups: { ...prev[sectionKey].groups, [group]: prev[sectionKey].groups[group].map((item, i) => i === idx ? { name: taskName(item), hidden: !taskHidden(item) } : item) } } }));
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Default RV Trip Template</h2>
            <p className="text-sm text-slate-600">Hidden items remain in the template but do not appear in new trips.</p>
          </div>
          <button type="button" onClick={goHome} className="rounded-2xl border px-4 py-2 text-sm font-semibold">← Back to Home</button>
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-[240px_1fr]">
        <Card>
          <div className="space-y-2">
            {Object.entries(appTemplate).map(([key, value]) => (
              <button key={key} type="button" onClick={() => changeSection(key)} className={`w-full rounded-2xl px-3 py-2 text-left font-semibold ${sectionKey === key ? "bg-slate-900 text-white" : "bg-slate-100"}`}>{value.label}</button>
            ))}
          </div>
        </Card>
        <Card>
          <h3 className="mb-4 text-xl font-bold">{section.label}</h3>
          <div className="mb-5 grid gap-2 sm:grid-cols-[220px_1fr_auto]">
            <select className="rounded-2xl border bg-white px-4 py-2" value={groupName} onChange={(e) => setGroupName(e.target.value)}>{Object.keys(section.groups).map((group) => <option key={group}>{group}</option>)}</select>
            <input className="rounded-2xl border px-4 py-2" value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder="New template checklist item" />
            <button type="button" onClick={addItem} className="rounded-2xl bg-slate-900 px-4 py-2 text-white"><Plus size={18} /></button>
          </div>
          <div className="space-y-5">
            {Object.entries(section.groups).map(([group, items]) => (
              <div key={group}>
                <h4 className="mb-2 font-bold">{group}</h4>
                <div className="space-y-2">
                  {items.map((item, idx) => (
                    <div key={idx} className={`grid gap-2 rounded-2xl border p-3 sm:grid-cols-[1fr_auto] ${taskHidden(item) ? "bg-slate-100 opacity-70" : "bg-white"}`}>
                      <div>{taskName(item)}</div>
                      <button type="button" onClick={() => toggleHidden(group, idx)} className="rounded-xl border px-3 py-2 text-sm font-semibold">{taskHidden(item) ? "Unhide" : "Hide"}</button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function SettingsView({ family, setFamily, resetCheckboxesOnly, rebuildTrip, resetAppData, exportBackup, importBackup, user, onSignOut }) {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🙂");
  const [backupMessage, setBackupMessage] = useState("");
  const fileInputRef = useRef(null);

  const handleImportFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setBackupMessage("");
    try {
      await importBackup(file);
      setBackupMessage("Backup imported. It will sync automatically when online.");
    } catch (error) {
      console.error("Backup import failed", error);
      setBackupMessage(error?.message || "Backup import failed.");
    } finally {
      event.target.value = "";
    }
  };

  const addMember = () => {
    if (!name.trim()) return;
    setFamily((prev) => [...prev, { id: uid("person"), name: name.trim(), emoji, items: [] }]);
    setName(""); setEmoji("🙂");
  };
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <h2 className="mb-4 text-xl font-bold">Family Members</h2>
        <div className="mb-4 grid gap-2 sm:grid-cols-[80px_1fr_auto]">
          <input className="rounded-2xl border px-4 py-2 text-center" value={emoji} onChange={(e) => setEmoji(e.target.value)} />
          <input className="rounded-2xl border px-4 py-2" value={name} onChange={(e) => setName(e.target.value)} placeholder="Add family member" />
          <button type="button" onClick={addMember} className="rounded-2xl bg-slate-900 px-4 text-white"><Plus size={18} /></button>
        </div>
        <div className="space-y-2">
          {family.map((m) => (
            <div key={m.id} className="grid gap-2 rounded-2xl border p-3 sm:grid-cols-[80px_1fr_auto]">
              <input className="rounded-xl border px-3 py-2 text-center" value={m.emoji} onChange={(e) => setFamily((prev) => prev.map((x) => x.id === m.id ? { ...x, emoji: e.target.value } : x))} />
              <input className="rounded-xl border px-3 py-2" value={m.name} onChange={(e) => setFamily((prev) => prev.map((x) => x.id === m.id ? { ...x, name: e.target.value } : x))} />
              <button type="button" onClick={() => setFamily((prev) => prev.filter((x) => x.id !== m.id))} className="rounded-xl border p-2"><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
      </Card>
      <div className="space-y-4">
        <Card>
          <h2 className="mb-2 text-xl font-bold">Trip Reset & Template Updates</h2>
          <p className="mb-4 text-sm text-slate-600">Reset checkboxes keeps trip-specific additions. Rebuild from template removes trip-only checklist additions.</p>
          <div className="space-y-2">
            <button type="button" onClick={resetCheckboxesOnly} className="w-full rounded-2xl bg-slate-900 px-4 py-3 font-semibold text-white">Reset checkboxes / N/A only</button>
            <button type="button" onClick={rebuildTrip} className="w-full rounded-2xl border bg-white px-4 py-3 font-semibold">Rebuild trip lists from template</button>
            <button type="button" onClick={resetAppData} className="w-full rounded-2xl border border-red-200 bg-red-50 px-4 py-3 font-semibold text-red-700">Clear saved data / reset app</button>
          </div>
        </Card>
        <Card>
          <h2 className="mb-2 text-xl font-bold">Backup / Export</h2>
          <p className="mb-4 text-sm text-slate-600">Export a JSON backup of this device's current CampReady data, or import a saved backup file.</p>
          <div className="space-y-2">
            <button type="button" onClick={exportBackup} className="w-full rounded-2xl bg-slate-900 px-4 py-3 font-semibold text-white">Export backup JSON</button>
            <button type="button" onClick={() => fileInputRef.current?.click()} className="w-full rounded-2xl border bg-white px-4 py-3 font-semibold">Import backup JSON</button>
            <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden" onChange={handleImportFile} />
          </div>
          {backupMessage && <p className="mt-3 text-sm text-slate-600">{backupMessage}</p>}
        </Card>
        <PostTripReview />
        {user && (
          <Card>
            <h2 className="mb-2 text-xl font-bold">Account</h2>
            <p className="mb-4 text-sm text-slate-600">Signed in as <span className="font-semibold">{user.email}</span>. Your data syncs automatically across devices.</p>
            <button type="button" onClick={onSignOut} className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 font-semibold text-slate-700 hover:bg-slate-50">Sign out</button>
          </Card>
        )}
      </div>
    </div>
  );
}

function PostTripReview() {
  return (
    <Card>
      <h2 className="mb-2 text-xl font-bold">Post-Trip Review Prototype</h2>
      <p className="mb-4 text-sm text-slate-600">Capture what should change next time.</p>
      {["Forgot / Need next time","Used a lot / Keep packing","Did not use / Consider removing"].map((label) => (
        <Field key={label} label={label}><textarea className="mb-3 min-h-20 w-full rounded-2xl border px-4 py-2" /></Field>
      ))}
    </Card>
  );
}
