// Local-first, item-aware sync helpers for CampReady.
// The UI can keep using normal React state while this layer adds lightweight
// metadata that lets offline edits merge at the smallest practical unit.

const META_KEY = "__sync";
const UPDATED_AT_KEY = "_updatedAt";
const FIELDS_KEY = "_fieldsUpdatedAt";
const DELETED_KEY = "deleted";

const META_FIELDS = new Set([META_KEY, UPDATED_AT_KEY, FIELDS_KEY, "lastModified"]);

export function getClientId() {
  if (typeof window === "undefined") return "server";
  const key = "campready-client-id";
  let id = window.localStorage.getItem(key);
  if (!id) {
    id = `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    window.localStorage.setItem(key, id);
  }
  return id;
}

export function prepareStateForSave(previousState, nextState, clientId = getClientId(), now = Date.now()) {
  const previous = previousState || {};
  const meta = mergeSyncMeta(previous[META_KEY], nextState[META_KEY]);
  meta.clientId = clientId;
  meta.updatedAt = now;
  meta[DELETED_KEY] = meta[DELETED_KEY] || {};

  const prepared = annotateValue(previous, nextState, "root", meta, now);
  prepared[META_KEY] = meta;
  prepared.lastModified = now;
  return prepared;
}

export function mergeStates(localState, cloudState) {
  if (!localState) return cloudState || null;
  if (!cloudState) return localState || null;

  const localMeta = localState[META_KEY] || {};
  const cloudMeta = cloudState[META_KEY] || {};
  const mergedMeta = mergeSyncMeta(localMeta, cloudMeta);
  const merged = mergeValue(localState, cloudState, "root", localMeta, cloudMeta);

  merged[META_KEY] = mergedMeta;
  merged.lastModified = Math.max(
    Number(localState.lastModified) || Number(localMeta.updatedAt) || 0,
    Number(cloudState.lastModified) || Number(cloudMeta.updatedAt) || 0,
    Number(mergedMeta.updatedAt) || 0
  );
  return merged;
}

function annotateValue(previous, next, path, meta, now) {
  if (Array.isArray(next)) return annotateArray(Array.isArray(previous) ? previous : [], next, path, meta, now);
  if (isPlainObject(next)) return annotateObject(isPlainObject(previous) ? previous : {}, next, path, meta, now);
  return next;
}

function annotateArray(previousArray, nextArray, path, meta, now) {
  if (!isObjectArray(nextArray) && !isObjectArray(previousArray)) {
    return deepEqual(stripMeta(previousArray), stripMeta(nextArray)) ? nextArray : nextArray;
  }

  const previousMap = toItemMap(previousArray);
  const nextMap = toItemMap(nextArray);
  const deletedForPath = meta[DELETED_KEY][path] || {};

  for (const [key, previousItem] of previousMap.entries()) {
    if (!nextMap.has(key)) {
      deletedForPath[key] = Math.max(deletedForPath[key] || 0, getItemTime(previousItem, 0), now);
    }
  }

  if (Object.keys(deletedForPath).length) meta[DELETED_KEY][path] = deletedForPath;

  return nextArray.map((item, index) => {
    if (!isPlainObject(item)) return item;
    const key = itemKey(item, index);
    const previousItem = previousMap.get(key) || {};
    const childPath = `${path}/${key}`;
    const annotated = annotateObject(previousItem, item, childPath, meta, now);
    if (!previousMap.has(key)) {
      annotated[UPDATED_AT_KEY] = Math.max(annotated[UPDATED_AT_KEY] || 0, now);
    }
    return annotated;
  });
}

function annotateObject(previous, next, path, meta, now) {
  const result = { ...next };
  const fields = { ...(previous[FIELDS_KEY] || {}), ...(next[FIELDS_KEY] || {}) };
  let objectChanged = false;

  for (const key of Object.keys(next)) {
    if (META_FIELDS.has(key)) continue;
    const previousValue = previous[key];
    const nextValue = next[key];

    if (Array.isArray(nextValue) || isPlainObject(nextValue)) {
      result[key] = annotateValue(previousValue, nextValue, `${path}.${key}`, meta, now);
      if (!deepEqual(stripMeta(previousValue), stripMeta(nextValue))) objectChanged = true;
    } else if (!deepEqual(previousValue, nextValue)) {
      fields[key] = now;
      objectChanged = true;
    }
  }

  for (const key of Object.keys(previous || {})) {
    if (!META_FIELDS.has(key) && !(key in next)) objectChanged = true;
  }

  if (Object.keys(fields).length) result[FIELDS_KEY] = fields;
  result[UPDATED_AT_KEY] = objectChanged
    ? Math.max(Number(previous[UPDATED_AT_KEY]) || 0, Number(next[UPDATED_AT_KEY]) || 0, now)
    : Math.max(Number(previous[UPDATED_AT_KEY]) || 0, Number(next[UPDATED_AT_KEY]) || 0);

  return result;
}

function mergeValue(local, cloud, path, localMeta, cloudMeta) {
  if (Array.isArray(local) || Array.isArray(cloud)) {
    return mergeArray(Array.isArray(local) ? local : [], Array.isArray(cloud) ? cloud : [], path, localMeta, cloudMeta);
  }

  if (isPlainObject(local) || isPlainObject(cloud)) {
    return mergeObject(isPlainObject(local) ? local : {}, isPlainObject(cloud) ? cloud : {}, path, localMeta, cloudMeta);
  }

  return getRootTime(localMeta) >= getRootTime(cloudMeta) ? local : cloud;
}

function mergeObject(local, cloud, path, localMeta, cloudMeta) {
  const result = {};
  const keys = new Set([...Object.keys(local || {}), ...Object.keys(cloud || {})]);
  keys.delete(META_KEY);
  keys.delete("lastModified");

  const localFields = local[FIELDS_KEY] || {};
  const cloudFields = cloud[FIELDS_KEY] || {};
  const mergedFields = { ...localFields, ...cloudFields };

  for (const key of keys) {
    if (key === UPDATED_AT_KEY || key === FIELDS_KEY) continue;
    const localValue = local[key];
    const cloudValue = cloud[key];

    if (Array.isArray(localValue) || Array.isArray(cloudValue) || isPlainObject(localValue) || isPlainObject(cloudValue)) {
      result[key] = mergeValue(localValue, cloudValue, `${path}.${key}`, localMeta, cloudMeta);
      continue;
    }

    const localTime = getFieldTime(local, localFields, key, localMeta);
    const cloudTime = getFieldTime(cloud, cloudFields, key, cloudMeta);

    // Checklist booleans need true field-level last-write-wins. Do not let a
    // newer root/object timestamp from another device overwrite an older device's
    // explicit checkbox/N/A edit. Legacy records with no field metadata still OR
    // together to avoid losing checked/N/A work during migration.
    if (isTaskBooleanField(key, local, cloud)) {
      const hasLocalFieldTime = Number(localFields[key]) || 0;
      const hasCloudFieldTime = Number(cloudFields[key]) || 0;
      if (hasLocalFieldTime || hasCloudFieldTime) {
        if (hasLocalFieldTime >= hasCloudFieldTime) {
          result[key] = localValue;
          mergedFields[key] = hasLocalFieldTime;
        } else {
          result[key] = cloudValue;
          mergedFields[key] = hasCloudFieldTime;
        }
      } else {
        result[key] = Boolean(localValue || cloudValue);
        mergedFields[key] = Math.max(localTime, cloudTime);
      }
      continue;
    }

    // Data-loss guard: protect existing values from blank defaults introduced
    // by app/schema upgrades, but still allow an explicit newer user edit that
    // clears a field. This fixes inputs that appeared to re-populate after a
    // user deleted their text/value.
    if (isBlankValue(localValue) && hasMeaningfulValue(cloudValue) && localTime <= cloudTime) {
      result[key] = cloudValue;
      mergedFields[key] = cloudTime || localTime;
    } else if (isBlankValue(cloudValue) && hasMeaningfulValue(localValue) && cloudTime <= localTime) {
      result[key] = localValue;
      mergedFields[key] = localTime || cloudTime;
    } else if (localTime >= cloudTime) {
      result[key] = localValue;
      mergedFields[key] = localTime;
    } else {
      result[key] = cloudValue;
      mergedFields[key] = cloudTime;
    }
  }

  if (Object.keys(mergedFields).length) result[FIELDS_KEY] = mergedFields;
  result[UPDATED_AT_KEY] = Math.max(
    Number(local[UPDATED_AT_KEY]) || 0,
    Number(cloud[UPDATED_AT_KEY]) || 0,
    ...Object.values(mergedFields).map((v) => Number(v) || 0)
  );
  return result;
}

function mergeArray(localArray, cloudArray, path, localMeta, cloudMeta) {
  if (!isObjectArray(localArray) && !isObjectArray(cloudArray)) {
    return getRootTime(localMeta) >= getRootTime(cloudMeta) ? localArray : cloudArray;
  }

  const localMap = toItemMap(localArray);
  const cloudMap = toItemMap(cloudArray);
  const keys = new Set([...localMap.keys(), ...cloudMap.keys()]);
  const localDeleted = localMeta?.[DELETED_KEY]?.[path] || {};
  const cloudDeleted = cloudMeta?.[DELETED_KEY]?.[path] || {};
  const resultMap = new Map();

  for (const key of keys) {
    const localItem = localMap.get(key);
    const cloudItem = cloudMap.get(key);
    const deletedAt = Math.max(Number(localDeleted[key]) || 0, Number(cloudDeleted[key]) || 0);

    let mergedItem;
    if (localItem && cloudItem) {
      mergedItem = mergeObject(localItem, cloudItem, `${path}/${key}`, localMeta, cloudMeta);
    } else {
      mergedItem = localItem || cloudItem;
    }

    // Deletions are item-level. Do not let an unrelated newer root document
    // timestamp resurrect an older copy of this item from another device.
    // Only a newer edit to the same item should beat a tombstone.
    const itemTime = getItemTime(mergedItem, 0);
    if (deletedAt && deletedAt >= itemTime) continue;
    resultMap.set(key, mergedItem);
  }

  const preferredOrder = getRootTime(localMeta) >= getRootTime(cloudMeta) ? localArray : cloudArray;
  const secondaryOrder = preferredOrder === localArray ? cloudArray : localArray;
  const ordered = [];
  const seen = new Set();

  for (const item of [...preferredOrder, ...secondaryOrder]) {
    const key = isPlainObject(item) ? itemKey(item) : null;
    if (key && resultMap.has(key) && !seen.has(key)) {
      ordered.push(resultMap.get(key));
      seen.add(key);
    }
  }

  for (const [key, item] of resultMap.entries()) {
    if (!seen.has(key)) ordered.push(item);
  }

  return ordered;
}


function getFieldTime(object, fields, key, meta) {
  return Number(fields?.[key]) || Number(object?.[UPDATED_AT_KEY]) || getRootTime(meta);
}

function isTaskBooleanField(key, local, cloud) {
  if (key !== "done" && key !== "na" && key !== "packed") return false;
  const source = isPlainObject(local) ? local : cloud;
  // Checklist rows and packing rows both have a stable display name plus boolean
  // state. Applying field-level timestamp rules here prevents stale false values
  // from another device from reverting a newer checked/N/A/packed edit.
  return isPlainObject(source) && typeof source.name === "string";
}

function isBlankValue(value) {
  return value === "" || value === null || value === undefined;
}

function hasMeaningfulValue(value) {
  return !isBlankValue(value);
}

function mergeSyncMeta(a = {}, b = {}) {
  const deleted = {};
  for (const source of [a[DELETED_KEY] || {}, b[DELETED_KEY] || {}]) {
    for (const [path, entries] of Object.entries(source)) {
      deleted[path] = deleted[path] || {};
      for (const [key, timestamp] of Object.entries(entries || {})) {
        deleted[path][key] = Math.max(Number(deleted[path][key]) || 0, Number(timestamp) || 0);
      }
    }
  }

  return {
    schemaVersion: 2,
    clientId: a.clientId || b.clientId || getClientId(),
    updatedAt: Math.max(Number(a.updatedAt) || 0, Number(b.updatedAt) || 0),
    [DELETED_KEY]: deleted,
  };
}

function getRootTime(meta) {
  return Number(meta?.updatedAt) || 0;
}

function getItemTime(item, fallback = 0) {
  if (!isPlainObject(item)) return fallback;
  return Math.max(
    Number(item[UPDATED_AT_KEY]) || 0,
    ...Object.values(item[FIELDS_KEY] || {}).map((v) => Number(v) || 0),
    fallback
  );
}

function toItemMap(array) {
  const map = new Map();
  (array || []).forEach((item, index) => {
    if (isPlainObject(item)) map.set(itemKey(item, index), item);
  });
  return map;
}

function itemKey(item, index = 0) {
  if (item.id !== undefined && item.id !== null) return `id:${item.id}`;
  if (item.key !== undefined && item.key !== null) return `key:${item.key}`;
  if (item.name !== undefined && item.name !== null) return `name:${String(item.name).trim().toLowerCase()}`;
  return `idx:${index}`;
}

function isObjectArray(value) {
  return Array.isArray(value) && value.some((item) => isPlainObject(item));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function stripSyncMetadata(value) {
  return stripMeta(value);
}

function stripMeta(value) {
  if (Array.isArray(value)) return value.map(stripMeta);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (!META_FIELDS.has(key)) out[key] = stripMeta(child);
  }
  return out;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
