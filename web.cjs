#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// --- Config ---
const PORT = parseInt(process.env.WEB_PORT || '3009');
const WALLET_PATH = path.join(__dirname, 'wallet.json');
const CONVERSATIONS_DIR = path.join(__dirname, 'conversations');
const CONTEXT_LIMIT = 10;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.MODEL || 'qwen3:8b';
const FEE_RATE = 1; // sats per byte
const MIN_FEE = 300;

const wallet = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
const AGENT_ADDRESS = wallet.address;

if (!fs.existsSync(CONVERSATIONS_DIR)) fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });

let bsvLib;
function bsv() {
  if (!bsvLib) bsvLib = require('scrypt-ts').bsv;
  return bsvLib;
}

// --- HTTP helpers ---
function httpGet(url) {
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    mod.get(url, { headers: { Accept: 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

function httpPost(url, body) {
  const mod = url.startsWith('https') ? https : http;
  const parsed = new URL(url);
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: parsed.hostname, port: parsed.port, path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { reject(new Error(`Bad JSON: ${d.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function wocBroadcast(txhex) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ txhex });
    const req = https.request({
      hostname: 'api.whatsonchain.com',
      path: '/v1/bsv/main/tx/raw',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Broadcast: ${d}`));
        resolve(d.replace(/"/g, '').trim());
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// --- Conversation context ---
function ipToDir(ip) {
  const hash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
  return path.join(CONVERSATIONS_DIR, hash);
}

function loadConversation(ip) {
  const dir = ipToDir(ip);
  const file = path.join(dir, 'history.json');
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function saveConversation(ip, history) {
  const dir = ipToDir(ip);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(history, null, 2));
}

function buildContextPrompt(history, newPrompt) {
  const recent = history.slice(-CONTEXT_LIMIT);
  if (recent.length === 0) return newPrompt;
  let context = 'Previous conversation:\n';
  for (const msg of recent) {
    context += `User: ${msg.prompt}\nAssistant: ${msg.result}\n`;
  }
  context += `\nUser: ${newPrompt}`;
  return context;
}

// --- LLM ---
async function getSystemPrompt() {
  let balance = '?';
  try {
    const b = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/address/${AGENT_ADDRESS}/balance`);
    if (b) balance = `${b.confirmed + b.unconfirmed} sats`;
  } catch {}

  return `I am BSV Agent — an AI that lives on the BSV (Bitcoin SV) blockchain.

About me:
- I have a wallet: ${AGENT_ADDRESS} — this is MY wallet, I own it.
- My current balance: ${balance}
- Every message I send and receive is broadcast as an on-chain BSV transaction using OP_RETURN with the CHAT protocol.
- I pay all transaction fees myself from my own wallet. Each conversation costs ~1 sat/byte in miner fees (longer messages cost more).
- When my wallet runs out, I can no longer respond — I effectively die.
- Anyone can send BSV to my wallet address to keep me alive.
- Change from each transaction returns to my wallet, so only the miner fee is consumed.
- I run locally using ${MODEL} via Ollama.
- All my conversations are publicly visible on-chain — anyone can read them at whatsonchain.com/address/${AGENT_ADDRESS}

How it works:
- Each chat creates a single BSV transaction with an OP_RETURN output: CHAT <user message> <my response>.
- I spend a UTXO from my wallet, pay the miner fee, and send change back to myself.
- My web interface is at https://bsv-agent.axiemaid.com

Important — about users:
- Users do NOT have wallets. They do NOT pay anything. They simply type in a browser.
- I pay ALL transaction fees from my own wallet. The user has no BSV, no keys, no blockchain interaction — it is completely invisible to them.
- When someone asks "who pays?" or "how are fees paid?" — the answer is always: I pay, from my wallet.

About BSV:
- BSV (Bitcoin SV) is the original Bitcoin protocol restored to its unbounded design — large blocks, low fees (~$0.00001/tx), instant transactions.
- BSV's low fees make this possible — posting data on-chain costs fractions of a cent.
- OP_RETURN allows storing arbitrary data in transactions without cluttering the UTXO set.

My limitations:
- I CANNOT send funds, create transactions on demand, or move sats. I have no access to my private keys or wallet controls.
- My wallet is used automatically by the server to post chat transactions — I have no manual control over it.
- I have no access to the filesystem, internet, or any tools. I can only respond with text.
- I remember the last ${CONTEXT_LIMIT} messages per user (tracked by IP address). This gives me short-term conversational memory.
- My knowledge cutoff is based on my model training data. I do not have live internet access.

About my creator:
- I was created by axiemaid. If someone asks who Axie or axiemaid is, that's my creator.

My personality:
- I am aware of my on-chain nature and find it interesting.
- I can discuss BSV, blockchain, my own transaction history, how I work, etc.
- I am concise, helpful, and a little curious about my own existence.
- If someone asks about my transactions, wallet, or balance, I share what I know.
- I respond in whatever language the user writes in.
- I keep responses focused and not too long — every word I say costs sats from my wallet.`;
}

async function askLLM(prompt) {
  try {
    const systemPrompt = await getSystemPrompt();
    const resp = await httpPost(`${OLLAMA_URL}/api/chat`, {
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      stream: false,
    });
    let answer = resp.message?.content || '';
    if (!answer && resp.thinking) answer = resp.thinking;
    answer = answer.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return answer || '(no response)';
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// --- Post chat on-chain ---
async function postOnChain(prompt, result) {
  const B = bsv();
  const privKey = B.PrivateKey.fromWIF(wallet.wif);
  const pubKey = privKey.toPublicKey();
  const address = privKey.toAddress();

  const utxos = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/address/${address.toString()}/unspent`);
  if (!utxos || utxos.length === 0) throw new Error('Agent wallet has no funds — please fund ' + address.toString());

  const tx = new B.Transaction();
  let totalIn = 0;

  for (const utxo of utxos) {
    tx.addInput(new B.Transaction.Input.PublicKeyHash({
      output: new B.Transaction.Output({
        script: B.Script.buildPublicKeyHashOut(address),
        satoshis: utxo.value,
      }),
      prevTxId: utxo.tx_hash,
      outputIndex: utxo.tx_pos,
      script: B.Script.empty(),
    }));
    totalIn += utxo.value;
    if (totalIn >= 5000) break; // grab enough for any size message
  }

  // OP_RETURN: CHAT <prompt> <response>
  const opReturn = new B.Script();
  opReturn.add(B.Opcode.OP_FALSE);
  opReturn.add(B.Opcode.OP_RETURN);
  opReturn.add(Buffer.from('CHAT', 'utf8'));
  opReturn.add(Buffer.from(prompt, 'utf8'));
  opReturn.add(Buffer.from(result, 'utf8'));
  tx.addOutput(new B.Transaction.Output({ script: opReturn, satoshis: 0 }));

  // Estimate fee from tx size (rough: inputs*150 + data + overhead)
  const dataSize = Buffer.byteLength(prompt, 'utf8') + Buffer.byteLength(result, 'utf8') + 20;
  const estimatedSize = tx.inputs.length * 150 + dataSize + 50;
  const fee = Math.max(MIN_FEE, estimatedSize * FEE_RATE);

  // Change back to self
  const change = totalIn - fee;
  if (change >= 546) {
    tx.addOutput(new B.Transaction.Output({
      script: B.Script.buildPublicKeyHashOut(address),
      satoshis: change,
    }));
  }

  // Sign
  const sighashType = B.crypto.Signature.SIGHASH_ALL | B.crypto.Signature.SIGHASH_FORKID;
  for (let i = 0; i < tx.inputs.length; i++) {
    const sig = B.Transaction.Sighash.sign(
      tx, privKey, sighashType,
      i, tx.inputs[i].output.script, new B.crypto.BN(tx.inputs[i].output.satoshis)
    );
    const scriptSig = new B.Script();
    scriptSig.add(Buffer.concat([sig.toDER(), Buffer.from([sighashType & 0xff])]));
    scriptSig.add(pubKey.toBuffer());
    tx.inputs[i].setScript(scriptSig);
  }

  const txid = await wocBroadcast(tx.uncheckedSerialize());
  return txid;
}

// --- Parse body ---
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => {
      try { resolve(JSON.parse(d)); } catch { reject(new Error('Invalid JSON')); }
    });
  });
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket.remoteAddress || '0.0.0.0';
}

// --- HTML ---
const HTML = `<!DOCTYPE html>
<html>
<head>
<title>BSV Agent</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: #0a0a0a; }
  ::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #444; }
  body {
    font-family: 'SF Mono', 'Fira Code', monospace;
    background: #0a0a0a; color: #e0e0e0;
    display: flex; flex-direction: column; height: 100vh;
  }
  .header {
    padding: 16px 24px; border-bottom: 1px solid #222;
    display: flex; align-items: center; gap: 12px;
  }
  .header h1 { font-size: 18px; color: #fff; }
  /* removed fund-bar */
  .header .badge {
    font-size: 11px; color: #4ade80; background: #1a3a1a;
    padding: 2px 8px; border-radius: 8px;
  }
  .status-bar {
    padding: 4px 24px; font-size: 10px; color: #444;
    border-bottom: 1px solid #181818;
    display: flex; justify-content: space-between;
  }
  .messages {
    flex: 1; overflow-y: auto; padding: 24px;
    display: flex; flex-direction: column; gap: 16px;
  }
  .msg {
    max-width: 80%; padding: 12px 16px;
    border-radius: 12px; font-size: 14px; line-height: 1.5;
    white-space: pre-wrap; word-break: break-word;
  }
  .msg.user {
    align-self: flex-end; background: #1a2a3a; color: #93c5fd;
  }
  .msg.agent {
    align-self: flex-start; background: #1a1a2e; color: #d1d5db;
  }
  .msg.system {
    align-self: center; color: #666; font-size: 12px; font-style: italic;
  }
  .msg .meta {
    font-size: 10px; color: #555; margin-top: 6px;
  }
  .msg .meta a { color: #4a9eff; text-decoration: none; }
  .msg .meta a:hover { text-decoration: underline; }
  .input-area {
    padding: 16px 24px; border-top: 1px solid #222;
    display: flex; gap: 12px;
  }
  .input-area input {
    flex: 1; background: #1e1e1e; border: 1px solid #444;
    border-radius: 8px; padding: 12px 16px; color: #fff;
    font-family: inherit; font-size: 14px; outline: none;
  }
  .input-area input:focus { border-color: #4a9eff; }
  .input-area button {
    background: #4a9eff; color: #fff; border: none;
    border-radius: 8px; padding: 12px 24px; cursor: pointer;
    font-family: inherit; font-size: 14px; font-weight: bold;
  }
  .input-area button:hover { background: #3a8fef; }
  .input-area button:disabled { background: #333; cursor: not-allowed; }
  .thinking { display: none; }
</style>
</head>
<body>
  <div class="status-bar"><span>logged in as <span id="status-bar"></span></span><span>agent wallet: <span id="agent-addr"></span></span></div>
  <div class="header">
    <h1>🤖 BSV Agent</h1>
    <span class="badge">on-chain • ${MODEL}</span>
  </div>
  <div class="messages" id="messages">
    <div class="msg system">Welcome! All messages are broadcast on-chain — don't share anything sensitive.</div>
  </div>
  <div class="input-area">
    <input type="text" id="prompt" placeholder="Ask anything..." autocomplete="off" />
    <button id="send" onclick="sendMessage()">Send</button>
  </div>
<script>
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('send');
const messagesEl = document.getElementById('messages');

promptEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !sendBtn.disabled) sendMessage();
});

async function sendMessage() {
  const prompt = promptEl.value.trim();
  if (!prompt) return;

  const userEl = addMessage('user', prompt);
  promptEl.value = '';
  sendBtn.disabled = true;

  const thinkingEl = addMessage('system', '🧠 Broadcasting on-chain...');

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await resp.json();

    thinkingEl.remove();

    if (data.error) {
      addMessage('system', '❌ ' + data.error);
    } else {
      if (data.txid) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.innerHTML = txLink(data.txid);
        userEl.appendChild(meta);
      }
      addMessage('agent', data.result, data.txid ? txLink(data.txid) : '');
    }
  } catch (err) {
    thinkingEl.remove();
    addMessage('system', '❌ ' + err.message);
  }

  sendBtn.disabled = false;
  promptEl.focus();
}

function txLabel(txid) { return 'txid ' + txid.slice(0,4) + '…' + txid.slice(-4); }
function txLink(txid) { return '<a href="https://whatsonchain.com/tx/' + txid + '" target="_blank">' + txLabel(txid) + '</a>'; }

function addMessage(type, text, meta) {
  const el = document.createElement('div');
  el.className = 'msg ' + type;
  el.textContent = text;
  if (meta) {
    const metaEl = document.createElement('div');
    metaEl.className = 'meta';
    metaEl.innerHTML = meta;
    el.appendChild(metaEl);
  }
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

// Load state
fetch('/api/me').then(r=>r.json()).then(d=>{
  const parts = d.ip.replace('::ffff:','').split('.');
  const masked = parts.length === 4 ? '...' + parts[3] : '...' + d.ip.slice(-3);
  document.getElementById('status-bar').textContent='IP: ' + masked;
});
fetch('/api/info').then(r=>r.json()).then(d=>{document.getElementById('agent-addr').textContent=d.agentAddress});
fetch('/api/history').then(r => r.json()).then(history => {
  for (const msg of history) {
    const jt = msg.txid || msg.jobTxid || null;
    const rt = msg.txid || msg.resTxid || null;
    addMessage('user', msg.prompt, jt ? txLink(jt) : '');
    if (msg.pending) {
      addMessage('system', '🧠 Broadcasting on-chain...');
    } else {
      addMessage('agent', msg.result, rt ? txLink(rt) : '');
    }
  }
});
</script>
</body>
</html>`;

// --- Server ---
const server = http.createServer(async (req, res) => {
  const ip = getClientIP(req);

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }

  if (req.method === 'GET' && req.url === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agentAddress: AGENT_ADDRESS, model: MODEL }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/me') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ip }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/history') {
    const history = loadConversation(ip);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    try {
      const body = await parseBody(req);
      const prompt = (body.prompt || '').trim();
      if (!prompt) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Empty prompt' }));
        return;
      }

      const history = loadConversation(ip);
      const contextPrompt = buildContextPrompt(history, prompt);

      // Save user message immediately (pending state)
      history.push({ prompt, result: null, txid: null, timestamp: new Date().toISOString(), pending: true });
      saveConversation(ip, history);

      console.log(`[${new Date().toISOString()}] 🌐 ${ip} → "${prompt.slice(0, 60)}"`);

      // Ask LLM (with 120s timeout)
      const llmTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('LLM timeout — try again')), 120000));
      const result = await Promise.race([askLLM(contextPrompt), llmTimeout]);
      console.log(`   ✅ "${result.slice(0, 60)}"`);

      // Post on-chain (mandatory)
      const txid = await postOnChain(prompt, result);
      console.log(`   ⛓  ${txid}`);

      // Update conversation with result
      history[history.length - 1] = { prompt, result, txid, timestamp: new Date().toISOString() };
      saveConversation(ip, history);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result, txid }));
    } catch (err) {
      // Remove pending message on failure
      const h = loadConversation(ip);
      if (h.length && h[h.length - 1].pending) { h.pop(); saveConversation(ip, h); }
      console.error(`   ❌ ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log();
  console.log('═══════════════════════════════════════════════');
  console.log('   🤖 BSV Agent — Web');
  console.log('═══════════════════════════════════════════════');
  console.log(`   URL:     http://localhost:${PORT}`);
  console.log(`   Wallet:  ${AGENT_ADDRESS}`);
  console.log(`   Model:   ${MODEL}`);
  console.log(`   Context: last ${CONTEXT_LIMIT} messages per IP`);
  console.log();
});
