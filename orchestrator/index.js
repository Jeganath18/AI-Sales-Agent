// orchestrator/index.js
require('dotenv').config();
const express = require('express');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { searchProducts, checkInventory, processPayment, createFulfillment } = require('./grpc_clients');

// Pass gemini key and create model instance
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

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

async function aiReply(prompt) {
  try {
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    console.error("❌ Gemini API error:", err);
    return "Hmm, I’m having trouble thinking right now 😅";
  }
}


// =======================
// 2️⃣ Start Express & Telegram webhook
// =======================
const app = express();
app.use(express.json());

// Hardcoded Render URL
const BOT_WEBHOOK_URL = "https://ai-sales-agent-ln48.onrender.com/telegram-webhook";

// Initialize bot in webhook mode
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });


// Webhook endpoint to receive updates from Telegram
app.post('/telegram-webhook', (req, res) => {
  console.log('Webhook update received:', req.body.update_id);
  bot.processUpdate(req.body);
  res.sendStatus(200);
});
// Health check
app.get('/', (_, res) => res.send('🚀 Nexa AI Orchestrator running.'));

const sessions = {};

// Track first-time users
const firstTimeUsers = new Set();

// Send welcome message for new chat sessions
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const greeting = await aiReply(
    "You are Nexa, a witty and charismatic AI sales agent for footwear. Greet the customer with enthusiasm and a touch of humor. Make it warm, personal, and slightly playful. Briefly mention you can help them find the perfect shoes and handle everything from browsing to doorstep delivery. Keep it under 3 sentences and end with an engaging question."
  );
  await bot.sendMessage(chatId, greeting);
  firstTimeUsers.delete(chatId); // Mark as greeted
});


// =======================
// 3️⃣ Helper: product search
// =======================
async function handleProductSearch(chatId, productType) {
  const rec = await searchProducts(productType, '', 1, 0, 3);
  if (!rec.ok || rec.products.length === 0) {
    const noProdReply = await aiReply(
      `You are Nexa, an AI shopping assistant. The user searched for ${productType} but no items were found. Reply politely with a friendly apology.`
    );
    return bot.sendMessage(chatId, noProdReply);
  }

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
// 💬 Conversational Message Handler
// =======================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim().toLowerCase();
  
  // Skip if it's a /start command (already handled)
  if (text === "/start") return;

  // Auto-greet first-time users who didn't use /start
  if (!firstTimeUsers.has(chatId) && !sessions[chatId]) {
    firstTimeUsers.add(chatId);
    const autoGreeting = await aiReply(
      "You are Nexa, a witty AI footwear expert. A customer just opened the chat. Give them a warm, funny welcome that feels natural (not robotic). Mention you're here to help them find amazing shoes. Keep it brief, 2-3 sentences max, with personality."
    );
    await bot.sendMessage(chatId, autoGreeting);
  }

  const session = sessions[chatId] || {};
  const productTypes = ['formal', 'casual', 'sports', 'flipflop', 'slipper', 'chappal'];
  const shoeMentioned = text.includes('shoe') || text.includes('shoes') || 
                        text.includes('flipflop') || text.includes('slipper') || 
                        text.includes('chappal') || text.includes('footwear');
  const matchedType = productTypes.find(pt => text.includes(pt));

  try {
    console.log(`🗣️ Received: ${text}`);

    // 🎯 Case 1: User mentioned specific shoe type
    if (shoeMentioned && matchedType) {
      const intro = await aiReply(
        `You are Nexa, a fun AI shopping buddy. The user wants ${matchedType} shoes. Respond with excitement and personality in 1-2 short sentences. Add a playful emoji. Make it feel like you're genuinely hyped to show them options.`
      );
      await bot.sendMessage(chatId, intro);
      await handleProductSearch(chatId, matchedType);
      sessions[chatId] = { stage: 'recommendation', type: matchedType };
      return;
    }

    // 👟 Case 2: User said "shoe" but no specific type
    if (shoeMentioned && !matchedType && session.stage !== 'askShoeType') {
      const typePrompt = await aiReply(
        `You are Nexa. The user wants shoes but didn't specify the type. Ask them what style they prefer (formal, casual, or sports) in a fun, conversational way. Include emojis but keep it under 3 sentences. Make it feel like a friend asking, not a form.`
      );
      await bot.sendMessage(chatId, typePrompt);
      sessions[chatId] = { stage: 'askShoeType' };
      return;
    }

    // 🛍️ Case 3: Handle more recommendations
    if (session.stage === 'moreRecommendations') {
      const followUp = await aiReply(
        `You are Nexa. The user just saw some shoe recommendations. Ask if they want to see more options or if they're ready to pick their size. Be casual and friendly, like a shopping buddy. Keep it brief and conversational with a touch of humor.`
      );
      await bot.sendMessage(chatId, followUp);
      
      if (text.includes('yes') || text.includes('more') || text.includes('sure')) {
        const rec = await searchProducts(session.searchQuery, '', 1, session.offset, session.limit);
        for (const p of rec.products) {
          await bot.sendPhoto(chatId, p.imageUrl, {
            caption: `${p.name}\n${p.type} | ₹${p.price}\n🚚 Delivers in ${p.deliveryDays} days`,
          });
        }
        session.offset += session.limit;
        if (rec.moreAvailable) {
          sessions[chatId] = { ...session, offset: session.offset };
        } else {
          sessions[chatId] = { stage: 'size', selectedSku: rec.products[0].sku };
        }
      } else {
        const sizePrompt = await aiReply(
          "You are Nexa. Time to get their shoe size. Ask for it in a fun, casual way. Keep it super short."
        );
        await bot.sendMessage(chatId, sizePrompt);
        sessions[chatId] = { stage: 'size', selectedSku: session.selectedSku };
      }
      return;
    }

    // 👣 Case 4: Collect size
    if (session.stage === 'size') {
      session.size = text;
      const addressPrompt = await aiReply(
        "You are Nexa. User just gave their shoe size. Acknowledge it with enthusiasm and ask for delivery address + pincode. Be brief and friendly with a touch of humor."
      );
      await bot.sendMessage(chatId, addressPrompt);
      session.stage = 'address';
      return;
    }

    // 🏠 Case 5: Collect address and process order
    if (session.stage === 'address') {
      session.address = text;
      const sku = session.selectedSku;
      
      const checkingMsg = await aiReply(
        "You are Nexa. Tell user you're checking inventory near them. Make it fun and anticipatory in one sentence."
      );
      await bot.sendMessage(chatId, checkingMsg);
      
      const inv = await checkInventory(sku, 1, '560001');

      if (!inv.ok || !inv.totalAvailable) {
        const sorryMsg = await aiReply(
          "You are Nexa. The item isn't available. Apologize with empathy and humor. Offer to help find alternatives. Keep it short."
        );
        return bot.sendMessage(chatId, sorryMsg);
      }

      const stockMsg = await aiReply(
        `You are Nexa. Great news - ${inv.name} is in stock! Announce it with excitement. Keep it to 1 sentence with an emoji.`
      );
      await bot.sendMessage(chatId, stockMsg);
      
      const paymentMsg = await aiReply(
        "You are Nexa. Now processing payment. Mention it's secure. Be reassuring but brief, one sentence."
      );
      await bot.sendMessage(chatId, paymentMsg);
      
      const pay = await processPayment('order-' + Date.now(), 10000, 'gpay');
      
      const successMsg = await aiReply(
        "You are Nexa. Payment successful! Order is placed. Celebrate with the user. Add excitement about delivery. End with a fun question about showing accessories next time. Keep it 2-3 sentences max."
      );
      await bot.sendMessage(chatId, successMsg);

      await createFulfillment({
        orderId: 'order-' + Date.now(),
        items: [{ sku, qty: 1 }],
        address: session.address,
        pincode: '560001',
      });

      sessions[chatId] = null;
      return;
    }

    // 🗣️ Default: AI handles everything else
    const aiResponse = await aiReply(
      `You are Nexa, a witty AI footwear sales agent. The user said: "${text}". 
      If it seems like they want shoes, guide them conversationally toward formal/casual/sports options.
      If it's chitchat, respond naturally and steer gently back to footwear.
      If unclear, ask what they're looking for in a fun way.
      Keep response under 3 sentences, be funny and human-like. Add relevant emojis.`
    );
    await bot.sendMessage(chatId, aiResponse);

  } catch (err) {
    console.error('❌ Error in message handler:', err);
    const errorMsg = await aiReply(
      "You are Nexa. Something went wrong. Apologize with humor and ask them to try again. Keep it light and brief."
    );
    bot.sendMessage(chatId, errorMsg);
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
