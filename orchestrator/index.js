// orchestrator/index.js
require('dotenv').config();
const express = require('express');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const { searchProducts, checkInventory, processPayment, createFulfillment } = require('./grpc_clients');

// Load gRPC handlers from agents
const { Search } = require('../agents/recommendationAgent');
const { CheckInventory } = require('../agents/inventoryAgent');
const { ProcessPayment } = require('../agents/paymentAgent');
const { FulfillOrder } = require('../agents/fulfillmentAgent');

// Load proto
const PROTO_PATH = path.join(__dirname, '../proto/agents.proto');
const pkgDef = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
const proto = grpc.loadPackageDefinition(pkgDef).agents;

// =======================
// 1️⃣ Start gRPC server
// =======================
const grpcServer = new grpc.Server();
grpcServer.addService(proto.RecommendationService.service, { Search });
grpcServer.addService(proto.InventoryService.service, { CheckInventory });
grpcServer.addService(proto.PaymentService.service, { ProcessPayment });
grpcServer.addService(proto.FulfillmentService.service, { FulfillOrder });

const GRPC_PORT = 50051;
grpcServer.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), () => {
  grpcServer.start();
  console.log(`🧠 All gRPC agents running on port ${GRPC_PORT}`);
});

// =======================
// 2️⃣ Start Express & Telegram webhook
// =======================
const app = express();
app.use(express.json());

// Hardcoded Render URL
const BOT_WEBHOOK_URL = "https://ai-sales-agent-ln48.onrender.com/telegram-webhook";

// Initialize bot in webhook mode
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling:false });


// Webhook endpoint to receive updates from Telegram
app.post('/telegram-webhook', (req, res) => {
  console.log('Webhook update received:', req.body.update_id);
  bot.processUpdate(req.body);
  res.sendStatus(200);
});
// Health check
app.get('/', (_, res) => res.send('🚀 Nexa AI Orchestrator running.'));

const sessions = {};

// =======================
// 3️⃣ Helper: product search
// =======================
async function handleProductSearch(chatId, productType) {
  const rec = await searchProducts(productType, '', 1, 0, 3);
  if (!rec.ok || rec.products.length === 0) return bot.sendMessage(chatId, 'No products available.');

  for (const p of rec.products) {
    await bot.sendPhoto(chatId, p.imageUrl, {
      caption: `${p.name}\nType: ${p.type}\nPrice: ₹${p.price}\nDelivery: ${p.deliveryDays} days`
    });
  }

  if (rec.moreAvailable) {
    bot.sendMessage(chatId, 'Would you like to see more recommendations? (yes/no)');
    sessions[chatId] = { stage: 'moreRecommendations', searchQuery: productType, offset: 3, limit: 3, selectedSku: rec.products[0].sku };
  } else {
    bot.sendMessage(chatId, 'Please tell me your shoe size (e.g., size 9).');
    sessions[chatId] = { stage: 'size', selectedSku: rec.products[0].sku };
  }
}

// =======================
// 4️⃣ Telegram bot message handler
// =======================
bot.on('message', async msg => {
  console.log('🎯 MESSAGE EVENT TRIGGERED!'); // Debug line
  console.log('Message object:', JSON.stringify(msg, null, 2)); 
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return;
  const session = sessions[chatId];

  try {
      await bot.sendMessage(chatId, `✅ Got your message: "${text}"`);
      console.log('✅ Test reply sent successfully');
    if (session?.stage === 'moreRecommendations') {
      if (text.toLowerCase() === 'yes') {
        const rec = await searchProducts(session.searchQuery, '', 1, session.offset, session.limit);
        for (const p of rec.products) {
          await bot.sendPhoto(chatId, p.imageUrl, {
            caption: `${p.name}\nType: ${p.type}\nPrice: ₹${p.price}\nDelivery: ${p.deliveryDays} days`
          });
        }
        if (rec.moreAvailable) {
          session.offset += session.limit;
          bot.sendMessage(chatId, 'Do you want to see more? (yes/no)');
        } else {
          bot.sendMessage(chatId, 'Please tell me your shoe size (e.g., size 9).');
          sessions[chatId] = { stage: 'size', selectedSku: rec.products[0].sku };
        }
        return;
      } else {
        bot.sendMessage(chatId, 'Please tell me your shoe size (e.g., size 9).');
        sessions[chatId] = { stage: 'size', selectedSku: session.selectedSku };
        return;
      }
    }

    const productTypes = ['shoe', 'formal', 'casual', 'chappal', 'flipflop', 'sports'];
    const productType = productTypes.find(pt => text.toLowerCase().includes(pt));
    if (productType) {
      await handleProductSearch(chatId, productType);
      return;
    }

    if (session?.stage === 'size') {
      session.size = text;
      bot.sendMessage(chatId, 'Great! Please provide your address and pincode.');
      session.stage = 'address';
      return;
    }

    if (session?.stage === 'address') {
      session.address = text;
      const sku = session.selectedSku;
      const inv = await checkInventory(sku, 1, '560001');
      if (!inv.ok || !inv.totalAvailable) return bot.sendMessage(chatId, 'Sorry, item not available nearby.');

      await bot.sendMessage(chatId, `✅ ${inv.name} is available for delivery.`);
      await bot.sendMessage(chatId, 'Opening Google Pay... 💳');
      const pay = await processPayment('order-' + Date.now(), 10000, 'gpay');
      await bot.sendMessage(chatId, `✅ ${pay.confirmation}`);

      await createFulfillment({ orderId: 'order-' + Date.now(), items: [{ sku, qty: 1 }], address: session.address, pincode: '560001' });
      await bot.sendMessage(chatId, '🎉 Order placed successfully!');
      sessions[chatId] = null;
      return;
    }

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, '⚠️ Something went wrong.');
  }
});

bot.on('error', (error) => {
  console.error('❌ Bot error:', error);
});

bot.on('polling_error', (error) => {
  console.error('❌ Polling error:', error);
});



// =======================
// 5️⃣ Start Express
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 HTTP server running on port ${PORT}`);
  
  // Wait 2 seconds for server to be fully ready, then set webhook
  setTimeout(async () => {
    try {
      console.log('🔧 Removing old webhook...');
      await bot.deleteWebHook({ drop_pending_updates: true });
      
      console.log('🔧 Setting new webhook...');
      await bot.setWebHook(BOT_WEBHOOK_URL);
      
      // Verify it worked
      const info = await bot.getWebHookInfo();
      console.log('✅ Webhook set successfully!');
      console.log('📋 URL:', info.url);
      console.log('📋 Pending updates:', info.pending_update_count);
    } catch (error) {
      console.error('❌ Error setting webhook:', error.message);
    }
  }, 2000); // 2 second delay
});
console.log('🚀 Nexa AI Orchestrator is fully running.');
