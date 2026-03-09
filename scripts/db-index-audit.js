#!/usr/bin/env node

require("dotenv").config();

const { MongoClient } = require("mongodb");
const config = require("../src/config");
const {
  ensureTenderCollectionIndexes,
  ensureEkapV3LogIndexes,
  TENDER_PRIMARY_SORT_INDEX,
  TENDER_PRIMARY_SORT_INDEX_NAME,
} = require("../src/dbIndexes");

const LOG_COLLECTION_NAME = process.env.EKAP_V3_LOG_COLLECTION || "ekap_v3_download_logs";

function collectIndexNamesFromPlan(plan, bucket = new Set()) {
  if (!plan || typeof plan !== "object") {
    return bucket;
  }

  if (plan.stage === "IXSCAN" && plan.indexName) {
    bucket.add(plan.indexName);
  }

  if (plan.inputStage) {
    collectIndexNamesFromPlan(plan.inputStage, bucket);
  }

  if (Array.isArray(plan.inputStages)) {
    for (const child of plan.inputStages) {
      collectIndexNamesFromPlan(child, bucket);
    }
  }

  if (Array.isArray(plan.shards)) {
    for (const shard of plan.shards) {
      collectIndexNamesFromPlan(shard.winningPlan, bucket);
    }
  }

  if (plan.queryPlan) {
    collectIndexNamesFromPlan(plan.queryPlan, bucket);
  }

  return bucket;
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const client = new MongoClient(config.mongodbUri);
  await client.connect();

  try {
    const db = client.db(config.mongodbDb);
    const tenderCollection = db.collection(config.mongodbCollection);
    const logCollection = db.collection(LOG_COLLECTION_NAME);

    await ensureTenderCollectionIndexes(tenderCollection);
    await ensureEkapV3LogIndexes(logCollection);

    const tenderIndexes = await tenderCollection.indexes();
    const logIndexes = await logCollection.indexes();
    const tenderIndexNames = new Set(tenderIndexes.map((item) => item.name));
    const logIndexNames = new Set(logIndexes.map((item) => item.name));

    assertCondition(tenderIndexNames.has("ikn_1"), "ikn_1 index bulunamadi.");
    assertCondition(
      tenderIndexNames.has(TENDER_PRIMARY_SORT_INDEX_NAME),
      `${TENDER_PRIMARY_SORT_INDEX_NAME} index bulunamadi.`,
    );
    assertCondition(
      !tenderIndexNames.has("updatedAt_-1"),
      "updatedAt_-1 index halen duruyor (gereksiz).",
    );
    assertCondition(
      !tenderIndexNames.has("sourceIhaleId_1"),
      "sourceIhaleId_1 index halen duruyor (gereksiz).",
    );

    assertCondition(logIndexNames.has("runId_1"), "runId_1 log index bulunamadi.");
    assertCondition(
      logIndexNames.has("startedAt_-1_createdAt_-1"),
      "startedAt_-1_createdAt_-1 log index bulunamadi.",
    );

    const q1 = await tenderCollection
      .find({})
      .sort(TENDER_PRIMARY_SORT_INDEX)
      .limit(20)
      .explain("queryPlanner");
    const q1Indexes = collectIndexNamesFromPlan(q1.queryPlanner?.winningPlan);
    assertCondition(
      q1Indexes.has(TENDER_PRIMARY_SORT_INDEX_NAME),
      "Q1 explain beklenen siralama indexini kullanmiyor.",
    );

    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const q2 = await tenderCollection
      .find({ updatedAt: { $gte: dayAgo, $lt: now } })
      .sort({ updatedAt: -1 })
      .limit(20)
      .explain("queryPlanner");
    const q2Indexes = collectIndexNamesFromPlan(q2.queryPlanner?.winningPlan);
    assertCondition(
      q2Indexes.has(TENDER_PRIMARY_SORT_INDEX_NAME),
      "Q2 explain beklenen updatedAt prefix indexini kullanmiyor.",
    );

    const q3 = await logCollection.find({ runId: "sample-run-id" }).limit(1).explain("queryPlanner");
    const q3Indexes = collectIndexNamesFromPlan(q3.queryPlanner?.winningPlan);
    assertCondition(q3Indexes.has("runId_1"), "Q3 explain runId_1 indexini kullanmiyor.");

    console.log("DB index audit basarili.");
    console.log(`- Tender indexes: ${[...tenderIndexNames].sort().join(", ")}`);
    console.log(`- Log indexes: ${[...logIndexNames].sort().join(", ")}`);
    console.log(`- Q1 plan indexes: ${[...q1Indexes].sort().join(", ")}`);
    console.log(`- Q2 plan indexes: ${[...q2Indexes].sort().join(", ")}`);
    console.log(`- Q3 plan indexes: ${[...q3Indexes].sort().join(", ")}`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("[DB_INDEX_AUDIT_ERROR]", error?.message || error);
  process.exit(1);
});
