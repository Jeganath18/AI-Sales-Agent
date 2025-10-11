// orchestrator/index.js
require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { checkInventory, searchProducts, processPayment, createFulfillment } = require('./grpc_clients');

// Load internal agents (they start gRPC servers)
const { startRecommendationAgent } = require('../agents/recommendationAgent');
const { startInventoryAgent } = require('../agents/inventoryAgent');
const { startPaymentAgent } = require('../agents/paymentAgent');
const { startFulfillmentAgent } = require('../agents/fulfillmentAgent');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// Start all micro-agents
// startRecommendationAgent();
// startInventoryAgent();
// startPaymentAgent();
// startFulfillmentAgent();
// It will start automaticaly while import

// ✅ Telegram Bot (Polling)
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
console.log('🤖 Telegram bot is running with polling...');

const sessions = {};

async function handleProductSearch(chatId, productType) {
  const rec = await searchProducts(productType, '', 1, 0, 3);
  if (!rec.ok || rec.products.length === 0) {
    return bot.sendMessage(chatId, 'No products available.');
  }

  for (const p of rec.products) {
    await bot.sendPhoto(chatId, p.imageUrl, {
      caption: `${p.name}\nType: ${p.type}\nPrice: ₹${p.price}\nDelivery: ${p.deliveryDays} days`
    });
  }

  if (rec.moreAvailable) {
    bot.sendMessage(chatId, 'Would you like to see more? (yes/no)');
    sessions[chatId] = {
      stage: 'moreRecommendations',
      searchQuery: productType,
      offset: 3,
      limit: 3,
      selectedSku: rec.products[0].sku
    };
  } else {
    bot.sendMessage(chatId, 'Please tell me your shoe size (e.g., size 9).');
    sessions[chatId] = { stage: 'size', selectedSku: rec.products[0].sku };
  }
}

bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return;
  const session = sessions[chatId];

  try {
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
      if (!inv.ok || !inv.totalAvailable)
        return bot.sendMessage(chatId, 'Sorry, item not available nearby.');

      await bot.sendMessage(chatId, `✅ ${inv.name} is available for delivery.`);

      await bot.sendMessage(chatId, 'Opening Google Pay... 💳');
      const pay = await processPayment('order-' + Date.now(), 10000, 'gpay');
      await bot.sendMessage(chatId, `✅ ${pay.confirmation}`);

      await createFulfillment({
        orderId: 'order-' + Date.now(),
        items: [{ sku, qty: 1 }],
        address: session.address,
        pincode: '560001'
      });
      await bot.sendMessage(chatId, '🎉 Order placed successfully!');
      sessions[chatId] = null;
      return;
    }
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, '⚠️ Something went wrong.');
  }
});

app.get('/', (_, res) => res.send('🚀 Nexa AI Orchestrator is running.'));
app.listen(PORT, () => console.log(`🌐 Server ready on port ${PORT}`));
