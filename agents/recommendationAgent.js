// agents/recommendationAgent.js
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const fs = require('fs');
const path = require('path');

// local embeddings
const { pipeline } = require('@xenova/transformers');

let cachedEmbeddings = null;
let embedder = null;

// ==============================
// Embedding utilities (RAG)
// ==============================
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
  oneofs: true,
});

const proto = grpc.loadPackageDefinition(pkgDef).agents;

// ==============================
// Build product embeddings (RAG)
// ==============================
async function buildProductEmbeddings(catalog) {
  if (cachedEmbeddings) return cachedEmbeddings;

  const texts = catalog.products.map(
    p =>
      `${p.name} ${p.type} ${p.gender} ${p.description || ''} price ${p.price}`
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
  let dot = 0,
    magA = 0,
    magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ==============================
// Enhanced Mapping & Normalization
// ==============================
const PRODUCT_TYPE_SYNONYMS = {
  formal: ['formal', 'office', 'business', 'dress', 'oxford', 'loafer'],
  casual: ['casual', 'everyday', 'sneaker', 'sneakers', 'trainer', 'trainers', 'walking'],
  sports: ['sports', 'sport', 'running', 'athletic', 'gym', 'workout', 'jogger', 'joggers'],
  flipflop: ['flipflop', 'flip-flop', 'flip flop', 'flipflops', 'flip-flops', 'flip flops', 'thong', 'thongs', 'sandal', 'sandals', 'chappal', 'chappals'],
  slipper: ['slipper', 'slippers', 'house shoe', 'house shoes', 'indoor']
};

const GENDER_SYNONYMS = {
  male: ['male', 'boy', 'man', 'men', 'guy', 'gents', 'gentleman'],
  female: ['female', 'girl', 'woman', 'women', 'lady', 'ladies', 'gal'],
  unisex: ['unisex', 'any', 'both', 'all']
};

/**
 * Normalize product type with fuzzy matching
 */
function normalizeProductType(input) {
  if (!input) return null;
  
  const lowerInput = input.toLowerCase().trim();
  
  // Direct match first
  for (const [canonical, synonyms] of Object.entries(PRODUCT_TYPE_SYNONYMS)) {
    if (synonyms.includes(lowerInput)) {
      return canonical;
    }
  }
  
  // Partial match (for "flip-flops" in "I want flip-flops")
  for (const [canonical, synonyms] of Object.entries(PRODUCT_TYPE_SYNONYMS)) {
    for (const synonym of synonyms) {
      if (lowerInput.includes(synonym) || synonym.includes(lowerInput)) {
        return canonical;
      }
    }
  }
  
  // Return as-is if no match (let it filter naturally)
  return lowerInput;
}

/**
 * Normalize gender with fuzzy matching
 */
function normalizeGender(input) {
  if (!input) return null;
  
  const lowerInput = input.toLowerCase().trim();
  
  // Check synonyms
  for (const [canonical, synonyms] of Object.entries(GENDER_SYNONYMS)) {
    if (synonyms.includes(lowerInput)) {
      return canonical;
    }
  }
  
  // Return as-is if no match
  return lowerInput;
}

/**
 * Check if product matches type (handles variations)
 */
function matchesType(product, searchType) {
  if (!searchType) return true;
  
  const normalizedSearchType = normalizeProductType(searchType);
  const normalizedProductType = normalizeProductType(product.type);
  
  return normalizedSearchType === normalizedProductType;
}

/**
 * Check if product matches gender (inclusive of unisex)
 */
function matchesGender(product, searchGender) {
  if (!searchGender) return true;
  
  const normalizedSearchGender = normalizeGender(searchGender);
  const normalizedProductGender = normalizeGender(product.gender);
  
  // Unisex products match any gender
  if (normalizedProductGender === 'unisex') return true;
  
  // Exact match
  if (normalizedSearchGender === normalizedProductGender) return true;
  
  // If searching for unisex, only return unisex products
  if (normalizedSearchGender === 'unisex') {
    return normalizedProductGender === 'unisex';
  }
  
  return false;
}

// ==============================
// 1️⃣ gRPC Search implementation
// ==============================
async function Search(call, callback) {
  const { q = '', type, gender, qty = 1, offset = 0, limit = 3 } = call.request;
  console.log(call.request);

  console.log(`🔍 RecommendationAgent Search request ->`, {
    query:q,
    type,
    gender,
    qty,
    offset,
    limit
  });

  try {
    // Load data
    const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    const inv = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));

    console.log(`📦 Total products in catalog: ${catalog.products.length}`);

    let results = [...catalog.products]; // Clone array

    // Step 1: Filter by type first (most specific)
    if (q) {
      const beforeCount = results.length;
      results = results.filter(p => matchesType(p, q));
      console.log(`🏷️ Type filter (${type}): ${beforeCount} -> ${results.length} products`);
    }

    // Step 2: Filter by gender
    if (type) {
      const beforeCount = results.length;
      results = results.filter(p => matchesGender(p, type));
      console.log(`👤 Gender filter (${type}): ${beforeCount} -> ${results.length} products`);
    }

    // Step 3: Semantic search if query provided (RAG)
    if (q && q.trim().length > 0) {
      try {
        const scopedCatalog = { products: results };
        const embeddings = await buildProductEmbeddings(scopedCatalog);
        const [qVector] = await embedText([q]);

        const scoredResults = embeddings
          .map(e => ({
            score: cosineSimilarity(qVector, e.vector),
            product: e.product
          }))
          .sort((a, b) => b.score - a.score);

        console.log(`🤖 RAG search scores (top 5):`, 
          scoredResults.slice(0, 5).map(r => ({ 
            name: r.product.name, 
            score: r.score.toFixed(3) 
          }))
        );

        results = scoredResults.map(x => x.product);
      } catch (embeddingError) {
        console.warn('⚠️ Embedding search failed, using filtered results:', embeddingError.message);
        // Continue with filtered results
      }
    }

    // Step 4: Check availability
    results = results.map(p => {
      const item = inv.items.find(i => i.sku === p.sku);
      const totalQty = (item?.storeQty || 0) + (item?.stockroomQty || 0);
      return { 
        ...p, 
        available: totalQty >= qty,
        stock: totalQty 
      };
    });

    // Step 5: Sort by availability (available items first)
    results.sort((a, b) => {
      if (a.available && !b.available) return -1;
      if (!a.available && b.available) return 1;
      return 0;
    });

    console.log(`✅ Final results: ${results.length} products found`);
    
    if (results.length > 0) {
      console.log(`📋 First 3 results:`, 
        results.slice(0, 3).map(p => ({ 
          name: p.name, 
          type: p.type, 
          gender: p.gender,
          available: p.available 
        }))
      );
    }

    // Step 6: Pagination
    const pagedResults = results.slice(offset, offset + limit);
    const moreAvailable = offset + limit < results.length;

    callback(null, {
      ok: true,
      products: pagedResults,
      moreAvailable,
      message: pagedResults.length
        ? `Showing ${pagedResults.length} of ${results.length} matching items.`
        : 'No products found matching your criteria.',
    });

  } catch (error) {
    console.error('❌ Search error:', error);
    callback(null, {
      ok: false,
      products: [],
      moreAvailable: false,
      message: `Search failed: ${error.message}`,
    });
  }
}

// ==============================
// 2️⃣ Export a startup function
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