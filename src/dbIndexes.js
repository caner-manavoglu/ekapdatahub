const TENDER_PRIMARY_SORT_INDEX = {
  updatedAt: -1,
  createdAt: -1,
  _id: -1,
};

const TENDER_PRIMARY_SORT_INDEX_NAME = "updatedAt_-1_createdAt_-1__id_-1";

async function dropIndexIfExists(collection, indexName) {
  try {
    await collection.dropIndex(indexName);
    return true;
  } catch (error) {
    if (error?.code === 27 || error?.codeName === "IndexNotFound") {
      return false;
    }
    throw error;
  }
}

async function ensureTenderCollectionIndexes(collection) {
  await collection.createIndex({ ikn: 1 }, { name: "ikn_1" });
  await collection.createIndex(TENDER_PRIMARY_SORT_INDEX, {
    name: TENDER_PRIMARY_SORT_INDEX_NAME,
  });

  // Legacy/redundant indexes from previous versions.
  await dropIndexIfExists(collection, "updatedAt_-1");
  await dropIndexIfExists(collection, "sourceIhaleId_1");
}

async function ensureEkapV3LogIndexes(collection) {
  await collection.createIndex({ startedAt: -1, createdAt: -1 }, { name: "startedAt_-1_createdAt_-1" });

  // _id already stores runId and is unique by default; keep schema/indexes aligned.
  await dropIndexIfExists(collection, "runId_1");
}

async function ensureAuditLogIndexes(collection) {
  await collection.createIndex({ createdAt: -1 }, { name: "createdAt_-1" });
  await collection.createIndex({ action: 1, createdAt: -1 }, { name: "action_1_createdAt_-1" });
  await collection.createIndex({ "actor.username": 1, createdAt: -1 }, { name: "actor_username_1_createdAt_-1" });
}

module.exports = {
  ensureTenderCollectionIndexes,
  ensureEkapV3LogIndexes,
  ensureAuditLogIndexes,
  TENDER_PRIMARY_SORT_INDEX,
  TENDER_PRIMARY_SORT_INDEX_NAME,
};
