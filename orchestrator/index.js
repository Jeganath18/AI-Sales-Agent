import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import { checkInventory, searchProducts, processPayment, createFulfillment } from '../../grpc_clients';

const app = express();
app.use(express.json()); // Parse JSON body

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { webHook: true });

// Replace <YOUR_VERCEL_URL> with process.env.VERCEL_URL or your deployed URL
bot.setWebHook(`${process.env.VERCEL_URL}/api/telegram`);

const sessions = {};

// Helper function for sending first 3 products
async function handleProductSearch(chatId, productType) {
  const rec = await searchProducts(productType, '', 1, 0, 3);
  if (!rec.ok || rec.products.length === 0) {
    return bot.sendMessage(chatId, 'No shoes available.');
  }

  for (const p of rec.products) {
    await bot.sendPhoto(chatId, p.imageUrl, {
      caption: `${p.name}\nType: ${p.type}\nPrice: ₹${p.price}\nDelivery: ${p.deliveryDays} days`
    });
  }

  if (rec.moreAvailable) {
    bot.sendMessage(chatId, 'Would you like to see more recommendations? (yes/no)');
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

// Webhook handler
bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return;

  try {
    const session = sessions[chatId];

    // 1️⃣ Handle more recommendations
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

    // 2️⃣ Detect product type
    const productTypes = ['shoe', 'formal', 'casual', 'chappal', 'flipflop', 'sports'];
    const productType = productTypes.find(pt => text.toLowerCase().includes(pt));
    if (productType) {
      await handleProductSearch(chatId, productType);
      return;
    }

    // 3️⃣ Size input
    if (session?.stage === 'size') {
      session.size = text;
      bot.sendMessage(chatId, 'Great! Please provide your address and pincode for delivery check.');
      session.stage = 'address';
      return;
    }

    // 4️⃣ Address input
    if (session?.stage === 'address') {
      session.address = text;
      const sku = session.selectedSku;
      const inv = await checkInventory(sku, 1, '560001');
      if (!inv.ok || !inv.totalAvailable)
        return bot.sendMessage(chatId, 'Sorry, the item is not available near you.');

      await bot.sendMessage(chatId, `✅ ${inv.name} is available and can be delivered soon.`);

      // 5️⃣ Payment
      await bot.sendMessage(chatId, 'Opening Google Pay... 💳');
      const pay = await processPayment('order-' + Date.now(), 10000, 'gpay');
      await bot.sendMessage(chatId, `✅ ${pay.confirmation}`);

      // 6️⃣ Fulfillment
      await createFulfillment({
        orderId: 'order-' + Date.now(),
        items: [{ sku, qty: 1 }],
        address: session.address,
        pincode: '560001'
      });
      await bot.sendMessage(chatId, '🎉 Order placed successfully! Thank you!');
      sessions[chatId] = null;
      return;
    }

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, '⚠️ Something went wrong.');
  }
});

// Express route for Vercel serverless function
app.post('/api/telegram', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

export default app;
