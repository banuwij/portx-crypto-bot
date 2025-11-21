// index.js
require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const Jimp = require('jimp');

const bot = new Telegraf(process.env.BOT_TOKEN);
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID;

// key: signalId, value: signal object
const activeSignals = new Map();
// histori sinyal yang sudah selesai (TP / SL / EXPIRED)
const history = [];
// daftar chat yang pernah pakai sinyal (untuk header pagi & recap)
const knownChats = new Set();

// --- Helper: normalisasi pair futures (BTCUSDT.P, BTCUSDT, BTC_USDT -> BTC_USDT) ---
function normalizeFuturesPair(raw) {
  if (!raw) return null;
  let p = raw.trim().toUpperCase();

  // buang suffix .P kalau ada
  if (p.endsWith('.P')) {
    p = p.slice(0, -2);
  }

  // BTC_USDT format, langsung pakai
  if (p.includes('_')) {
    return p;
  }

  // BTCUSDT -> BTC_USDT
  if (p.endsWith('USDT')) {
    const base = p.slice(0, -4); // hapus "USDT"
    return `${base}_USDT`;
  }

  return p;
}

// --- Preset trailing otomatis berdasarkan base coin ---
function getPresetTrailing(pair) {
  const base = (pair.split('_')[0] || pair).toUpperCase();

  // Major
  if (['BTC', 'ETH'].includes(base)) {
    return {
      trailStartPct: 0.025, // 2.5%
      trailGapPct: 0.015, // 1.5%
    };
  }

  // High-vol majors
  if (
    [
      'SOL',
      'AVAX',
      'TON',
      'DOGE',
      'OP',
      'APT',
      'ARB',
      'SEI',
      'SUI',
      'LINK',
    ].includes(base)
  ) {
    return {
      trailStartPct: 0.035, // 3.5%
      trailGapPct: 0.02, // 2.0%
    };
  }

  // Micro / lainnya (default agresif)
  if (
    [
      'ENA',
      'HIGH',
      '1INCH',
      'ACE',
      'ALT',
      'BLUR',
      'LQTY',
      'MEME',
      'PEPE',
      'ORDI',
      'WIF',
    ].includes(base)
  ) {
    return {
      trailStartPct: 0.05, // 5%
      trailGapPct: 0.035, // 3.5%
    };
  }

  // Fallback default
  return {
    trailStartPct: 0.03,
    trailGapPct: 0.02,
  };
}

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

  const normPair = normalizeFuturesPair(data.PAIR);
  if (!normPair) return null;

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

  // kalau kosong, nanti diisi preset
  const trailStartPct = data.TRAIL_START_PCT
    ? parseFloat(data.TRAIL_START_PCT)
    : null;
  const trailGapPct = data.TRAIL_GAP_PCT
    ? parseFloat(data.TRAIL_GAP_PCT)
    : null;

  const maxRuntimeMin = data.MAX_RUNTIME_MIN
    ? parseInt(data.MAX_RUNTIME_MIN, 10)
    : 720; // default 12 jam

  return {
    pair: normPair, // contoh futures: BTC_USDT
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
  const tpText = signal.takeProfit != null ? signal.takeProfit : '—';

  return [
    `${index}) ${signal.pair} — ${signal.side}`,
    `   Entry : ${signal.entryLow} - ${signal.entryHigh}`,
    `   SL    : ${signal.stoploss}`,
    `   TP    : ${tpText}`,
    `   Triggered  : ${triggeredText}`,
    `   Trailing   : ${trailText}`,
    `   Start/GAP  : ${(signal.trailStartPct * 100).toFixed(1)}% / ${(signal.trailGapPct * 100).toFixed(1)}%`,
    `   Umur       : ${ageMin} menit`,
  ].join('\n');
}

// --- Helper: simpan histori sinyal yang sudah selesai ---
function recordHistory(signal, outcome, priceAtClose) {
  history.push({
    chatId: signal.chatId,
    pair: signal.pair,
    side: signal.side,
    outcome, // 'TP' | 'SL' | 'EXPIRED'
    entryLow: signal.entryLow,
    entryHigh: signal.entryHigh,
    stoploss: signal.stoploss,
    takeProfit: signal.takeProfit,
    createdAt: signal.createdAt,
    closedAt: Date.now(),
    priceAtClose,
  });
}

// --- /id: bantu ambil chat id ---
bot.command('id', (ctx) => {
  ctx.reply(`Chat ID: ${ctx.chat.id}`);
});

// --- /status: lihat sinyal aktif di chat ini ---
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

// --- /send: DM ke bot → kirim sinyal ke TARGET_GROUP_ID ---
bot.command('send', async (ctx) => {
  try {
    if (!TARGET_GROUP_ID) {
      await ctx.reply(
        'TARGET_GROUP_ID belum diset di environment. Set dulu di Railway Variables.',
      );
      return;
    }

    if (ctx.chat.type !== 'private') {
      await ctx.reply('Gunakan /send via DM ke bot, bukan di group/channel.');
      return;
    }

    const lines = ctx.message.text.split('\n');
    const restLines = lines.slice(1); // buang baris "/send"
    const payload = restLines.join('\n').trim();

    if (!payload) {
      await ctx.reply(
        [
          'Format /send:',
          '/send',
          'PAIR: BTCUSDT.P',
          'SIDE: LONG',
          'ENTRY: 90300-90900',
          'STOPLOSS: 89550',
          'TAKE_PROFIT: 92300',
          'MAX_RUNTIME_MIN: 600',
        ].join('\n'),
      );
      return;
    }

    let body = payload;
    if (!/STATUS\s*:/.test(body.toUpperCase())) {
      body += '\nSTATUS: WAITING';
    }

    const block = `#PORTX_SIGNAL\n${body}\n#END_PORTX_SIGNAL`;

    const header = 'PortX Crypto Lab — Manual Signal\n';

    await bot.telegram.sendMessage(
      TARGET_GROUP_ID,
      `${header}\n${block}`,
    );

    await ctx.reply('Sinyal sudah dikirim ke channel/group PortX.');
  } catch (err) {
    console.error('/send error:', err.message);
    await ctx.reply('Terjadi error saat memproses /send.');
  }
});

// --- Handler teks: baca sinyal di semua chat yang mengandung #PORTX_SIGNAL ---
bot.on('text', async (ctx) => {
  try {
    const text = ctx.message.text;
    const parsed = parseSignalBlock(text);
    if (!parsed) return;

    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    const signalId = makeSignalId(chatId, messageId, parsed.pair);

    knownChats.add(chatId);

    const now = Date.now();
    const entryAvg = (parsed.entryLow + parsed.entryHigh) / 2;

    // apply preset trailing kalau user tidak isi
    let trailStartPct = parsed.trailStartPct;
    let trailGapPct = parsed.trailGapPct;
    if (!trailStartPct || Number.isNaN(trailStartPct) || trailStartPct <= 0) {
      const preset = getPresetTrailing(parsed.pair);
      trailStartPct = preset.trailStartPct;
      trailGapPct = preset.trailGapPct;
    } else if (!trailGapPct || Number.isNaN(trailGapPct) || trailGapPct <= 0) {
      trailGapPct = 0.02; // default gap kalau user cuma isi start
    }

    const signal = {
      id: signalId,
      chatId,
      messageId,
      pair: parsed.pair, // contoh: BTC_USDT
      side: parsed.side, // LONG / SHORT
      entryLow: parsed.entryLow,
      entryHigh: parsed.entryHigh,
      entryAvg,
      stoploss: parsed.stoploss,
      takeProfit: parsed.takeProfit,
      trailStartPct,
      trailGapPct,
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

// --- Handler foto: auto watermark chart ---
bot.on('photo', async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    knownChats.add(chatId);

    const photos = ctx.message.photo;
    if (!photos || photos.length === 0) return;

    // ambil resolusi paling besar
    const photo = photos[photos.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const url = fileLink.href || fileLink.toString();

    const image = await Jimp.read(url);
    const width = image.bitmap.width;
    const height = image.bitmap.height;

    // background semi transparan di bawah
    const overlayHeight = Math.round(height * 0.08);
    const overlay = new Jimp(width, overlayHeight, '#00000080'); // hitam transparan
    image.composite(overlay, 0, height - overlayHeight);

    // text watermark
    const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
    const text = 'PortX Crypto Lab — Futures Outlook';
    const textWidth = Jimp.measureText(font, text);
    const textX = Math.max(10, (width - textWidth) / 2);
    const textY = height - overlayHeight + (overlayHeight - 32) / 2;

    image.print(font, textX, textY, text);

    const buffer = await image.getBufferAsync(Jimp.MIME_PNG);

    const caption =
      ctx.message.caption ||
      'PortX Crypto Lab — Visual Outlook (auto watermarked).';

    // kirim foto baru dengan watermark
    await ctx.replyWithPhoto(
      { source: buffer },
      { caption, reply_to_message_id: ctx.message.message_id },
    );

    // coba hapus foto asli (kalau bot punya izin delete)
    try {
      await ctx.deleteMessage(ctx.message.message_id);
    } catch (errDel) {
      console.error('Delete original photo failed (no rights?):', errDel.message);
    }
  } catch (err) {
    console.error('Error processing photo watermark:', err.message);
  }
});

// --- Helper: ambil harga FUTURES dari MEXC ---
async function fetchPrice(symbol) {
  const url = `https://contract.mexc.com/api/v1/contract/index_price/${symbol}`;
  const res = await axios.get(url);
  if (!res.data || !res.data.data || typeof res.data.data.indexPrice === 'undefined') {
    throw new Error(`Invalid index price response for ${symbol}`);
  }
  const price = parseFloat(res.data.data.indexPrice);
  if (Number.isNaN(price)) {
    throw new Error(`Invalid index price for ${symbol}`);
  }
  return price;
}

// --- Logic trailing stop update ---
function handleTrailing(signal, price) {
  if (!signal.triggered) return { updated: false };

  if (signal.side === 'LONG') {
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
        signal.stoploss = targetSL;
        return {
          updated: true,
          newSL: targetSL,
          gainFromEntry,
        };
      }
    }
  }

  if (signal.side === 'SHORT') {
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
        signal.stoploss = targetSL;
        return {
          updated: true,
          newSL: targetSL,
          gainFromEntry,
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
          { reply_to_message_id: signal.messageId },
        );
        recordHistory(signal, 'EXPIRED', null);

        // auto delete pesan sinyal asli
        try {
          await bot.telegram.deleteMessage(signal.chatId, signal.messageId);
        } catch (errDel) {
          console.error('Delete expired signal failed:', errDel.message);
        }

        signal.closed = true;
        activeSignals.delete(id);
        continue;
      }

      const price = await fetchPrice(signal.pair);

      // --- SIDE LONG ---
      if (signal.side === 'LONG') {
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
              `Harga saat trigger (futures index): ${price}`,
              '',
              'PortX Crypto Lab — Execute with discipline.',
            ].join('\n'),
            { reply_to_message_id: signal.messageId },
          );
        }

        if (signal.triggered) {
          // TP biasa
          if (
            signal.takeProfit != null &&
            price >= signal.takeProfit
          ) {
            signal.closed = true;
            recordHistory(signal, 'TP', price);
            await bot.telegram.sendMessage(
              signal.chatId,
              [
                `🏁 TAKE PROFIT HIT — ${signal.pair}`,
                'Side: LONG',
                `TP: ${signal.takeProfit}`,
                `Harga saat ini (futures index): ${price}`,
                '',
                'PortX Crypto Lab — TP tercapai.',
              ].join('\n'),
              { reply_to_message_id: signal.messageId },
            );

            try {
              await bot.telegram.deleteMessage(signal.chatId, signal.messageId);
            } catch (errDel) {
              console.error('Delete TP signal failed:', errDel.message);
            }

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
              { reply_to_message_id: signal.messageId },
            );
          }

          // Stoploss
          if (price <= signal.stoploss) {
            signal.closed = true;
            recordHistory(signal, 'SL', price);
            await bot.telegram.sendMessage(
              signal.chatId,
              [
                `🔴 STOPLOSS HIT — ${signal.pair}`,
                'Side: LONG',
                `SL: ${signal.stoploss}`,
                `Harga saat ini (futures index): ${price}`,
                '',
                'PortX Crypto Lab — Loss kecil, nafas panjang.',
              ].join('\n'),
              { reply_to_message_id: signal.messageId },
            );

            try {
              await bot.telegram.deleteMessage(signal.chatId, signal.messageId);
            } catch (errDel) {
              console.error('Delete SL signal failed:', errDel.message);
            }

            activeSignals.delete(id);
            continue;
          }
        }
      }

      // --- SIDE SHORT ---
      if (signal.side === 'SHORT') {
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
              `Harga saat trigger (futures index): ${price}`,
              '',
              'PortX Crypto Lab — Execute with discipline.',
            ].join('\n'),
            { reply_to_message_id: signal.messageId },
          );
        }

        if (signal.triggered) {
          // TP biasa (short: harga turun)
          if (
            signal.takeProfit != null &&
            price <= signal.takeProfit
          ) {
            signal.closed = true;
            recordHistory(signal, 'TP', price);
            await bot.telegram.sendMessage(
              signal.chatId,
              [
                `🏁 TAKE PROFIT HIT — ${signal.pair}`,
                'Side: SHORT',
                `TP: ${signal.takeProfit}`,
                `Harga saat ini (futures index): ${price}`,
                '',
                'PortX Crypto Lab — TP tercapai.',
              ].join('\n'),
              { reply_to_message_id: signal.messageId },
            );

            try {
              await bot.telegram.deleteMessage(signal.chatId, signal.messageId);
            } catch (errDel) {
              console.error('Delete TP signal failed:', errDel.message);
            }

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
              { reply_to_message_id: signal.messageId },
            );
          }

          // Stoploss (short: harga naik)
          if (price >= signal.stoploss) {
            signal.closed = true;
            recordHistory(signal, 'SL', price);
            await bot.telegram.sendMessage(
              signal.chatId,
              [
                `🔴 STOPLOSS HIT — ${signal.pair}`,
                'Side: SHORT',
                `SL: ${signal.stoploss}`,
                `Harga saat ini (futures index): ${price}`,
                '',
                'PortX Crypto Lab — Loss kecil, nafas panjang.',
              ].join('\n'),
              { reply_to_message_id: signal.messageId },
            );

            try {
              await bot.telegram.deleteMessage(signal.chatId, signal.messageId);
            } catch (errDel) {
              console.error('Delete SL signal failed:', errDel.message);
            }

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

// --- Helper waktu Jakarta (UTC+7) ---
function getJakartaNow() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 7 * 60 * 60000);
}

let lastRecapDate = null;
let lastHeaderDate = null;

// --- Morning Header ---
async function sendMorningHeader() {
  const nowJkt = getJakartaNow();
  const dateStr = nowJkt.toISOString().slice(0, 10);

  for (const chatId of knownChats.values()) {
    const lines = [];
    lines.push('🌅 PortX Crypto Lab — Morning Briefing');
    lines.push(`Tanggal (WIB): ${dateStr}`);
    lines.push('');
    lines.push('Focus hari ini:');
    lines.push('• Trading hanya pada setup yang jelas.');
    lines.push('• Hormati SL, jangan kejar market.');
    lines.push('• Gunakan leverage seperlunya saja.');
    lines.push('');
    lines.push('PortX Crypto Lab — Prepare, then execute.');

    try {
      await bot.telegram.sendMessage(chatId, lines.join('\n'));
    } catch (err) {
      console.error('Error sending morning header to chat', chatId, err.message);
    }
  }
}

// --- Recap harian ---
async function sendDailyRecap() {
  const nowJkt = getJakartaNow();
  const todayStr = nowJkt.toISOString().slice(0, 10);
  const sinceTime = Date.now() - 24 * 60 * 60000;

  const byChat = new Map();

  for (const h of history) {
    if (h.closedAt < sinceTime) continue;
    if (!byChat.has(h.chatId)) {
      byChat.set(h.chatId, []);
    }
    byChat.get(h.chatId).push(h);
  }

  for (const [chatId, items] of byChat.entries()) {
    if (items.length === 0) continue;

    const total = items.length;
    const tpCount = items.filter((x) => x.outcome === 'TP').length;
    const slCount = items.filter((x) => x.outcome === 'SL').length;
    const expCount = items.filter((x) => x.outcome === 'EXPIRED').length;

    const lines = [];
    lines.push('🌙 PortX Crypto Lab — Daily Recap');
    lines.push(`Tanggal (WIB): ${todayStr}`);
    lines.push('');
    lines.push(`Total sinyal selesai: ${total}`);
    lines.push(`TP: ${tpCount} | SL: ${slCount} | Expired: ${expCount}`);
    lines.push('');
    lines.push('Detail:');

    for (const h of items) {
      const outcomeText =
        h.outcome === 'TP'
          ? 'TP'
          : h.outcome === 'SL'
            ? 'SL'
            : 'Expired';
      lines.push(
        `• ${h.pair} ${h.side} — ${outcomeText} (Entry ${h.entryLow}-${h.entryHigh}, SL ${h.stoploss}, TP ${h.takeProfit ?? '—'})`,
      );
    }

    lines.push('');
    lines.push('PortX Crypto Lab — Consistency over luck.');

    try {
      await bot.telegram.sendMessage(chatId, lines.join('\n'));
    } catch (err) {
      console.error('Error sending recap to chat', chatId, err.message);
    }
  }
}

// --- Scheduler recap harian & morning header ---
async function recapScheduler() {
  const nowJkt = getJakartaNow();
  const hh = nowJkt.getHours();
  const mm = nowJkt.getMinutes();
  const todayStr = nowJkt.toISOString().slice(0, 10);

  // Morning header jam 07:00 WIB
  if (hh === 7 && mm === 0 && lastHeaderDate !== todayStr) {
    console.log('Running morning header for', todayStr);
    await sendMorningHeader();
    lastHeaderDate = todayStr;
  }

  // Recap harian jam 23:59 WIB
  if (hh === 23 && mm === 59 && lastRecapDate !== todayStr) {
    console.log('Running daily recap for', todayStr);
    await sendDailyRecap();
    lastRecapDate = todayStr;
  }
}

// Cek sinyal tiap 5 detik
setInterval(checkSignals, 5000);
// Cek apakah waktunya recap/header tiap 60 detik
setInterval(recapScheduler, 60000);

// Start bot
bot.launch().then(() => {
  console.log(
    'PortX Crypto Lab bot running with MEXC FUTURES index price + TP + trailing SL + presets + daily recap + morning header + watermark + auto-delete + /send...',
  );
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
