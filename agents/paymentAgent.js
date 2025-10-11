const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

const PROTO_PATH = path.join(__dirname, '../proto/agents.proto');
const pkgDef = protoLoader.loadSync(PROTO_PATH);
const proto = grpc.loadPackageDefinition(pkgDef).agents;

function ProcessPayment(call, callback) {
  const { orderId, amount, method } = call.request;
  console.log(`💰 Simulated payment for order ${orderId} via ${method}`);
  callback(null, {
    ok: true,
    confirmation: `Payment simulated. Please complete on Google Pay.`
  });
}

const server = new grpc.Server();
server.addService(proto.PaymentService.service, { ProcessPayment });
server.bindAsync('0.0.0.0:50053', grpc.ServerCredentials.createInsecure(), () => {
  server.start();
  console.log('💳 PaymentAgent running on 50053');
});
