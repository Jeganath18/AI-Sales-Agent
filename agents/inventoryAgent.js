const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const fs = require('fs');
const path = require('path');

const PROTO_PATH = path.join(__dirname, '../proto/agents.proto');
const DATA_PATH = path.join(__dirname, '../data/inventory.json');

const pkgDef = protoLoader.loadSync(PROTO_PATH);
const proto = grpc.loadPackageDefinition(pkgDef).agents;

function CheckInventory(call, callback) {
  const { sku, qty = 1, pincode } = call.request;
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const item = data.items.find(i => i.sku === sku);

  if (!item) {
    return callback(null, { ok: false, message: `Item ${sku} not found` });
  }

  const totalAvailable = item.storeQty + item.stockroomQty >= qty;
  callback(null, {
    ok: true,
    sku,
    name: item.name,
    storeQty: item.storeQty,
    stockroomQty: item.stockroomQty,
    totalAvailable,
    message: totalAvailable
      ? `Available near ${pincode}`
      : `Out of stock near ${pincode}`
  });
}

const server = new grpc.Server();
server.addService(proto.InventoryService.service, { CheckInventory });
server.bindAsync('0.0.0.0:50051', grpc.ServerCredentials.createInsecure(), () => {
  server.start();
  console.log('🧩 InventoryAgent running on 50051');
});
