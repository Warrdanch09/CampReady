/**
 * mergeState.js — CRDT-style field-level merge for CampReady
 *
 * Design rules:
 *   Additions  → union  (items added on any device are kept)
 *   Booleans   → OR     (checked/packed on any device stays that way)
 *   Scalars    → newer lastModified timestamp wins
 *   Deletions  → additions win (safest default; a stale item is recoverable, lost work is not)
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
    // Always take the maximum so the merged document sorts as "most recent"
    lastModified: Math.max(localTime, cloudTime),

    // ── UI / navigation state ─────────────────────────────────────────────
    // Never let a sync operation disrupt the user's current view.
    activeTab:      local.activeTab,
    activeChecklist: local.activeChecklist,
    activeMember:   local.activeMember,
    activeTripId:   local.activeTripId,

    // ── Trip metadata ─────────────────────────────────────────────────────
    // Scalar blob — newer document's value wins.
    trip:        newerWins(local.trip, cloud.trip, localTime, cloudTime),
    trips:       mergeTrips(local.trips, cloud.trips),
    appTemplate: newerWins(local.appTemplate, cloud.appTemplate, localTime, cloudTime),

    // ── Checklists ────────────────────────────────────────────────────────
    // Items: union by ID. done/na flags: OR merge.
    tasks: mergeTasks(local.tasks, cloud.tasks),

    // ── Family packing ────────────────────────────────────────────────────
    // Members: union by ID. Items within each member: union by name, packed=OR.
    family: mergeFamily(local.family, cloud.family),

    // ── Food / shopping ───────────────────────────────────────────────────
    recipes:             mergeById(local.recipes, cloud.recipes),
    selectedMeals:       unionPrimitives(local.selectedMeals, cloud.selectedMeals),
    manualShoppingItems: mergeById(local.manualShoppingItems, cloud.manualShoppingItems),
    shoppingChecks:      mergeChecks(local.shoppingChecks, cloud.shoppingChecks),

    // ── Maintenance ───────────────────────────────────────────────────────
    // Union of items; scalar fields (lastDone, notes) from whichever is newer.
    maintenanceItems: mergeMaintenanceItems(
      local.maintenanceItems,
      cloud.maintenanceItems,
      localTime,
      cloudTime
    ),

    // ── RV configuration ──────────────────────────────────────────────────
    // Pure scalar blobs — newer timestamp wins for the whole object.
    rvConfig:   newerWins(local.rvConfig,   cloud.rvConfig,   localTime, cloudTime),
    towVehicle: newerWins(local.towVehicle, cloud.towVehicle, localTime, cloudTime),
    rvNotes:    mergeById(local.rvNotes, cloud.rvNotes),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Scalar object merge: whichever document is newer wins entirely. */
function newerWins(a, b, timeA, timeB) {
  return timeA >= timeB ? a : b;
}

// ── Checklists ────────────────────────────────────────────────────────────

/**
 * Merge the nested tasks object:
 *   tasks[sectionKey][groupName] = Task[]
 *
 * For each task matched by ID:
 *   done = A.done || B.done          (OR — once checked, stays checked)
 *   na   = !done && (A.na || B.na)   (OR — but done beats na)
 *
 * Tasks present on only one device are included (union).
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
 * Within each member, merge packing items by name (items lack IDs).
 *
 * packed = A.packed || B.packed  (OR — once packed anywhere, stays packed)
 */
function mergeFamily(familyA, familyB) {
  if (!familyA) return familyB || [];
  if (!familyB) return familyA;

  const mapA = new Map(familyA.map((m) => [m.id, m]));
  const mapB = new Map(familyB.map((m) => [m.id, m]));
  const allIds = [...new Set([...mapA.keys(), ...mapB.keys()])];

  return allIds.map((id) => {
    const a = mapA.get(id);
    const b = mapB.get(id);
    if (!a) return b;
    if (!b) return a;
    return {
      ...a,                                    // local wins for name/emoji edits
      items: mergeFamilyItems(a.items, b.items),
    };
  });
}

function mergeFamilyItems(itemsA, itemsB) {
  if (!itemsA) return itemsB || [];
  if (!itemsB) return itemsA;

  // Items have no IDs — match by lowercase name.
  // Note: renaming an item on one device while the other is offline will
  // result in both the old and new name appearing; this is the safe default.
  const mapA = new Map(itemsA.map((i) => [i.name.toLowerCase(), i]));
  const mapB = new Map(itemsB.map((i) => [i.name.toLowerCase(), i]));
  const allNames = [...new Set([...mapA.keys(), ...mapB.keys()])];

  return allNames.map((name) => {
    const a = mapA.get(name);
    const b = mapB.get(name);
    if (!a) return b;
    if (!b) return a;
    return {
      ...a,                         // local wins for qty edits
      packed: a.packed || b.packed, // OR — once packed on any device, stays packed
    };
  });
}

// ── Shopping checks ───────────────────────────────────────────────────────

/**
 * shoppingChecks is { [itemKey]: boolean }
 * OR merge: once checked on any device, stays checked.
 */
function mergeChecks(checksA, checksB) {
  const result = { ...(checksA || {}) };
  for (const [key, val] of Object.entries(checksB || {})) {
    result[key] = result[key] || val;
  }
  return result;
}

// ── Maintenance ───────────────────────────────────────────────────────────

/**
 * Maintenance items have IDs.
 * Union of items from both devices.
 * For the same item, whichever device's document is newer wins the scalar
 * fields (lastDone, notes, frequency) — this lets "Mark done today" propagate
 * correctly from whichever device tapped it most recently.
 */
function mergeMaintenanceItems(arrA, arrB, timeA, timeB) {
  if (!arrA) return arrB || [];
  if (!arrB) return arrA;

  const localIsNewer = timeA >= timeB;
  const primary   = localIsNewer ? arrA : arrB;
  const secondary = localIsNewer ? arrB : arrA;

  const map = new Map(primary.map((item) => [item.id, { ...item }]));
  for (const item of secondary) {
    if (!map.has(item.id)) {
      // Added on the other device — keep it
      map.set(item.id, { ...item });
    }
    // Existing item: primary (newer) version already in the map; leave it.
  }

  return Array.from(map.values());
}

// ── Generic helpers ───────────────────────────────────────────────────────

/**
 * Union of two arrays of objects with an `id` field.
 * Items present on only one device are included.
 * For matching IDs, local (A) version wins — callers that need a different
 * strategy (e.g. maintenance) use their own function above.
 */
function mergeById(arrA, arrB) {
  if (!arrA) return arrB || [];
  if (!arrB) return arrA;

  const map = new Map(arrA.map((item) => [item.id, item]));
  for (const item of arrB) {
    if (!map.has(item.id)) {
      map.set(item.id, item);
    }
    // Same ID exists locally: local version wins (could be improved with
    // per-item timestamps if finer-grained control is needed in the future).
  }
  return Array.from(map.values());
}

/**
 * Union of two arrays of primitive values (e.g. selectedMeals string IDs).
 */
function unionPrimitives(a, b) {
  return [...new Set([...(a || []), ...(b || [])])];
}

/**
 * Trips: union by ID (same as mergeById).
 * Status fields are not merged — whichever device created the record wins.
 */
function mergeTrips(tripsA, tripsB) {
  return mergeById(tripsA, tripsB);
}
