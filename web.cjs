#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// --- Config ---
const PORT = parseInt(process.env.WEB_PORT || '3009');
const AGENT_ADDRESS = (() => {
  const w = path.join(__dirname, 'wallet.json');
  if (fs.existsSync(w)) return JSON.parse(fs.readFileSync(w, 'utf8')).address;
  return null;
})();
const SENDER_WALLET = process.env.SENDER_WALLET || path.join(__dirname, '../bsv-wallet.json');
const CONVERSATIONS_DIR = path.join(__dirname, 'conversations');
const JOBS_PATH = path.join(__dirname, 'jobs.json');
const POLL_TIMEOUT = 120000; // 2 min max wait for response
const CONTEXT_LIMIT = 5; // last N messages as context
const SATS_PER_JOB = parseInt(process.env.SATS_PER_JOB || '3000');

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
        try { resolve(JSON.parse(d)); }
        catch { resolve(null); }
      });
    }).on('error', reject);
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
  // Hash IP for filesystem safety
  const hash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
  return path.join(CONVERSATIONS_DIR, hash);
}

function loadConversation(ip) {
  const dir = ipToDir(ip);
  const file = path.join(dir, 'history.json');
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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

// --- Send JOB tx ---
async function sendJobTx(prompt) {
  const B = bsv();
  const wallet = JSON.parse(fs.readFileSync(SENDER_WALLET, 'utf8'));
  const privKey = B.PrivateKey.fromWIF(wallet.wif);
  const pubKey = privKey.toPublicKey();
  const address = privKey.toAddress();

  const utxos = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/address/${address.toString()}/unspent`);
  if (!utxos || utxos.length === 0) throw new Error('No UTXOs to fund job');

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
    if (totalIn >= SATS_PER_JOB + 1000) break;
  }

  // OP_RETURN: JOB <prompt>
  const opReturn = new B.Script();
  opReturn.add(B.Opcode.OP_FALSE);
  opReturn.add(B.Opcode.OP_RETURN);
  opReturn.add(Buffer.from('JOB', 'utf8'));
  opReturn.add(Buffer.from(prompt, 'utf8'));
  tx.addOutput(new B.Transaction.Output({ script: opReturn, satoshis: 0 }));

  // Payment to agent
  tx.addOutput(new B.Transaction.Output({
    script: B.Script.buildPublicKeyHashOut(B.Address.fromString(AGENT_ADDRESS)),
    satoshis: SATS_PER_JOB,
  }));

  // Change
  const fee = 500;
  const change = totalIn - SATS_PER_JOB - fee;
  if (change > 0) {
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

// --- Poll for RES tx ---
async function waitForResponse(jobTxid) {
  const start = Date.now();
  const B = bsv();

  while (Date.now() - start < POLL_TIMEOUT) {
    await new Promise(r => setTimeout(r, 5000));

    // Check jobs.json for completed job
    if (fs.existsSync(JOBS_PATH)) {
      const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
      const job = jobs.find(j => j.jobTxid === jobTxid && j.resTxid);
      if (job) return job.result;
    }

    // Also check chain directly
    const history = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/address/${AGENT_ADDRESS}/history`);
    if (!history) continue;

    for (const entry of history) {
      try {
        const tx = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/tx/${entry.tx_hash}`);
        if (!tx || !tx.vout) continue;
        for (const vout of tx.vout) {
          if (!vout.scriptPubKey || vout.scriptPubKey.type !== 'nulldata') continue;
          const script = B.Script.fromHex(vout.scriptPubKey.hex);
          const pushes = [];
          for (const chunk of script.chunks) {
            if (chunk.buf) pushes.push(chunk.buf);
          }
          if (pushes.length >= 3 && pushes[0].toString('utf8') === 'RES') {
            const refTxid = Buffer.from(pushes[1]).reverse().toString('hex');
            if (refTxid === jobTxid) {
              return pushes[2].toString('utf8');
            }
          }
        }
      } catch {}
    }
  }

  return null;
}

// --- Parse body ---
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => {
      try { resolve(JSON.parse(d)); }
      catch { reject(new Error('Invalid JSON')); }
    });
  });
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket.remoteAddress || '0.0.0.0';
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  .header .badge {
    font-size: 11px; color: #4ade80; background: #1a3a1a;
    padding: 2px 8px; border-radius: 8px;
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
    flex: 1; background: #141414; border: 1px solid #333;
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
  .thinking.show { display: block; }
</style>
</head>
<body>
  <div class="header">
    <h1>🤖 BSV Agent</h1>
    <span class="badge">on-chain • qwen2.5:14b</span>
  </div>
  <div class="messages" id="messages">
    <div class="msg system">Every message is an on-chain BSV transaction. Type anything.</div>
  </div>
  <div class="input-area">
    <input type="text" id="prompt" placeholder="Ask anything..." autocomplete="off" />
    <button id="send" onclick="sendMessage()">Send</button>
  </div>

<script>
const messagesEl = document.getElementById('messages');
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('send');

promptEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !sendBtn.disabled) sendMessage();
});

async function sendMessage() {
  const prompt = promptEl.value.trim();
  if (!prompt) return;

  // Show user message
  addMessage('user', prompt);
  promptEl.value = '';
  sendBtn.disabled = true;

  // Show thinking
  const thinkingEl = addMessage('system', '🧠 Sending to chain & waiting for response...');

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
      const meta = data.jobTxid
        ? '<a href="https://whatsonchain.com/tx/' + data.jobTxid + '" target="_blank">job tx</a>'
          + (data.resTxid ? ' → <a href="https://whatsonchain.com/tx/' + data.resTxid + '" target="_blank">response tx</a>' : '')
        : '';
      addMessage('agent', data.result, meta);
    }
  } catch (err) {
    thinkingEl.remove();
    addMessage('system', '❌ ' + err.message);
  }

  sendBtn.disabled = false;
  promptEl.focus();
}

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

// Load history
fetch('/api/history').then(r => r.json()).then(history => {
  for (const msg of history) {
    addMessage('user', msg.prompt);
    addMessage('agent', msg.result);
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

  if (req.method === 'GET' && req.url === '/api/history') {
    const history = loadConversation(ip);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history.slice(-CONTEXT_LIMIT)));
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

      // Load conversation context
      const history = loadConversation(ip);
      const contextPrompt = buildContextPrompt(history, prompt);

      console.log(`[${new Date().toISOString()}] 🌐 ${ip} → "${prompt.slice(0, 60)}..."`);

      // Send JOB tx with context-enriched prompt
      const jobTxid = await sendJobTx(contextPrompt);
      console.log(`   📤 Job TX: ${jobTxid}`);

      // Wait for response
      const result = await waitForResponse(jobTxid);

      if (!result) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Timeout waiting for response' }));
        return;
      }

      // Find resTxid from jobs.json
      let resTxid = null;
      if (fs.existsSync(JOBS_PATH)) {
        const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
        const job = jobs.find(j => j.jobTxid === jobTxid);
        if (job) resTxid = job.resTxid;
      }

      // Save to conversation
      history.push({ prompt, result, jobTxid, resTxid, timestamp: new Date().toISOString() });
      saveConversation(ip, history);

      console.log(`   ✅ Response: "${result.slice(0, 60)}..."`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result, jobTxid, resTxid }));
    } catch (err) {
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
  console.log('   🤖 BSV Agent — Web Frontend');
  console.log('═══════════════════════════════════════════════');
  console.log(`   URL:     http://localhost:${PORT}`);
  console.log(`   Agent:   ${AGENT_ADDRESS}`);
  console.log(`   Funder:  ${SENDER_WALLET}`);
  console.log(`   Cost:    ${SATS_PER_JOB} sats/job`);
  console.log(`   Context: last ${CONTEXT_LIMIT} messages per IP`);
  console.log();
});
