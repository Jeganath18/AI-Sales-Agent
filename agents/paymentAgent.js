// agents/paymentAgent.js
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

const PROTO_PATH = path.join(__dirname, '../proto/agents.proto');

// Load proto
const pkgDef = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
const proto = grpc.loadPackageDefinition(pkgDef).agents;

// ==============================
// 1️⃣ gRPC handler
// ==============================
function ProcessPayment(call, callback) {
  const { orderId, amount, method } = call.request;
  console.log(`💰 Simulated payment for order ${orderId} via ${method}`);
  callback(null, {
    ok: true,
    confirmation: `Payment simulated. Please complete on Google Pay.`
  });
}

// ==============================
// 2️⃣ Export a startup function
// ==============================
function startPaymentAgent(port = 50053) {
  const server = new grpc.Server();
  server.addService(proto.PaymentService.service, { ProcessPayment });

  server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), () => {
    server.start();
    console.log(`💳 PaymentAgent running on ${port}`);
  });
}

module.exports = { startPaymentAgent, ProcessPayment };
