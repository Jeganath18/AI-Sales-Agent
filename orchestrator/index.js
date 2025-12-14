// orchestrator/index.js
require('dotenv').config();
const express = require('express');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const OpenAI = require("openai");

const { searchProducts, checkInventory, processPayment, createFulfillment } = require('./grpc_clients');

const client = new OpenAI({
  apiKey: process.env.GROQ_APIKEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// =======================
// Enhanced NLP Utilities
// =======================
const PRODUCT_SYNONYMS = {
  formal: ['formal', 'office', 'business', 'dress shoes', 'oxford', 'loafer'],
  casual: ['casual', 'everyday', 'sneakers', 'trainers', 'walking shoes'],
  sports: ['sports', 'running', 'athletic', 'gym', 'workout', 'joggers'],
  flipflop: ['flipflop', 'flip flop', 'flip-flop', 'flipflops', 'flip flops', 'thongs'],
  slipper: ['slipper', 'slippers', 'house shoes', 'indoor'],
  chappal: ['chappal', 'chappals', 'sandal', 'sandals', 'chappel']
};

const AFFIRMATIVE_PATTERNS = [
  'yes', 'yeah', 'yep', 'sure', 'okay', 'ok', 'yup', 'definitely', 
  'absolutely', 'of course', 'please', 'go ahead', 'sounds good'
];

const NEGATIVE_PATTERNS = [
  'no', 'nope', 'nah', 'not', "don't", 'never', 'neither'
];

function normalizeProductType(text) {
  const lowerText = text.toLowerCase();
  for (const [canonical, synonyms] of Object.entries(PRODUCT_SYNONYMS)) {
    if (synonyms.some(syn => lowerText.includes(syn))) {
      return canonical;
    }
  }
  return null;
}

function isAffirmative(text) {
  const lowerText = text.toLowerCase();
  return AFFIRMATIVE_PATTERNS.some(pattern => lowerText.includes(pattern));
}

function isNegative(text) {
  const lowerText = text.toLowerCase();
  return NEGATIVE_PATTERNS.some(pattern => lowerText.includes(pattern));
}

function detectGender(text) {
  const lowerText = text.toLowerCase();
  const genderPatterns = {
    male: ['boy', 'man', 'male', 'him', 'his', 'men', 'guy', 'gents', 'gentleman'],
    female: ['girl', 'woman', 'female', 'her', 'women', 'ladies', 'lady', 'gal'],
    self: ['me', 'myself', 'my own', 'for me', 'i want', "i'm looking"]
  };
  
  for (const [gender, patterns] of Object.entries(genderPatterns)) {
    if (patterns.some(pattern => lowerText.includes(pattern))) {
      return gender === 'self' ? 'unisex' : gender;
    }
  }
  return null;
}

// =======================
// Enhanced AI Reply with Context
// =======================
async function aiReply(prompt, context = {}) {
  try {
    let fullPrompt = prompt;
    
    // Add conversation context for better responses
    if (context.stage) {
      fullPrompt += `\n\nConversation context:
- Current stage: ${context.stage}
- Product type: ${context.productType || 'not selected'}
- Gender: ${context.gender || 'not specified'}
- User's last message: "${context.userMessage || ''}"`;
    }
    
    fullPrompt += "\n\nIMPORTANT: Keep response natural, concise (2-3 sentences max), and use emojis sparingly. Be helpful and friendly.";

    const response = await client.responses.create({
      model: "openai/gpt-oss-20b",
      input: fullPrompt,
    });

    return response.output_text;
  } catch (err) {
    console.error("❌ AI API error:", err);
    return "Oops! I'm having a moment here. Can you try that again? 😅";
  }
}

// Load gRPC handlers
const { Search } = require('../agents/recommendationAgent');
const { CheckInventory } = require('../agents/inventoryAgent');
const { ProcessPayment } = require('../agents/paymentAgent');
const { CreateFulfillment } = require('../agents/fulfillmentAgent');

// Load proto
const PROTO_PATH = path.join(__dirname, '../proto/agents.proto');
const pkgDef = protoLoader.loadSync(PROTO_PATH, { 
  keepCase: true, 
  longs: String, 
  enums: String, 
  defaults: true, 
  oneofs: true 
});
const proto = grpc.loadPackageDefinition(pkgDef).agents;

// Start gRPC server
const grpcServer = new grpc.Server();
grpcServer.addService(proto.RecommendationService.service, { Search });
grpcServer.addService(proto.InventoryService.service, { CheckInventory });
grpcServer.addService(proto.PaymentService.service, { ProcessPayment });
grpcServer.addService(proto.FulfillmentService.service, { createFulfillment });

const GRPC_PORT = 50051;
grpcServer.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), () => {
  grpcServer.start();
  console.log(`🧠 All gRPC agents running on port ${GRPC_PORT}`);
});

// Express setup
const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN || "8348296956:AAH4BXG8peZ7aoooShsgj21V4IR9hnCprno", { 
  polling: true 
});

app.get('/', (_, res) => res.send('🚀 Nexa AI Orchestrator running.'));

const sessions = {};

// =======================
// Enhanced Product Search
// =======================
async function handleProductSearch(chatId, productType, gender = null, offset = 0) {
  try {
    const limit = 10;
    const results = await searchProducts(productType, gender, limit, offset);
    
    if (!results.ok || !results.products || results.products.length === 0) {
      const noResultsMsg = await aiReply(
        `You are Nexa. No ${productType} found for ${gender || 'any gender'}. Apologize warmly and suggest trying different options or all categories.`,
        { stage: 'showingProducts', productType, gender }
      );
      await bot.sendMessage(chatId, noResultsMsg);
      
      // Reset to product type selection
      sessions[chatId] = { stage: 'footwearType' };
      return false;
    }

    // Send products with numbered selection
    for (let i = 0; i < results.products.length; i++) {
      const p = results.products[i];
      await bot.sendPhoto(chatId, p.imageUrl, {
        caption: `*Option ${offset + i + 1}:* ${p.name}\n` +
                 `👤 ${p.gender || 'Unisex'} | 🏷️ ${p.type}\n` +
                 `💰 ₹${p.price}\n` +
                 `🚚 Delivers in ${p.deliveryDays || 3-4} days`,
        parse_mode: 'Markdown'
      });
    }

    // Update session with product references
    const session = sessions[chatId] || {};
    session.lastProducts = results.products;
    session.productOffset = offset;
    session.hasMoreProducts = results.moreAvailable;
    sessions[chatId] = session;

    return true;
  } catch (error) {
    console.error('❌ Error in handleProductSearch:', error);
    await bot.sendMessage(chatId, "Oops! Had trouble fetching products. Let me try again! 🔄");
    return false;
  }
}

// =======================
// Order Processing
// =======================
async function processOrder(chatId, session) {
  try {
    const orderId = 'ORD-' + Date.now();
    
    // Step 1: Check inventory
    await bot.sendMessage(chatId, "🔍 Checking availability...");
    const sku = session.selectedSku || 'SKU-001';
    const inv = await checkInventory(sku, 1, session.pincode);

    if (!inv.ok || !inv.totalAvailable) {
      const outOfStockMsg = await aiReply(
        "You are Nexa. The selected product isn't available at their location. Apologize genuinely and offer to show alternative options.",
        { ...session, userMessage: 'out of stock' }
      );
      await bot.sendMessage(chatId, outOfStockMsg);
      sessions[chatId] = { stage: 'footwearType' };
      return false;
    }

    // Step 2: Process payment
    await bot.sendMessage(chatId, "💳 Processing payment securely...");
    const totalAmount = session.selectedPrice || 10000;
    const payment = await processPayment(orderId, totalAmount, 'gpay');
    
    if (!payment.ok) {
      await bot.sendMessage(chatId, "❌ Payment failed. Please try again or contact support.");
      return false;
    }

    // Step 3: Create fulfillment
    await bot.sendMessage(chatId, "📦 Creating your order...");
    // const fulfillment = await createFulfillment({
    //   orderId: orderId,
    //   items: [{ sku: sku, qty: 1 }],
    //   address: session.address,
    //   pincode: session.pincode,
    // });

    // if (!fulfillment.ok) {
    //   await bot.sendMessage(chatId, "⚠️ Order created but fulfillment pending. Our team will contact you soon!");
    // }

    // Step 4: Send confirmation
    const successMsg = await aiReply(
      `You are Nexa. Order ${orderId} placed successfully! Confirm the order details and tell them it will be delivered to ${session.address} in 3-4 days. Make it celebratory and thank them and ask them visit again with a sweet quote and complement them with a quote.`,
      { ...session, stage: 'orderComplete' }
    );
    
    await bot.sendMessage(chatId, 
      `🎉 *Order Confirmed!*\n\n` +
      `📦 Order ID: ${orderId}\n` +
      `📍 Delivery Address: ${session.address}\n` +
      `📮 Pincode: ${session.pincode}\n` +
      `💰 Amount: ₹${totalAmount / 100}\n` +
      `🚚 Expected Delivery: 3-4 business days\n\n` +
      successMsg,
      { parse_mode: 'Markdown' }
    );

    // Clear session after successful order
    delete sessions[chatId];
    return true;

  } catch (error) {
    console.error('❌ Error processing order:', error);
    await bot.sendMessage(chatId, "Something went wrong. Please try again or contact support.");
    return false;
  }
}

// =======================
// Start Command
// =======================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const greeting = await aiReply(
    "You are Nexa, a witty AI footwear expert. Greet the customer warmly. Introduce yourself briefly and ask what type of footwear they're looking for. List options: formal shoes, casual shoes, sports shoes, flip-flops, slippers, or chappals.",
    { stage: 'start' }
  );
  await bot.sendMessage(chatId, greeting);
  sessions[chatId] = { stage: 'footwearType' };
});

// =======================
// Main Message Handler
// =======================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  
  if (!text || text === "/start") return;

  const lowerText = text.toLowerCase();
  let session = sessions[chatId] || { stage: 'footwearType' };

  try {
    console.log(`🗣️ User: "${text}" | Stage: ${session.stage}`);

    // =======================
    // Stage: Footwear Type Selection
    // =======================
    if (session.stage === 'footwearType') {
      const productType = normalizeProductType(text);
      
      if (productType) {
        session.productType = productType;
        const gender = detectGender(text);
        
        if (gender) {
          session.gender = gender;
          const fetchMsg = await aiReply(
            `You are Nexa. User wants ${productType} for ${gender}. Acknowledge excitedly and say you're fetching options.`,
            { ...session, userMessage: text }
          );
          await bot.sendMessage(chatId, fetchMsg);
          
          await handleProductSearch(chatId, productType, gender);
          sessions[chatId] = { ...session, stage: 'showingProducts', shownCount: 3 };
        } else {
          const genderPrompt = await aiReply(
            `You are Nexa. User wants ${productType}. Ask if it's for a boy, girl, or themselves. Keep it conversational.`,
            { ...session, userMessage: text }
          );
          await bot.sendMessage(chatId, genderPrompt);
          sessions[chatId] = { ...session, stage: 'askGender' };
        }
      } else {
        const clarifyMsg = await aiReply(
          "You are Nexa. User's footwear type unclear. List the options clearly: formal shoes, casual shoes, sports shoes, flip-flops, slippers, chappals. Ask what they're looking for.",
          { ...session, userMessage: text }
        );
        await bot.sendMessage(chatId, clarifyMsg);
      }
      return;
    }

    // =======================
    // Stage: Ask Gender
    // =======================
    if (session.stage === 'askGender') {
      const gender = detectGender(text);
      
      if (gender) {
        session.gender = gender;
        
        const genderLabels = {
          male: ['cool dude', 'gentleman', 'style king'],
          female: ['style queen', 'fashionista', 'trendsetter'],
          unisex: ['fashion star', 'style champ']
        };
        
        const nickname = genderLabels[gender]?.[Math.floor(Math.random() * 3)] || 'friend';
        
        await bot.sendMessage(chatId, `Got it, ${nickname}! 😎 Let me fetch the best ${session.productType} for you...`);
        
        await handleProductSearch(chatId, session.productType, gender);
        sessions[chatId] = { ...session, stage: 'showingProducts', shownCount: 3 };
      } else {
        const retryMsg = await aiReply(
          "You are Nexa. Couldn't determine gender. Ask again: boy, girl, or for themselves?",
          { ...session, userMessage: text }
        );
        await bot.sendMessage(chatId, retryMsg);
      }
      return;
    }

    // =======================
    // Stage: Showing Products
    // =======================
    if (session.stage === 'showingProducts') {
      // Check for "more" request
      if (lowerText.includes('more') || lowerText.includes('other') || 
          lowerText.includes('different') || lowerText.includes('else')) {
        
        if (session.hasMoreProducts) {
          await bot.sendMessage(chatId, "🔄 Loading more options...");
          const newOffset = session.productOffset + 3;
          await handleProductSearch(chatId, session.productType, session.gender, newOffset);
          session.shownCount += 3;
          sessions[chatId] = { ...session, stage: 'showingProducts' };
        } else {
          await bot.sendMessage(chatId, "That's all we have in this category. Want to pick from what I showed? Or try a different type?");
        }
        return;
      }

      // Check for product selection (by number or name)
      const numberMatch = text.match(/\b(\d+)\b/);
      let selectedProduct = null;
      
      if (numberMatch) {
        const index = parseInt(numberMatch[1]) - 1;
        if (session.lastProducts && session.lastProducts[index]) {
          selectedProduct = session.lastProducts[index];
        }
      } else if (session.lastProducts) {
        // Try matching product name
        selectedProduct = session.lastProducts.find(p => 
          p.name.toLowerCase().includes(lowerText) || 
          lowerText.includes(p.name.toLowerCase().split(' ')[0])
        );
      }

      if (selectedProduct) {
        session.selectedProduct = selectedProduct.name;
        session.selectedSku = selectedProduct.sku;
        session.selectedPrice = selectedProduct.price * 100; // Convert to paise
        
        const sizePrompt = await aiReply(
          `You are Nexa. User selected "${selectedProduct.name}". Great choice! Ask for their shoe size.`,
          { ...session, userMessage: text }
        );
        await bot.sendMessage(chatId, sizePrompt);
        sessions[chatId] = { ...session, stage: 'getSize' };
        return;
      }

      // Didn't understand selection
      const clarifySelection = await aiReply(
        "You are Nexa. User's selection unclear. Ask them to either pick a number from the options shown or type 'more' for more options.",
        { ...session, userMessage: text }
      );
      await bot.sendMessage(chatId, clarifySelection);
      return;
    }

    // =======================
    // Stage: Get Size
    // =======================
    if (session.stage === 'getSize') {
      const sizeMatch = text.match(/\b(\d{1,2})\b/);
      
      if (sizeMatch) {
        session.size = sizeMatch[1];
        const addressPrompt = await aiReply(
          `You are Nexa. Got size ${session.size}. Now ask for delivery address with 6-digit pincode.`,
          { ...session, userMessage: text }
        );
        await bot.sendMessage(chatId, addressPrompt);
        sessions[chatId] = { ...session, stage: 'getAddress' };
      } else {
        const retrySizeMsg = await aiReply(
          "You are Nexa. Couldn't catch the size. Ask for shoe size number (e.g., 7, 8, 9, 10).",
          { ...session, userMessage: text }
        );
        await bot.sendMessage(chatId, retrySizeMsg);
      }
      return;
    }

    // =======================
    // Stage: Get Address
    // =======================
    if (session.stage === 'getAddress') {
      const pincodeMatch = text.match(/\b(\d{6})\b/);
      
      if (pincodeMatch) {
        session.address = text;
        session.pincode = pincodeMatch[1];
        
        // Confirm order details before processing
        const confirmMsg = await bot.sendMessage(chatId,
          `📋 *Order Summary*\n\n` +
          `👟 Product: ${session.selectedProduct}\n` +
          `📏 Size: ${session.size}\n` +
          `📍 Address: ${session.address}\n` +
          `💰 Price: ₹${session.selectedPrice / 100}\n\n` +
          `Confirm order? Reply *YES* to proceed or *NO* to cancel.`,
          { parse_mode: 'Markdown' }
        );
        
        sessions[chatId] = { ...session, stage: 'confirmOrder' };
      } else {
        const retryAddress = await aiReply(
          "You are Nexa. Need address with 6-digit pincode. Ask again clearly.",
          { ...session, userMessage: text }
        );
        await bot.sendMessage(chatId, retryAddress);
      }
      return;
    }

    // =======================
    // Stage: Confirm Order
    // =======================
    if (session.stage === 'confirmOrder') {
      if (isAffirmative(text)) {
        await processOrder(chatId, session);
      } else if (isNegative(text)) {
        const cancelMsg = await aiReply(
          "You are Nexa. User cancelled order. Acknowledge politely and ask if they want to browse again.",
          { ...session, userMessage: text }
        );
        await bot.sendMessage(chatId, cancelMsg);
        sessions[chatId] = { stage: 'footwearType' };
      } else {
        await bot.sendMessage(chatId, "Please reply YES to confirm or NO to cancel the order.");
      }
      return;
    }

    // =======================
    // Fallback: Contextual Help
    // =======================
    const helpMsg = await aiReply(
      `You are Nexa. User said: "${text}". Current stage: ${session.stage}. Help them get back on track. Guide them to next appropriate step.`,
      { ...session, userMessage: text }
    );
    await bot.sendMessage(chatId, helpMsg);

  } catch (err) {
    console.error('❌ Error in message handler:', err);
    const errorMsg = await aiReply(
      "You are Nexa. Error occurred. Apologize and ask them to try again or type /start to restart.",
      { stage: 'error' }
    );
    bot.sendMessage(chatId, errorMsg);
  }
});

// Error handlers
bot.on('error', (error) => console.error('❌ Bot error:', error));
bot.on('polling_error', (error) => console.error('❌ Polling error:', error));

// Start Express server
const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
  console.log(`🌐 HTTP server running on port ${PORT}`);
  console.log('🚀 Nexa AI Orchestrator is fully operational!');
});