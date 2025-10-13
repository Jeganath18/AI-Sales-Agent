const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

const PROTO_PATH = path.join(__dirname, '../proto/agents.proto');
const pkgDef = protoLoader.loadSync(PROTO_PATH);
const proto = grpc.loadPackageDefinition(pkgDef).agents;

const clients = {
  inventory: new proto.InventoryService('localhost:50051', grpc.credentials.createInsecure()),
  recommendation: new proto.RecommendationService('localhost:50051', grpc.credentials.createInsecure()),
  payment: new proto.PaymentService('localhost:50051', grpc.credentials.createInsecure()),
  fulfillment: new proto.FulfillmentService('localhost:50051', grpc.credentials.createInsecure())
};

function checkInventory(sku, qty, pincode) {
  return new Promise((res, rej) => {
    clients.inventory.CheckInventory({ sku, qty, pincode }, (err, r) => (err ? rej(err) : res(r)));
  });
}

function searchProducts(q, type, qty) {
  return new Promise((res, rej) => {
    clients.recommendation.Search({ q, type, qty }, (err, r) => (err ? rej(err) : res(r)));
  });
}

function processPayment(orderId, amount, method) {
  return new Promise((res, rej) => {
    clients.payment.ProcessPayment({ orderId, amount, method }, (err, r) => (err ? rej(err) : res(r)));
  });
}

function createFulfillment(req) {
  return new Promise((res, rej) => {
    clients.fulfillment.CreateFulfillment(req, (err, r) => (err ? rej(err) : res(r)));
  });
}

module.exports = { checkInventory, searchProducts, processPayment, createFulfillment };
