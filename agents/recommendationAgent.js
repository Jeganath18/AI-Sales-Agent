// agents/recommendationAgent.js
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const fs = require('fs');
const path = require('path');

// ==============================
// Local embeddings (RAG)
// ==============================
const { pipeline } = require('@xenova/transformers');

let cachedEmbeddings = null;
let embedder = null;

// ------------------------------
// Load embedding model ONCE
// ------------------------------
async function getEmbedder() {
  if (!embedder) {
    embedder = await pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2'
    );
  }
  return embedder;
}

async function embedText(texts) {
  const model = await getEmbedder();
  const output = await model(texts, {
    pooling: 'mean',
    normalize: true
  });
  return output.tolist();
}

// ==============================
// Paths & Proto
// ==============================
const PROTO_PATH = path.join(__dirname, '../proto/agents.proto');
const CATALOG_PATH = path.join(__dirname, '../data/productCatalog.json');
const INVENTORY_PATH = path.join(__dirname, '../data/inventory.json');

const pkgDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});

const proto = grpc.loadPackageDefinition(pkgDef).agents;

// ==============================
// Product & Gender Knowledge
// ==============================
const PRODUCT_TYPE_SYNONYMS = {
  slipper: ['slipper', 'slippers', 'house shoe', 'indoor'],
  flipflop: ['flipflop', 'flip flop', 'flip-flop', 'rubber chappal', 'hawai', 'chappal', 'sandals'],
  casual: ['casual', 'daily wear', 'walking', 'sneaker'],
  formal: ['formal', 'office', 'business', 'dress'],
  sports: ['sports', 'running', 'gym', 'workout', 'athletic']
};

const GENDER_SYNONYMS = {
  male: ['male', 'boy', 'boys', 'man', 'men', 'gents'],
  female: ['female', 'girl', 'girls', 'woman', 'women', 'ladies'],
  unisex: ['unisex', 'any', 'all']
};

// ==============================
// Intent Extraction (KEY PART)
// ==============================
function extractIntent(query) {
  if (!query) return {};

  const q = query.toLowerCase();

  let inferredType = null;
  let inferredGender = null;

  for (const [type, synonyms] of Object.entries(PRODUCT_TYPE_SYNONYMS)) {
    if (synonyms.some(s => q.includes(s))) {
      inferredType = type;
      break;
    }
  }

  for (const [gender, synonyms] of Object.entries(GENDER_SYNONYMS)) {
    if (synonyms.some(s => q.includes(s))) {
      inferredGender = gender;
      break;
    }
  }

  return { inferredType, inferredGender };
}

function normalizeType(type) {
  if (!type) return null;
  return type.toLowerCase();
}

function normalizeGender(gender) {
  if (!gender) return null;
  return gender.toLowerCase();
}

// ==============================
// Build catalog embeddings ONCE
// ==============================
async function buildProductEmbeddings() {
  if (cachedEmbeddings) return cachedEmbeddings;

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));

  const texts = catalog.products.map(
    p => `${p.name} ${p.type} ${p.gender} ${p.description || ''}`
  );

  const vectors = await embedText(texts);

  cachedEmbeddings = vectors.map((vector, i) => ({
    vector,
    product: catalog.products[i]
  }));

  return cachedEmbeddings;
}

// ==============================
// Cosine similarity
// ==============================
function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ==============================
// 1️⃣ gRPC Search (FINAL RAG FLOW)
// ==============================
async function Search(call, callback) {
  const { q = '', qty = 1, offset = 0, limit = 3 } = call.request;

  try {
    const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));

    // 🧠 Step 1: Intent extraction
    const { inferredType, inferredGender } = extractIntent(q);

    console.log('🧠 Intent:', { inferredType, inferredGender });

    // 🤖 Step 2: Semantic retrieval (RAG)
    let rankedProducts = catalog.products;

    if (q) {
      const embeddings = await buildProductEmbeddings();
      const [qVector] = await embedText([q]);

      rankedProducts = embeddings
        .map(e => ({
          score: cosineSimilarity(qVector, e.vector),
          product: e.product
        }))
        .sort((a, b) => b.score - a.score)
        .map(r => r.product);
    }

    // 🎯 Step 3: Hard filters
    if (inferredType) {
      rankedProducts = rankedProducts.filter(
        p => normalizeType(p.type) === inferredType
      );
    }

    if (inferredGender) {
      rankedProducts = rankedProducts.filter(
        p =>
          normalizeGender(p.gender) === inferredGender ||
          normalizeGender(p.gender) === 'unisex'
      );
    }

    // 📦 Step 4: Availability
    rankedProducts = rankedProducts.map(p => {
      const item = inventory.items.find(i => i.sku === p.sku);
      const totalQty = (item?.storeQty || 0) + (item?.stockroomQty || 0);
      return { ...p, available: totalQty >= qty };
    });

    // 📄 Step 5: Pagination
    const paged = rankedProducts.slice(offset, offset + limit);

    callback(null, {
      ok: true,
      products: paged,
      moreAvailable: offset + limit < rankedProducts.length,
      message: paged.length
        ? `Showing ${paged.length} of ${rankedProducts.length} items`
        : 'No products found'
    });

  } catch (err) {
    console.error('❌ Recommendation error:', err);
    callback(err);
  }
}

// ==============================
// 2️⃣ Start gRPC server
// ==============================
function startRecommendationAgent(port = 50051) {
  const server = new grpc.Server();
  server.addService(proto.RecommendationService.service, { Search });

  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    () => {
      server.start();
      console.log(`🧠 RecommendationAgent running on port ${port}`);
    }
  );
}

module.exports = { startRecommendationAgent, Search };
