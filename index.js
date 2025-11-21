// index.js
require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);

// key: signalId, value: signal object
const activeSignals = new Map();

// --- Helper: parsing blok sinyal ---
function parseSignalBlock(text) {
  const start = text.indexOf('#PORTX_SIGNAL');
  const end = text.indexOf('#END_PORTX_SIGNAL');

  if (start === -1 || end === -1) return null;

  const block = text
    .slice(start, end)
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  const data = {};
  for (const line of block) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toUpperCase();
    const value = line.slice(idx + 1).trim();
    data[key] = value;
  }

  if (!data.PAIR || !data.SIDE || !data.ENTRY || !data.STOPLOSS) {
    return null;
  }

  // ENTRY bisa single atau range
  let entryLow, entryHigh;
  if (data.ENTRY.includes('-')) {
    const [lowStr, highStr] = data.ENTRY.split('-').map(s => s.trim());
    entryLow = parseFloat(lowStr);
    entryHigh = parseFloat(highStr);
  } else {
    const val = parseFloat(data.ENTRY);
    entryLow = val;
    entryHigh = val;
  }

  const stoploss = parseFloat(data.STOPLOSS);
  const partialTpPct = data.PARTIAL_TP_PCT
    ? parseFloat(data.PARTIAL_TP_PCT)
    : 0.03; // default 3%
  const maxRuntimeMin = data.MAX_RUNTIME_MIN
    ? parseInt(data.MAX_RUNTIME_MIN, 10)
    : 720; // default 12 jam

  return {
    pair: data.PAIR.toUpperCase(),
    side: data.SIDE.toUpperCase(), // LONG / SHORT
    entryLow,
    entryHigh,
    stoploss,
    partialTpPct,
    maxRuntimeMin,
  };
}

// --- Helper: format ID sinyal ---
function makeSignalId(chatId, messageId, pair) {
  return `${chatId}_${messageId}_${pair}`;
}

// --- Handler: setiap ada pesan teks baru ---
bot.on('text', async (ctx) => {
  try {
    const text = ctx.message.text;
    const parsed = parseSignalBlock(text);
    if (!parsed) return;

    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    const signalId = makeSignalId(chatId, messageId, parsed.pair);

    const now = Date.now();
    const entryAvg = (parsed.entryLow + parsed.entryHigh) / 2;

    const signal = {
      id: signalId,
      chatId,
      messageId,
      pair: parsed.pair,
      side: parsed.side, // LONG / SHORT
      entryLow: parsed.entryLow,
      entryHigh: parsed.entryHigh,
      entryAvg,
      stoploss: parsed.stoploss,
      partialTpPct: parsed.partialTpPct,
      maxRuntimeMin: parsed.maxRuntimeMin,
      createdAt: now,
      triggered: false,
      partialNotified: false,
      closed: false,
    };

    activeSignals.set(signalId, signal);

    await ctx.reply(
      [
        `✅ Sinyal terdaftar — PortX Crypto Lab`,
        `PAIR: ${signal.pair}`,
        `SIDE: ${signal.side}`,
        `ENTRY: ${signal.entryLow} - ${signal.entryHigh}`,
        `SL: ${signal.stoploss}`,
        `Partial TP: ${(signal.partialTpPct * 100).toFixed(1)}%`,
        `Lifetime: ${signal.maxRuntimeMin} menit`,
      ].join('\n'),
      { reply_to_message_id: messageId }
    );
  } catch (err) {
    console.error('Error handling text:', err);
  }
});

// --- Helper: ambil harga dari MEXC spot ---
// GET https://api.mexc.com/api/v3/ticker/price?symbol=BTCUSDT
async function fetchPrice(symbol) {
  const url = 'https://api.mexc.com/api/v3/ticker/price';
  const res = await axios.get(url, { params: { symbol } });
  const price = parseFloat(res.data.price);
  if (Number.isNaN(price)) {
    throw new Error(`Invalid price from MEXC for ${symbol}`);
  }
  return price;
}

// --- Logic cek sinyal ---
async function checkSignals() {
  if (activeSignals.size === 0) return;

  for (const [id, signal] of activeSignals) {
    try {
      if (signal.closed) {
        activeSignals.delete(id);
        continue;
      }

      // Expire jika belum trigger dalam MAX_RUNTIME_MIN
      const ageMin = (Date.now() - signal.createdAt) / 60000;
      if (!signal.triggered && ageMin > signal.maxRuntimeMin) {
        await bot.telegram.sendMessage(
          signal.chatId,
          [
            `⏰ Sinyal EXPIRED — ${signal.pair}`,
            `Belum tersentuh entry dalam ${signal.maxRuntimeMin} menit.`,
            `PortX Crypto Lab — discipline first.`,
          ].join('\n')
        );
        signal.closed = true;
        activeSignals.delete(id);
        continue;
      }

      const price = await fetchPrice(signal.pair);

      // --- SIDE LONG ---
      if (signal.side === 'LONG') {
        // Trigger entry
        if (!signal.triggered && price >= signal.entryLow && price <= signal.entryHigh) {
          signal.triggered = true;
          signal.triggeredPrice = price;
          signal.triggeredAt = Date.now();

          await bot.telegram.sendMessage(
            signal.chatId,
            [
              `🟢 ENTRY TRIGGERED — ${signal.pair}`,
              `Side: LONG`,
              `Entry Zone: ${signal.entryLow} - ${signal.entryHigh}`,
              `Harga saat trigger: ${price}`,
              ``,
              `PortX Crypto Lab — Execute with discipline.`,
            ].join('\n')
          );
        }

        // Partial TP
        if (signal.triggered && !signal.partialNotified) {
          const gain = (price - signal.entryAvg) / signal.entryAvg;
          if (gain >= signal.partialTpPct) {
            signal.partialNotified = true;
            await bot.telegram.sendMessage(
              signal.chatId,
              [
                `🟡 PARTIAL TP HIT — ${signal.pair}`,
                `Floating profit: ${(gain * 100).toFixed(2)}%`,
                `Saran: partial TP & protect sisa posisi.`,
                ``,
                `PortX Crypto Lab — Protect profit, avoid greed.`,
              ].join('\n')
            );
          }
        }

        // Stoploss
        if (signal.triggered && price <= signal.stoploss) {
          signal.closed = true;
          await bot.telegram.sendMessage(
            signal.chatId,
            [
              `🔴 STOPLOSS HIT — ${signal.pair}`,
              `Side: LONG`,
              `SL: ${signal.stoploss}`,
              `Harga saat ini: ${price}`,
              ``,
              `PortX Crypto Lab — Loss kecil, nafas panjang.`,
            ].join('\n')
          );
          activeSignals.delete(id);
        }
      }

      // --- SIDE SHORT ---
      if (signal.side === 'SHORT') {
        // Trigger entry (short juga pakai range)
        if (!signal.triggered && price >= signal.entryLow && price <= signal.entryHigh) {
          signal.triggered = true;
          signal.triggeredPrice = price;
          signal.triggeredAt = Date.now();

          await bot.telegram.sendMessage(
            signal.chatId,
            [
              `🟢 ENTRY TRIGGERED — ${signal.pair}`,
              `Side: SHORT`,
              `Entry Zone: ${signal.entryLow} - ${signal.entryHigh}`,
              `Harga saat trigger: ${price}`,
              ``,
              `PortX Crypto Lab — Execute with discipline.`,
            ].join('\n')
          );
        }

        // Partial TP (short = harga turun)
        if (signal.triggered && !signal.partialNotified) {
          const gain = (signal.entryAvg - price) / signal.entryAvg;
          if (gain >= signal.partialTpPct) {
            signal.partialNotified = true;
            await bot.telegram.sendMessage(
              signal.chatId,
              [
                `🟡 PARTIAL TP HIT — ${signal.pair}`,
                `Side: SHORT`,
                `Floating profit: ${(gain * 100).toFixed(2)}%`,
                `Saran: partial TP & protect sisa posisi.`,
                ``,
                `PortX Crypto Lab — Protect profit, avoid greed.`,
              ].join('\n')
            );
          }
        }

        // Stoploss (short: harga naik)
        if (signal.triggered && price >= signal.stoploss) {
          signal.closed = true;
          await bot.telegram.sendMessage(
            signal.chatId,
            [
              `🔴 STOPLOSS HIT — ${signal.pair}`,
              `Side: SHORT`,
              `SL: ${signal.stoploss}`,
              `Harga saat ini: ${price}`,
              ``,
              `PortX Crypto Lab — Loss kecil, nafas panjang.`,
            ].join('\n')
          );
          activeSignals.delete(id);
        }
      }
    } catch (err) {
      console.error('Error in checkSignals for id', id, err.message);
    }
  }
}

// Cek sinyal tiap 5 detik
setInterval(checkSignals, 5000);

// Start bot
bot.launch().then(() => {
  console.log('PortX Crypto Lab bot running with MEXC price feed...');
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
