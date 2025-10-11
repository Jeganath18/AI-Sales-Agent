const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const fs = require('fs');
const path = require('path');

const PROTO_PATH = path.join(__dirname, '../proto/agents.proto');
const FULFILL_PATH = path.join(__dirname, '../data/fulfillments.json');

const pkgDef = protoLoader.loadSync(PROTO_PATH);
const proto = grpc.loadPackageDefinition(pkgDef).agents;

function CreateFulfillment(call, callback) {
  const data = call.request;
  const fulfillments = fs.existsSync(FULFILL_PATH)
    ? JSON.parse(fs.readFileSync(FULFILL_PATH, 'utf8'))
    : [];

  fulfillments.push({ ...data, createdAt: new Date().toISOString() });
  fs.writeFileSync(FULFILL_PATH, JSON.stringify(fulfillments, null, 2));

  callback(null, { ok: true, message: `Order ${data.orderId} saved` });
}

const server = new grpc.Server();
server.addService(proto.FulfillmentService.service, { CreateFulfillment });
server.bindAsync('0.0.0.0:50054', grpc.ServerCredentials.createInsecure(), () => {
  server.start();
  console.log('📦 FulfillmentAgent running on 50054');
});
