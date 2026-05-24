/**
 * mergeState.js — CRDT-style field-level merge for CampReady
 *
 * Design rules:
 *   Additions  → union  (items added on any device are always kept)
 *   Booleans   → OR     (checked/packed on any device stays checked)
 *   Edits      → newer overall document timestamp wins per-section
 *   Deletions  → additions win (safest default; a stale item beats lost work)
 *   UI state   → always local (don't jump tabs on the user mid-session)
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function mergeStates(local, cloud) {
  if (!local) return cloud;
  if (!cloud) return local;

  const localTime = local.lastModified || 0;
  const cloudTime = cloud.lastModified || 0;

  return {
    lastModified: Math.max(localTime, cloudTime),

    // ── UI / navigation — never change on the user ────────────────────────
    activeTab:       local.activeTab,
    activeChecklist: local.activeChecklist,
    activeMember:    local.activeMember,
    activeTripId:    local.activeTripId,

    // ── Trip metadata ─────────────────────────────────────────────────────
    trip:        newerWins(local.trip, cloud.trip, localTime, cloudTime),
    trips:       mergeById(local.trips, cloud.trips, localTime, cloudTime),
    appTemplate: newerWins(local.appTemplate, cloud.appTemplate, localTime, cloudTime),

    // ── Checklists — OR merge for booleans, union for additions ──────────
    tasks: mergeTasks(local.tasks, cloud.tasks),

    // ── Family packing — merge members by ID, items by name ──────────────
    family: mergeFamily(local.family, cloud.family, localTime, cloudTime),

    // ── Food / shopping ───────────────────────────────────────────────────
    recipes:             mergeById(local.recipes, cloud.recipes, localTime, cloudTime),
    selectedMeals:       unionPrimitives(local.selectedMeals, cloud.selectedMeals),
    manualShoppingItems: mergeById(local.manualShoppingItems, cloud.manualShoppingItems, localTime, cloudTime),
    shoppingChecks:      mergeChecks(local.shoppingChecks, cloud.shoppingChecks),

    // ── Maintenance ───────────────────────────────────────────────────────
    maintenanceItems: mergeById(
      local.maintenanceItems, cloud.maintenanceItems, localTime, cloudTime
    ),

    // ── RV configuration ──────────────────────────────────────────────────
    rvConfig:   newerWins(local.rvConfig,   cloud.rvConfig,   localTime, cloudTime),
    towVehicle: newerWins(local.towVehicle, cloud.towVehicle, localTime, cloudTime),
    rvNotes:    mergeById(local.rvNotes, cloud.rvNotes, localTime, cloudTime),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Scalar object: whichever document has the newer lastModified wins entirely. */
function newerWins(a, b, timeA, timeB) {
  return timeA >= timeB ? a : b;
}

// ── Checklists ────────────────────────────────────────────────────────────

/**
 * Merge the nested tasks structure:
 *   tasks[sectionKey][groupName] = Task[]
 *
 * Per task (matched by ID):
 *   done = A.done || B.done           (OR — once checked, stays checked)
 *   na   = !done && (A.na || B.na)    (OR — but done beats na)
 *
 * Tasks present on only one device are included (union).
 * NOTE: tasks are template-derived so we don't need timestamp preference —
 * the only meaningful per-task changes are the boolean flags (OR-merged above).
 */
function mergeTasks(tasksA, tasksB) {
  if (!tasksA) return tasksB || {};
  if (!tasksB) return tasksA;

  const result = {};
  const allSections = new Set([...Object.keys(tasksA), ...Object.keys(tasksB)]);

  for (const sectionKey of allSections) {
    const sA = tasksA[sectionKey] || {};
    const sB = tasksB[sectionKey] || {};
    result[sectionKey] = {};

    const allGroups = new Set([...Object.keys(sA), ...Object.keys(sB)]);
    for (const groupName of allGroups) {
      result[sectionKey][groupName] = mergeTaskGroup(
        sA[groupName] || [],
        sB[groupName] || []
      );
    }
  }

  return result;
}

function mergeTaskGroup(groupA, groupB) {
  const map = new Map(groupA.map((t) => [t.id, { ...t }]));

  for (const item of groupB) {
    if (map.has(item.id)) {
      const existing = map.get(item.id);
      const done = existing.done || item.done;
      const na   = !done && (existing.na || item.na);
      map.set(item.id, { ...existing, done, na });
    } else {
      // Added on the other device while offline — keep it
      map.set(item.id, { ...item });
    }
  }

  return Array.from(map.values());
}

// ── Family packing ────────────────────────────────────────────────────────

/**
 * Merge family members by ID.
 *
 * For EXISTING members:
 *   - Scalar fields (name, emoji): newer document wins (so name changes propagate)
 *   - Packing items: merged by name with OR for packed flag
 *
 * NEW members (only on one device): always included (union).
 */
function mergeFamily(familyA, familyB, timeA = 0, timeB = 0) {
  if (!familyA) return familyB || [];
  if (!familyB) return familyA;

  const mapA = new Map(familyA.map((m) => [m.id, m]));
  const mapB = new Map(familyB.map((m) => [m.id, m]));
  const allIds = [...new Set([...mapA.keys(), ...mapB.keys()])];

  return allIds.map((id) => {
    const a = mapA.get(id);
    const b = mapB.get(id);
    if (!a) return b; // new on device B
    if (!b) return a; // new on device A

    // For scalar fields (name, emoji): newer document's version wins.
    // This ensures a name change on device A propagates to device B.
    const preferred = timeA >= timeB ? a : b;
    return {
      ...preferred,                              // name, emoji from newer device
      items: mergeFamilyItems(a.items, b.items), // items always OR-merged
    };
  });
}

function mergeFamilyItems(itemsA, itemsB) {
  if (!itemsA) return itemsB || [];
  if (!itemsB) return itemsA;

  // Items have no IDs — match by lowercase name.
  const mapA = new Map(itemsA.map((i) => [i.name.toLowerCase(), i]));
  const mapB = new Map(itemsB.map((i) => [i.name.toLowerCase(), i]));
  const allNames = [...new Set([...mapA.keys(), ...mapB.keys()])];

  return allNames.map((name) => {
    const a = mapA.get(name);
    const b = mapB.get(name);
    if (!a) return b;
    if (!b) return a;
    return {
      ...a,
      packed: a.packed || b.packed, // OR — once packed anywhere, stays packed
    };
  });
}

// ── Generic array merge by ID ─────────────────────────────────────────────

/**
 * Union of two arrays of objects with an `id` field.
 *
 * - Items only on one device: always included (union).
 * - Items on both devices: newer document's version of the item wins.
 *   This ensures edits (e.g. marking a maintenance item done, changing a
 *   recipe name) from one device propagate to the other.
 *
 * timeA / timeB are the overall document lastModified values; they determine
 * which device "owns" the edit on a given item when both have it.
 */
function mergeById(arrA, arrB, timeA = 0, timeB = 0) {
  if (!arrA) return arrB || [];
  if (!arrB) return arrA;

  const aIsNewer = timeA >= timeB;
  const primary   = aIsNewer ? arrA : arrB; // existing items: prefer this version
  const secondary = aIsNewer ? arrB : arrA;

  const map = new Map(primary.map((item) => [item.id, { ...item }]));
  for (const item of secondary) {
    if (!map.has(item.id)) {
      // Only exists on secondary device — union it in
      map.set(item.id, { ...item });
    }
    // Existing item: primary (newer document) version already in map, leave it.
  }
  return Array.from(map.values());
}

// ── Shopping checks ───────────────────────────────────────────────────────

/** OR merge: once checked on any device, stays checked. */
function mergeChecks(checksA, checksB) {
  const result = { ...(checksA || {}) };
  for (const [key, val] of Object.entries(checksB || {})) {
    result[key] = result[key] || val;
  }
  return result;
}

/** Union of two arrays of primitive values (e.g. selectedMeals string IDs). */
function unionPrimitives(a, b) {
  return [...new Set([...(a || []), ...(b || [])])];
}
