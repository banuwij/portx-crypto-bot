// index.js
// PortX Crypto Lab – Simple Futures Signal Engine + MEXC Sync
// Single file, siap deploy di Railway.

// ========== IMPORTS ==========
require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const crypto = require('crypto');

// ========== ENV & CONFIG ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID
  ? Number(process.env.TARGET_GROUP_ID)
  : -1003433381485; // fallback ke ID group yang kamu pakai
const MEXC_API_KEY = process.env.MEXC_API_KEY;
const MEXC_SECRET_KEY = process.env.MEXC_SECRET_KEY;

// default: TEST → /send cuma reply di DM, tapi sinyal tetap masuk engine
let MODE = 'TEST';

// Map sinyal aktif: key = signalId, value = object
const activeSignals = new Map();

// ========== HELPER FUNCTIONS ==========

function nowMs() {
  return Date.now();
}

function minutesFromNow(min) {
  return nowMs() + min * 60 * 1000;
}

// Normalisasi pair futures:
// BTCUSDT.P → BTC_USDT
// BNBUSDT.P → BNB_USDT
function normalizePair(raw) {
  if (!raw) return null;
  let p = raw.trim().toUpperCase();

  // Hilangkan suffix .P untuk perpetual
  if (p.endsWith('.P')) {
    p = p.slice(0, -2);
  }

  // Kalau sudah ada underscore, biarkan
  if (p.includes('_')) return p;

  // Kalau format standard BTCUSDT → BTC_USDT
  if (p.endsWith('USDT')) {
    const base = p.slice(0, -4);
    const quote = p.slice(-4); // USDT
    return `${base}_${quote}`;
  }

  return p;
}

// Ambil harga spot (pakai MEXC spot API untuk referensi harga)
async function fetchPrice(pair) {
  try {
    const symbol = pair.replace('_', ''); // BTC_USDT → BTCUSDT
    const url = `https://api.mexc.com/api/v3/ticker/price?symbol=${symbol}`;
    const res = await axios.get(url);
    const price = parseFloat(res.data.price);
    if (Number.isNaN(price)) throw new Error('invalid price');
    return price;
  } catch (err) {
    console.error('fetchPrice error:', err.message);
    return null;
  }
}

// ========== PARSER #portx ... #end ==========
// Format:
/*
#portx
PAIR: BNBUSDT.P
SIDE: LONG
ENTRY: 845.36
STOPLOSS: 832.48
TAKE_PROFIT: 876.88
MAX_RUNTIME_MIN: 100
#end
*/

function parsePortxBlock(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const startIndex = lower.indexOf('#portx');
  const endIndex = lower.indexOf('#end');

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return null;
  }

  const block = text.slice(startIndex, endIndex);
  const lines = block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.toLowerCase().startsWith('#portx'));

  const signal = {
    pair: null,
    side: null,
    entryMin: null,
    entryMax: null,
    sl: null,
    tp: null,
    maxRuntimeMin: 720, // default 12 jam
    note: null,
  };

  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const rawKey = line.slice(0, idx).trim();
    const rawVal = line.slice(idx + 1).trim();
    const key = rawKey.toUpperCase();
    const val = rawVal;

    if (key === 'PAIR') {
      signal.pair = normalizePair(val);
    } else if (key === 'SIDE') {
      signal.side = val.toUpperCase();
    } else if (key === 'ENTRY') {
      if (val.includes('-')) {
        const [a, b] = val.split('-').map((v) => parseFloat(v.trim()));
        signal.entryMin = a;
        signal.entryMax = b;
      } else {
        const p = parseFloat(val);
        signal.entryMin = p;
        signal.entryMax = p;
      }
    } else if (key === 'STOPLOSS') {
      signal.sl = parseFloat(val);
    } else if (key === 'TAKE_PROFIT') {
      signal.tp = parseFloat(val);
    } else if (key === 'MAX_RUNTIME_MIN') {
      signal.maxRuntimeMin = parseInt(val, 10);
    } else if (key === 'NOTE') {
      signal.note = val;
    }
  }

  if (!signal.pair || !signal.side || !signal.entryMin || !signal.sl) {
    return null; // minimal butuh pair, side, entry, SL
  }

  return signal;
}

// ========== MEXC FUTURES POSITION SYNC ==========

function mexcSign(secret, reqTime, method, path, body = '') {
  const text = `${reqTime}${method}${path}${body}`;
  return crypto.createHmac('sha256', secret).update(text).digest('hex');
}

async function getMexcPositions() {
  if (!MEXC_API_KEY || !MEXC_SECRET_KEY) {
    return [];
  }

  try {
    const baseUrl = 'https://contract.mexc.com';
    const path = '/api/v1/private/position/list';
    const reqTime = Date.now().toString();
    const method = 'GET';
    const body = '';

    const sig = mexcSign(MEXC_SECRET_KEY, reqTime, method, path, body);

    const res = await axios.get(baseUrl + path, {
      headers: {
        ApiKey: MEXC_API_KEY,
        'Request-Time': reqTime,
        Signature: sig,
      },
    });

    if (!res.data || !Array.isArray(res.data.data)) {
      return [];
    }
    return res.data.data;
  } catch (err) {
    console.error('getMexcPositions error:', err.response?.data || err.message);
    return [];
  }
}

// Auto attach posisi ke sinyal aktif
async function syncPositionsToSignals() {
  if (activeSignals.size === 0) return;
  const positions = await getMexcPositions();
  if (!positions || positions.length === 0) {
    // kosong saja, tidak perlu spam log
    return;
  }

  for (const [, sig] of activeSignals) {
    sig.livePosition = null;
  }

  for (const p of positions) {
    const norm = normalizePair(p.symbol);
    for (const [, sig] of activeSignals) {
      if (sig.pair === norm) {
        sig.livePosition = {
          side: p.positionType === 1 ? 'LONG' : 'SHORT',
          volume: p.volume,
          entry: p.openAvgPrice,
          leverage: p.leverage,
          liq: p.liquidationPrice,
          pnl: p.unrealizedPnl,
        };
      }
    }
  }
}

// ========== ENGINE: ENTRY / TP / SL / EXPIRE ==========

async function processSignals() {
  if (activeSignals.size === 0) return;

  for (const [id, sig] of activeSignals) {
    try {
      const price = await fetchPrice(sig.pair);
      if (!price) continue;

      // Expired?
      if (!sig.closed && nowMs() >= sig.expireAt) {
        sig.closed = true;
        activeSignals.delete(id);
        await bot.telegram.sendMessage(
          sig.chatId,
          `⏰ Sinyal EXPIRED – ${sig.pair} (${sig.side})\nTidak tersentuh atau sudah melewati durasi ${sig.maxRuntimeMin} menit.`,
        );
        continue;
      }

      // Entry trigger
      if (!sig.triggered && price >= sig.entryMin && price <= sig.entryMax) {
        sig.triggered = true;
        sig.triggeredAt = nowMs();
        sig.triggerPrice = price;
        await bot.telegram.sendMessage(
          sig.chatId,
          [
            `✅ ENTRY TRIGGERED – ${sig.pair} (${sig.side})`,
            `Entry Zone: ${sig.entryMin} – ${sig.entryMax}`,
            `Harga saat trigger: ${price}`,
          ].join('\n'),
        );
      }

      if (!sig.triggered) {
        continue;
      }

      // TP & SL logic
      if (sig.side === 'LONG') {
        if (sig.tp && price >= sig.tp && !sig.closed) {
          sig.closed = true;
          activeSignals.delete(id);
          await bot.telegram.sendMessage(
            sig.chatId,
            [
              `🏁 TAKE PROFIT HIT – ${sig.pair} (LONG)`,
              `TP: ${sig.tp}`,
              `Harga saat TP: ${price}`,
            ].join('\n'),
          );
          continue;
        }

        if (sig.sl && price <= sig.sl && !sig.closed) {
          sig.closed = true;
          activeSignals.delete(id);
          await bot.telegram.sendMessage(
            sig.chatId,
            [
              `🔴 STOP LOSS HIT – ${sig.pair} (LONG)`,
              `SL: ${sig.sl}`,
              `Harga saat SL: ${price}`,
            ].join('\n'),
          );
          continue;
        }
      } else if (sig.side === 'SHORT') {
        if (sig.tp && price <= sig.tp && !sig.closed) {
          sig.closed = true;
          activeSignals.delete(id);
          await bot.telegram.sendMessage(
            sig.chatId,
            [
              `🏁 TAKE PROFIT HIT – ${sig.pair} (SHORT)`,
              `TP: ${sig.tp}`,
              `Harga saat TP: ${price}`,
            ].join('\n'),
          );
          continue;
        }

        if (sig.sl && price >= sig.sl && !sig.closed) {
          sig.closed = true;
          activeSignals.delete(id);
          await bot.telegram.sendMessage(
            sig.chatId,
            [
              `🔴 STOP LOSS HIT – ${sig.pair} (SHORT)`,
              `SL: ${sig.sl}`,
              `Harga saat SL: ${price}`,
            ].join('\n'),
          );
          continue;
        }
      }
    } catch (err) {
      console.error('processSignals error:', err.message);
    }
  }
}

// ========== BOT INIT ==========

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN belum diset di environment.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ========== COMMANDS ==========

// Mode LIVE / TEST
bot.command('mode_live', (ctx) => {
  MODE = 'LIVE';
  ctx.reply('Mode di-set ke LIVE. /send akan kirim ke channel.');
});

bot.command('mode_test', (ctx) => {
  MODE = 'TEST';
  ctx.reply('Mode di-set ke TEST. /send hanya tampil di DM, tapi engine tetap jalan.');
});

bot.command('mode_status', (ctx) => {
  ctx.reply(`Mode sekarang: ${MODE}`);
});

// Cek ID
bot.command('id', (ctx) => {
  ctx.reply(`Chat ID: ${ctx.chat.id}\nUser ID: ${ctx.from.id}`);
});

// Status sinyal aktif di chat ini
bot.command('status', (ctx) => {
  const chatId = ctx.chat.id;
  const list = [];
  let i = 1;

  for (const [, sig] of activeSignals) {
    if (sig.chatId !== chatId) continue;
    const ageMin = ((nowMs() - sig.createdAt) / 60000).toFixed(1);
    const header = `${i}) ${sig.pair} (${sig.side})`;
    const baseInfo = [
      `Entry: ${sig.entryMin} – ${sig.entryMax}`,
      `SL   : ${sig.sl}`,
      `TP   : ${sig.tp ?? '—'}`,
      `Triggered: ${sig.triggered ? 'YES' : 'NO'}`,
      `Umur: ${ageMin} menit`,
    ].join('\n');
    let liveText = '';
    if (sig.livePosition) {
      const lp = sig.livePosition;
      liveText =
        '\nPosisi MEXC:\n' +
        `Side : ${lp.side}\n` +
        `Size : ${lp.volume}\n` +
        `Entry: ${lp.entry}\n` +
        `Lev  : ${lp.leverage}x\n` +
        `Liq  : ${lp.liq}\n` +
        `PnL  : ${lp.pnl}`;
    }
    list.push(header + '\n' + baseInfo + liveText);
    i += 1;
  }

  if (list.length === 0) {
    ctx.reply('Tidak ada sinyal aktif untuk chat ini.');
    return;
  }

  ctx.reply('📊 PortX – Sinyal Aktif\n\n' + list.join('\n\n'));
});

// Kirim sinyal via DM /send
bot.command('send', async (ctx) => {
  const isPrivate = ctx.chat.type === 'private';
  const lines = ctx.message.text.split('\n');
  const payload = lines.slice(1).join('\n').trim();

  if (!payload) {
    ctx.reply(
      [
        'Format /send:',
        '/send',
        '#portx',
        'PAIR: BNBUSDT.P',
        'SIDE: LONG',
        'ENTRY: 845.36',
        'STOPLOSS: 832.48',
        'TAKE_PROFIT: 876.88',
        'MAX_RUNTIME_MIN: 100',
        '#end',
      ].join('\n'),
    );
    return;
  }

  const parsed = parsePortxBlock(payload);
  if (!parsed) {
    ctx.reply('Sinyal tidak valid / kurang field wajib.');
    return;
  }

  const signalId = 'S' + nowMs();
  const sig = {
    id: signalId,
    pair: parsed.pair,
    side: parsed.side,
    entryMin: parsed.entryMin,
    entryMax: parsed.entryMax,
    sl: parsed.sl,
    tp: parsed.tp,
    maxRuntimeMin: parsed.maxRuntimeMin,
    note: parsed.note || null,
    createdAt: nowMs(),
    expireAt: minutesFromNow(parsed.maxRuntimeMin),
    triggered: false,
    closed: false,
    chatId: TARGET_GROUP_ID,
    livePosition: null,
  };

  activeSignals.set(signalId, sig);

  const msgLines = [];
  msgLines.push('🧭 *PortX Crypto Lab – Futures Signal*');
  msgLines.push('');
  msgLines.push(`*PAIR*  : \`${sig.pair}\``);
  msgLines.push(`*SIDE*  : *${sig.side}*`);
  msgLines.push(`*ENTRY* : \`${sig.entryMin} – ${sig.entryMax}\``);
  msgLines.push(`*SL*    : \`${sig.sl}\``);
  msgLines.push(`*TP*    : \`${sig.tp ?? 'secukupnya (open TP)'}\``);
  msgLines.push(
    `🕒 *Maks. durasi* : \`${sig.maxRuntimeMin} menit\` (auto EXPIRED kalau tidak jalan)`,
  );
  if (sig.note) {
    msgLines.push('');
    msgLines.push(`📝 *Catatan* : ${sig.note}`);
  }
  msgLines.push('');
  msgLines.push('```');
  msgLines.push('#portx');
  msgLines.push(`PAIR: ${parsed.pair}`);
  msgLines.push(`SIDE: ${parsed.side}`);
  msgLines.push(
    `ENTRY: ${
      parsed.entryMin === parsed.entryMax
        ? parsed.entryMin
        : parsed.entryMin + '-' + parsed.entryMax
    }`,
  );
  msgLines.push(`STOPLOSS: ${parsed.sl}`);
  if (parsed.tp) msgLines.push(`TAKE_PROFIT: ${parsed.tp}`);
  msgLines.push(`MAX_RUNTIME_MIN: ${parsed.maxRuntimeMin}`);
  if (parsed.note) msgLines.push(`NOTE: ${parsed.note}`);
  msgLines.push('#end');
  msgLines.push('```');

  const fullText = msgLines.join('\n');

  if (MODE === 'TEST') {
    await ctx.reply(
      '🧪 *TEST MODE* – sinyal TIDAK dikirim ke channel, hanya preview.\n\n' +
        fullText,
      { parse_mode: 'Markdown' },
    );
  } else {
    await bot.telegram.sendMessage(TARGET_GROUP_ID, fullText, {
      parse_mode: 'Markdown',
    });
    if (isPrivate) {
      await ctx.reply('Sinyal sudah dikirim ke channel dan masuk engine.');
    }
  }
});

// /mypos – cek posisi futures aktif di MEXC
bot.command('mypos', async (ctx) => {
  const positions = await getMexcPositions();
  if (!positions || positions.length === 0) {
    ctx.reply('❌ Tidak ada posisi Futures aktif di MEXC.');
    return;
  }

  let out = '📊 *Futures Positions – MEXC*\n\n';
  for (const p of positions) {
    const pair = normalizePair(p.symbol);
    const side = p.positionType === 1 ? '🟢 LONG' : '🔴 SHORT';
    out +=
      `• *${pair}*\n` +
      `  Side : ${side}\n` +
      `  Size : ${p.volume}\n` +
      `  Entry: ${p.openAvgPrice}\n` +
      `  Lev  : ${p.leverage}x\n` +
      `  Liq  : ${p.liquidationPrice}\n` +
      `  PnL  : ${p.unrealizedPnl}\n\n`;
  }

  ctx.reply(out, { parse_mode: 'Markdown' });
});

// Handler text biasa – kalau kamu ngetik manual blok #portx di group, tetap ke-detect
bot.on('text', (ctx) => {
  const text = ctx.message.text || '';
  const parsed = parsePortxBlock(text);
  if (!parsed) return;

  const signalId = 'S' + nowMs();
  const sig = {
    id: signalId,
    pair: parsed.pair,
    side: parsed.side,
    entryMin: parsed.entryMin,
    entryMax: parsed.entryMax,
    sl: parsed.sl,
    tp: parsed.tp,
    maxRuntimeMin: parsed.maxRuntimeMin,
    note: parsed.note || null,
    createdAt: nowMs(),
    expireAt: minutesFromNow(parsed.maxRuntimeMin),
    triggered: false,
    closed: false,
    chatId: ctx.chat.id,
    livePosition: null,
  };

  activeSignals.set(signalId, sig);
  ctx.reply(
    [
      `✅ Sinyal terdaftar – ${sig.pair} (${sig.side})`,
      `Entry: ${sig.entryMin} – ${sig.entryMax}`,
      `SL   : ${sig.sl}`,
      `TP   : ${sig.tp ?? 'secukupnya (open TP)'}`,
      `Durasi: ${sig.maxRuntimeMin} menit`,
    ].join('\n'),
  );
});

// ========== INTERVALS ==========

// Engine cek sinyal tiap 5 detik
setInterval(processSignals, 5000);

// Sync posisi MEXC ke sinyal tiap 10 detik
setInterval(syncPositionsToSignals, 10000);

// ========== START BOT ==========
bot.launch().then(() => {
  console.log('PortX Crypto Lab engine running (simple) with MEXC sync.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
