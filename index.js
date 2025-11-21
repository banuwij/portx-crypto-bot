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
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

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
  let entryLow;
  let entryHigh;
  if (data.ENTRY.includes('-')) {
    const [lowStr, highStr] = data.ENTRY.split('-').map((s) => s.trim());
    entryLow = parseFloat(lowStr);
    entryHigh = parseFloat(highStr);
  } else {
    const val = parseFloat(data.ENTRY);
    entryLow = val;
    entryHigh = val;
  }

  const stoploss = parseFloat(data.STOPLOSS);
  const takeProfit = data.TAKE_PROFIT ? parseFloat(data.TAKE_PROFIT) : null;

  const trailStartPct = data.TRAIL_START_PCT
    ? parseFloat(data.TRAIL_START_PCT)
    : 0.03; // default mulai trailing di +3%
  const trailGapPct = data.TRAIL_GAP_PCT
    ? parseFloat(data.TRAIL_GAP_PCT)
    : 0.02; // default jarak trailing 2%

  const maxRuntimeMin = data.MAX_RUNTIME_MIN
    ? parseInt(data.MAX_RUNTIME_MIN, 10)
    : 720; // default 12 jam

  return {
    pair: data.PAIR.toUpperCase(),
    side: data.SIDE.toUpperCase(), // LONG / SHORT
    entryLow,
    entryHigh,
    stoploss,
    takeProfit,
    trailStartPct,
    trailGapPct,
    maxRuntimeMin,
  };
}

// --- Helper: format ID sinyal ---
function makeSignalId(chatId, messageId, pair) {
  return `${chatId}_${messageId}_${pair}`;
}

// --- Helper: format status sinyal untuk /status ---
function formatSignalStatus(signal, index) {
  const ageMin = ((Date.now() - signal.createdAt) / 60000).toFixed(1);
  const triggeredText = signal.triggered ? 'YA' : 'BELUM';
  const trailText = signal.trailingActive ? 'AKTIF' : 'BELUM';
  const tpText =
    signal.takeProfit != null ? signal.takeProfit : '—';

  return [
    `${index}) ${signal.pair} — ${signal.side}`,
    `   Entry : ${signal.entryLow} - ${signal.entryHigh}`,
    `   SL    : ${signal.stoploss}`,
    `   TP    : ${tpText}`,
    `   Triggered  : ${triggeredText}`,
    `   Trailing   : ${trailText}`,
    `   Umur       : ${ageMin} menit`,
  ].join('\n');
}

// --- Command: /status untuk lihat semua sinyal aktif di chat ini ---
bot.command('status', async (ctx) => {
  try {
    const chatId = ctx.chat.id;

    const signalsInChat = [];
    let idx = 1;
    for (const signal of activeSignals.values()) {
      if (signal.chatId === chatId && !signal.closed) {
        signalsInChat.push(formatSignalStatus(signal, idx));
        idx += 1;
      }
    }

    if (signalsInChat.length === 0) {
      await ctx.reply(
        [
          '📊 PortX Crypto Lab — Status Sinyal',
          'Tidak ada sinyal aktif untuk chat ini.',
        ].join('\n'),
      );
      return;
    }

    const header = '📊 PortX Crypto Lab — Sinyal Aktif\n';
    const body = signalsInChat.join('\n\n');
    await ctx.reply(header + body);
  } catch (err) {
    console.error('/status error:', err.message);
    await ctx.reply('Terjadi error saat membaca status sinyal.');
  }
});

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
      takeProfit: parsed.takeProfit,
      trailStartPct: parsed.trailStartPct,
      trailGapPct: parsed.trailGapPct,
      maxRuntimeMin: parsed.maxRuntimeMin,
      createdAt: now,
      triggered: false,
      trailingActive: false,
      highestPrice: null, // untuk LONG
      lowestPrice: null, // untuk SHORT
      closed: false,
    };

    activeSignals.set(signalId, signal);

    await ctx.reply(
      [
        '✅ Sinyal terdaftar — PortX Crypto Lab',
        `PAIR: ${signal.pair}`,
        `SIDE: ${signal.side}`,
        `ENTRY: ${signal.entryLow} - ${signal.entryHigh}`,
        `SL: ${signal.stoploss}`,
        `TP: ${signal.takeProfit != null ? signal.takeProfit : '—'}`,
        `Trailing start: ${(signal.trailStartPct * 100).toFixed(1)}%`,
        `Trailing gap  : ${(signal.trailGapPct * 100).toFixed(1)}%`,
        `Lifetime: ${signal.maxRuntimeMin} menit`,
      ].join('\n'),
      { reply_to_message_id: messageId },
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

// --- Logic trailing stop update ---
function handleTrailing(signal, price) {
  // hanya bekerja setelah entry triggered
  if (!signal.triggered) return;

  if (signal.side === 'LONG') {
    // update highestPrice
    if (signal.highestPrice == null || price > signal.highestPrice) {
      signal.highestPrice = price;
    }

    const gainFromEntry =
      (signal.highestPrice - signal.entryAvg) / signal.entryAvg;

    if (gainFromEntry >= signal.trailStartPct) {
      if (!signal.trailingActive) {
        signal.trailingActive = true;
      }

      const targetSL =
        signal.highestPrice * (1 - signal.trailGapPct);

      if (targetSL > signal.stoploss) {
        // geser SL naik
        signal.stoploss = targetSL;
        return {
          updated: true,
          newSL: targetSL,
          gainFromEntry:
            (signal.highestPrice - signal.entryAvg) / signal.entryAvg,
        };
      }
    }
  }

  if (signal.side === 'SHORT') {
    // update lowestPrice
    if (signal.lowestPrice == null || price < signal.lowestPrice) {
      signal.lowestPrice = price;
    }

    const gainFromEntry =
      (signal.entryAvg - signal.lowestPrice) / signal.entryAvg;

    if (gainFromEntry >= signal.trailStartPct) {
      if (!signal.trailingActive) {
        signal.trailingActive = true;
      }

      const targetSL =
        signal.lowestPrice * (1 + signal.trailGapPct);

      if (targetSL < signal.stoploss) {
        // geser SL turun (lebih ketat) untuk SHORT
        signal.stoploss = targetSL;
        return {
          updated: true,
          newSL: targetSL,
          gainFromEntry:
            (signal.entryAvg - signal.lowestPrice) / signal.entryAvg,
        };
      }
    }
  }

  return { updated: false };
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
            'PortX Crypto Lab — discipline first.',
          ].join('\n'),
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
          signal.highestPrice = price;

          await bot.telegram.sendMessage(
            signal.chatId,
            [
              `🟢 ENTRY TRIGGERED — ${signal.pair}`,
              'Side: LONG',
              `Entry Zone: ${signal.entryLow} - ${signal.entryHigh}`,
              `Harga saat trigger: ${price}`,
              '',
              'PortX Crypto Lab — Execute with discipline.',
            ].join('\n'),
          );
        }

        // Kalau sudah triggered → cek TP & trailing & SL
        if (signal.triggered) {
          // TP biasa
          if (
            signal.takeProfit != null &&
            price >= signal.takeProfit
          ) {
            signal.closed = true;
            await bot.telegram.sendMessage(
              signal.chatId,
              [
                `🏁 TAKE PROFIT HIT — ${signal.pair}`,
                'Side: LONG',
                `TP: ${signal.takeProfit}`,
                `Harga saat ini: ${price}`,
                '',
                'PortX Crypto Lab — TP tercapai.',
              ].join('\n'),
            );
            activeSignals.delete(id);
            continue;
          }

          // Trailing SL logic
          const trailResult = handleTrailing(signal, price);
          if (trailResult.updated) {
            await bot.telegram.sendMessage(
              signal.chatId,
              [
                `🔧 TRAILING SL UPDATED — ${signal.pair}`,
                'Side: LONG',
                `SL baru: ${trailResult.newSL.toFixed(4)}`,
                `Max gain tercatat: ${(trailResult.gainFromEntry * 100).toFixed(2)}%`,
                '',
                'PortX Crypto Lab — Protect profit, avoid greed.',
              ].join('\n'),
            );
          }

          // Stoploss (bisa SL awal atau SL hasil trailing)
          if (price <= signal.stoploss) {
            signal.closed = true;
            await bot.telegram.sendMessage(
              signal.chatId,
              [
                `🔴 STOPLOSS HIT — ${signal.pair}`,
                'Side: LONG',
                `SL: ${signal.stoploss}`,
                `Harga saat ini: ${price}`,
                '',
                'PortX Crypto Lab — Loss kecil, nafas panjang.',
              ].join('\n'),
            );
            activeSignals.delete(id);
            continue;
          }
        }
      }

      // --- SIDE SHORT ---
      if (signal.side === 'SHORT') {
        // Trigger entry (short juga pakai range)
        if (!signal.triggered && price >= signal.entryLow && price <= signal.entryHigh) {
          signal.triggered = true;
          signal.triggeredPrice = price;
          signal.triggeredAt = Date.now();
          signal.lowestPrice = price;

          await bot.telegram.sendMessage(
            signal.chatId,
            [
              `🟢 ENTRY TRIGGERED — ${signal.pair}`,
              'Side: SHORT',
              `Entry Zone: ${signal.entryLow} - ${signal.entryHigh}`,
              `Harga saat trigger: ${price}`,
              '',
              'PortX Crypto Lab — Execute with discipline.',
            ].join('\n'),
          );
        }

        if (signal.triggered) {
          // TP biasa (short: harga turun)
          if (
            signal.takeProfit != null &&
            price <= signal.takeProfit
          ) {
            signal.closed = true;
            await bot.telegram.sendMessage(
              signal.chatId,
              [
                `🏁 TAKE PROFIT HIT — ${signal.pair}`,
                'Side: SHORT',
                `TP: ${signal.takeProfit}`,
                `Harga saat ini: ${price}`,
                '',
                'PortX Crypto Lab — TP tercapai.',
              ].join('\n'),
            );
            activeSignals.delete(id);
            continue;
          }

          // Trailing SL logic
          const trailResult = handleTrailing(signal, price);
          if (trailResult.updated) {
            await bot.telegram.sendMessage(
              signal.chatId,
              [
                `🔧 TRAILING SL UPDATED — ${signal.pair}`,
                'Side: SHORT',
                `SL baru: ${trailResult.newSL.toFixed(4)}`,
                `Max gain tercatat: ${(trailResult.gainFromEntry * 100).toFixed(2)}%`,
                '',
                'PortX Crypto Lab — Protect profit, avoid greed.',
              ].join('\n'),
            );
          }

          // Stoploss (short: harga naik)
          if (price >= signal.stoploss) {
            signal.closed = true;
            await bot.telegram.sendMessage(
              signal.chatId,
              [
                `🔴 STOPLOSS HIT — ${signal.pair}`,
                'Side: SHORT',
                `SL: ${signal.stoploss}`,
                `Harga saat ini: ${price}`,
                '',
                'PortX Crypto Lab — Loss kecil, nafas panjang.',
              ].join('\n'),
            );
            activeSignals.delete(id);
            continue;
          }
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
  console.log('PortX Crypto Lab bot running with MEXC price feed + TP + trailing SL...');
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
