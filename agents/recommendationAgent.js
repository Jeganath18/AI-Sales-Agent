// agents/recommendationAgent.js
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const fs = require('fs');
const path = require('path');

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

/**
 * gRPC Search implementation
 * Handles product, type, gender, and availability
 */
function Search(call, callback) {
  const { q = '', type, gender, qty = 1, offset = 0, limit = 3 } = call.request;

  console.log(`🔍 RecommendationAgent Search request ->`, call.request);

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const inv = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));

  let results = catalog.products;

  // 1️⃣ Filter by search query
  if (q) {
    results = results.filter((p) =>
      p.name.toLowerCase().includes(q.toLowerCase())
    );
  }

  // 2️⃣ Normalize shoe types
  const validTypes = ['formal', 'casual', 'chappal', 'flipflop', 'slipper', 'sports'];
  if (type && validTypes.includes(type.toLowerCase())) {
    results = results.filter((p) => p.type.toLowerCase() === type.toLowerCase());
  }

  // 3️⃣ Filter by gender
  if (gender) {
    results = results.filter(
      (p) =>
        p.gender.toLowerCase() === gender.toLowerCase() ||
        p.gender.toLowerCase() === 'unisex'
    );
  }

  // 4️⃣ Availability check
  results = results.map((p) => {
    const item = inv.items.find((i) => i.sku === p.sku);
    const totalQty = (item?.storeQty || 0) + (item?.stockroomQty || 0);
    return { ...p, available: totalQty >= qty };
  });

  // 5️⃣ Pagination: first 'limit' items starting at 'offset'
  const pagedResults = results.slice(offset, offset + limit);
  const moreAvailable = offset + limit < results.length;

  callback(null, {
    ok: true,
    products: pagedResults,
    moreAvailable,
    message: pagedResults.length
      ? `Showing ${pagedResults.length} of ${results.length} matching items.`
      : 'No products found.',
  });
}

const server = new grpc.Server();
server.addService(proto.RecommendationService.service, { Search });

server.bindAsync('0.0.0.0:50052', grpc.ServerCredentials.createInsecure(), () => {
  server.start();
  console.log('🧠 RecommendationAgent running on port 50052');
});
