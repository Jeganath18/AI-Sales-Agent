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

// ==============================
// 1️⃣ gRPC Search implementation
// ==============================
function Search(call, callback) {
  const { q = '', type, gender, qty = 1, offset = 0, limit = 3 } = call.request;

  console.log(`🔍 RecommendationAgent Search request ->`, call.request);

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const inv = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));

  let results = catalog.products;

  // Filter by search query
  if (q) {
    results = results.filter((p) =>
      p.name.toLowerCase().includes(q.toLowerCase())
    );
  }

  // Filter by type
  const validTypes = ['formal', 'casual', 'chappal', 'flipflop', 'slipper', 'sports'];
  if (type && validTypes.includes(type.toLowerCase())) {
    results = results.filter((p) => p.type.toLowerCase() === type.toLowerCase());
  }

  // Filter by gender
  if (gender) {
    results = results.filter(
      (p) =>
        p.gender.toLowerCase() === gender.toLowerCase() ||
        p.gender.toLowerCase() === 'unisex'
    );
  }

  // Availability check
  results = results.map((p) => {
    const item = inv.items.find((i) => i.sku === p.sku);
    const totalQty = (item?.storeQty || 0) + (item?.stockroomQty || 0);
    return { ...p, available: totalQty >= qty };
  });

  // Pagination
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

// ==============================
// 2️⃣ Export a startup function
// ==============================
function startRecommendationAgent(port = 50052) {
  const server = new grpc.Server();
  server.addService(proto.RecommendationService.service, { Search });

  server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), () => {
    server.start();
    console.log(`🧠 RecommendationAgent running on port ${port}`);
  });
}

module.exports = { startRecommendationAgent, Search };
