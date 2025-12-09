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
const BOT_WEBHOOK_URL = "https://ai.jeganath.duckdns.org/telegram-webhook";

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
      "You are Nexa, a witty AI footwear expert. A customer just opened the chat. Give them a warm, funny welcome. Ask what type of footwear they're looking for (shoes, slippers, chappals, or flip-flops). Keep it brief, 2-3 sentences max, with personality."
    );
    await bot.sendMessage(chatId, autoGreeting);
    sessions[chatId] = { stage: 'footwearType' };
    return;
  }

  const session = sessions[chatId] || { stage: 'footwearType' };
  const productTypes = ['formal', 'casual', 'sports', 'flipflop', 'slipper', 'chappal'];
  const footwearMentioned = text.includes('shoe') || text.includes('shoes') || 
                            text.includes('flipflop') || text.includes('slipper') || 
                            text.includes('chappal') || text.includes('footwear') ||
                            text.includes('flip-flop') || text.includes('sandal');
  
  // Check for gender mentions
  const genderMentions = {
    male: ['boy', 'man', 'male', 'him', 'his', 'men', 'guys', 'gents'],
    female: ['girl', 'woman', 'female', 'her', 'women', 'ladies', 'lady'],
    self: ['me', 'myself', 'my own', 'for me']
  };
  
  let detectedGender = null;
  if (genderMentions.male.some(word => text.includes(word))) detectedGender = 'male';
  if (genderMentions.female.some(word => text.includes(word))) detectedGender = 'female';
  if (genderMentions.self.some(word => text.includes(word))) detectedGender = 'self';

  const matchedType = productTypes.find(pt => text.includes(pt));

  try {
    console.log(`🗣️ Received: ${text} | Stage: ${session.stage}`);

    // 🎯 Stage 1: Ask for footwear type
    if (session.stage === 'footwearType') {
      if (footwearMentioned || matchedType) {
        const type = matchedType || 'casual';
        session.productType = type;
        
        // Check if gender already mentioned
        if (detectedGender && detectedGender !== 'self') {
          session.gender = detectedGender;
          const fetchMsg = await aiReply(
            `You are Nexa. User wants ${type} for a ${detectedGender}. Acknowledge this excitedly and say you're fetching the best options. Keep it 1-2 sentences with personality.`
          );
          await bot.sendMessage(chatId, fetchMsg);
          await handleProductSearch(chatId, type, detectedGender);
          sessions[chatId] = { ...session, stage: 'showingProducts', shownCount: 3 };
        } else {
          // Ask for gender
          const genderPrompt = await aiReply(
            `You are Nexa. User wants ${type}. Ask if it's for a boy or girl in a fun, conversational way. Keep it brief, one sentence.`
          );
          await bot.sendMessage(chatId, genderPrompt);
          sessions[chatId] = { ...session, stage: 'askGender' };
        }
      } else {
        const clarifyMsg = await aiReply(
          `You are Nexa. User didn't specify footwear type clearly. Ask again what they're looking for (shoes, slippers, chappals, flip-flops) in a friendly, humorous way. Keep it 2 sentences max.`
        );
        await bot.sendMessage(chatId, clarifyMsg);
      }
      return;
    }

    // 👥 Stage 2: Get gender preference
if (session.stage === 'askGender') {
  if (detectedGender) {
    session.gender = detectedGender === 'self' ? 'unisex' : detectedGender;

    // Define your allowed nickname options
    const genderNicknames = {
      male: ['cool dude', 'gentleman', 'style king', 'trendsetter', 'handsome gent'],
      female: ['marvelous miss', 'style queen', 'fashion diva', 'elegant lady', 'trend icon'],
      unisex: ['fashion star', 'style champ', 'trend lover']
    };

    // Randomly pick one nickname
    const nick = genderNicknames[session.gender]?.[
      Math.floor(Math.random() * genderNicknames[session.gender].length)
    ] || 'fashion lover';

    // Generate a lively one-liner with Gemini
    const fetchMsg = await aiReply(
      `You are Nexa — a friendly AI shopping assistant with personality.
      The user identified as ${session.gender}. 
      Respond in one short, lively line, starting with something like "Got it, ${nick}!" or "Alright, ${nick}!"
      Mention fetching ${session.productType} for them in a fun, excited tone (use emojis naturally).`
    );

    await bot.sendMessage(chatId, fetchMsg);

    await handleProductSearch(chatId, session.productType, session.gender);
    sessions[chatId] = { ...session, stage: 'showingProducts', shownCount: 3 };

  } else {
    const retryGender = await aiReply(
      `You are Nexa — a playful AI shopping assistant.
      The user didn’t specify gender clearly. 
      Ask again if the product is for a boy or a girl, using one engaging, human-sounding line.`
    );
    await bot.sendMessage(chatId, retryGender);
  }
  return;
}


    // 👟 Stage 3: After showing products
    if (session.stage === 'showingProducts') {
      // Check if user wants more recommendations
      if (text.includes('more') || text.includes('other') || text.includes('different') || 
          text.includes('another') || text.includes('else')) {
        const moreMsg = await aiReply(
          "You are Nexa. User wants more options. Say you're fetching more cool styles. Be enthusiastic, one sentence."
        );
        await bot.sendMessage(chatId, moreMsg);
        await handleProductSearch(chatId, session.productType, session.gender, session.shownCount);
        session.shownCount += 3;
        sessions[chatId] = { ...session };
        return;
      }
      
      // Check if user selected a product by name or number
      const numberMatch = text.match(/\b([1-3])\b/);
      const hasProductName = text.length > 3 && !text.includes('size');
      
      if (numberMatch || hasProductName) {
        session.selectedProduct = numberMatch ? `Product ${numberMatch[1]}` : text;
        const sizePrompt = await aiReply(
          `You are Nexa. User selected "${session.selectedProduct}". Great choice! Now ask for their shoe size in a fun way. Keep it brief, 1-2 sentences.`
        );
        await bot.sendMessage(chatId, sizePrompt);
        sessions[chatId] = { ...session, stage: 'getSize' };
        return;
      }
      
      // Ask if they want more or if they liked something
      const askMore = await aiReply(
        "You are Nexa. Ask the user if they liked any of the products shown or if they want to see more options. Be casual and friendly, 1-2 sentences."
      );
      await bot.sendMessage(chatId, askMore);
      return;
    }

    // 📏 Stage 4: Get shoe size
    if (session.stage === 'getSize') {
      const sizeMatch = text.match(/\b(\d{1,2})\b/) || text.match(/size\s*(\d{1,2})/i);
      
      if (sizeMatch) {
        session.size = sizeMatch[1];
        const addressPrompt = await aiReply(
          `You are Nexa. User gave size ${session.size}. Perfect! Now ask for their delivery address and pincode. Be enthusiastic and brief, 1-2 sentences.`
        );
        await bot.sendMessage(chatId, addressPrompt);
        sessions[chatId] = { ...session, stage: 'getAddress' };
      } else {
        const retrySizeMsg = await aiReply(
          "You are Nexa. Couldn't catch the size. Ask again for their shoe size (like 7, 8, 9, etc.) in a playful way. Keep it super short."
        );
        await bot.sendMessage(chatId, retrySizeMsg);
      }
      return;
    }

    // 🏠 Stage 5: Get address and pincode
    if (session.stage === 'getAddress') {
      session.address = text;
      const pincodeMatch = text.match(/\b(\d{6})\b/);
      
      if (pincodeMatch) {
        session.pincode = pincodeMatch[1];
        
        // Start order processing
        const checkingMsg = await aiReply(
          "You are Nexa. Checking stock availability for their order. Make it sound exciting and quick. One sentence with an emoji."
        );
        await bot.sendMessage(chatId, checkingMsg);
        
        // Simulate inventory check
        const sku = session.selectedSku || 'SKU-001';
        const inv = await checkInventory(sku, 1, session.pincode);

        if (!inv.ok || !inv.totalAvailable) {
          const sorryMsg = await aiReply(
            "You are Nexa. Item not available at their location. Apologize with empathy and humor. Offer alternatives. Keep it 2 sentences."
          );
          await bot.sendMessage(chatId, sorryMsg);
          sessions[chatId] = { stage: 'footwearType' };
          return;
        }

        const processingMsg = await aiReply(
          "You are Nexa. Stock confirmed! Now placing the order and processing payment securely. Say this confidently in 1-2 sentences."
        );
        await bot.sendMessage(chatId, processingMsg);
        
        // Process payment
        const pay = await processPayment('order-' + Date.now(), 10000, 'gpay');
        
        // Create fulfillment
        // await createFulfillment({
        //   orderId: 'order-' + Date.now(),
        //   items: [{ sku, qty: 1 }],
        //   address: session.address,
        //   pincode: session.pincode,
        // });

        const successMsg = await aiReply(
          `You are Nexa. Order placed successfully! Tell them it will be dispatched within 3-4 days and delivered to their doorstep. Celebrate this moment! Add excitement and maybe ask if they need anything else. Keep it 2-3 sentences.`
        );
        await bot.sendMessage(chatId, successMsg);
        
        sessions[chatId] = null;
      } else {
        const retryPincode = await aiReply(
          "You are Nexa. Couldn't find the 6-digit pincode. Ask for address with pincode again, playfully. Keep it brief."
        );
        await bot.sendMessage(chatId, retryPincode);
      }
      return;
    }

    // 🗣️ Default: Handle unexpected input
    const aiResponse = await aiReply(
      `You are Nexa, a witty AI footwear sales agent. The user said: "${text}". 
      Current stage: ${session.stage || 'start'}. 
      Guide them back on track conversationally. If they're asking for footwear, help them specify type and gender.
      Be helpful, funny, and natural. Keep response under 3 sentences with relevant emojis.`
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

// Enhanced product search with gender filter
async function handleProductSearch(chatId, type, gender = null, offset = 0) {
  try {
    const results = await searchProducts(type, gender, 3, offset);
    
    if (!results.products || results.products.length === 0) {
      const noResultsMsg = await aiReply(
        `You are Nexa. No products found for ${type}. Apologize and suggest trying a different category. Be empathetic and helpful. 2 sentences.`
      );
      await bot.sendMessage(chatId, noResultsMsg);
      return;
    }

    for (let i = 0; i < results.products.length; i++) {
      const p = results.products[i];
      await bot.sendPhoto(chatId, p.imageUrl, {
        caption: `${i + 1}. ${p.name}\n👤 ${p.gender || 'Unisex'} | ${p.type}\n💰 ₹${p.price}\n🚚 Delivers in ${p.deliveryDays || 3} days`,
      });
    }

    // Save product info for later reference
    if (sessions[chatId]) {
      sessions[chatId].lastProducts = results.products;
      sessions[chatId].selectedSku = results.products[0].sku;
    }

  } catch (error) {
    console.error('Error in handleProductSearch:', error);
    await bot.sendMessage(chatId, "Oops! Had trouble fetching products. Let me try again! 🔄");
  }
}

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
