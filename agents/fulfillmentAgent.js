// agents/fulfillmentAgent.js
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const fs = require('fs');
const path = require('path');

const PROTO_PATH = path.join(__dirname, '../proto/agents.proto');
const FULFILL_PATH = path.join(__dirname, '../data/fulfillments.json');

// Load proto
const pkgDef = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
const proto = grpc.loadPackageDefinition(pkgDef).agents;

// ==============================
// 1️⃣ gRPC handler
// ==============================
function CreateFulfillment(call, callback) {
  const data = call.request;
  console.log(data);
  const fulfillments = fs.existsSync(FULFILL_PATH)
    ? JSON.parse(fs.readFileSync(FULFILL_PATH, 'utf8'))
    : [];

  fulfillments.push({ ...data, createdAt: new Date().toISOString() });
  fs.writeFileSync(FULFILL_PATH, JSON.stringify(fulfillments, null, 2));

  console.log(`📦 Order ${data.orderId} saved to fulfillments.json`);
  callback(null, { ok: true, message: `Order ${data.orderId} saved` });
}

// ==============================
// 2️⃣ Export a startup function
// ==============================
function startFulfillmentAgent(port = 50051) {
  const server = new grpc.Server();
  server.addService(proto.FulfillmentService.service, { CreateFulfillment });

  server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), () => {
    server.start();
    console.log(`📦 FulfillmentAgent running on ${port}`);
  });
}

module.exports = { startFulfillmentAgent, CreateFulfillment };
