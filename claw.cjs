#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

// --- Config ---
const WALLET_PATH = path.join(__dirname, 'wallet.json');
const JOBS_PATH = path.join(__dirname, 'jobs.json');
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '15000'); // ms
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.MODEL || 'qwen3:8b';
const FEE = 300;

// --- Helpers ---
let bsvLib;
function bsv() {
  if (!bsvLib) bsvLib = require('scrypt-ts').bsv;
  return bsvLib;
}

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

function httpPost(url, body) {
  const mod = url.startsWith('https') ? https : http;
  const parsed = new URL(url);
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error(`Bad JSON: ${d.slice(0, 200)}`)); }
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

// --- Wallet ---
function loadOrCreateWallet() {
  if (fs.existsSync(WALLET_PATH)) {
    return JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  }
  const key = new (bsv().PrivateKey)();
  const wallet = {
    wif: key.toWIF(),
    address: key.toAddress().toString(),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, null, 2));
  return wallet;
}

// --- Jobs log ---
function loadJobs() {
  if (!fs.existsSync(JOBS_PATH)) return [];
  return JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
}

function saveJob(job) {
  const jobs = loadJobs();
  jobs.push(job);
  fs.writeFileSync(JOBS_PATH, JSON.stringify(jobs, null, 2));
}

function isJobProcessed(txid) {
  return loadJobs().some(j => j.jobTxid === txid);
}

// --- Parse OP_RETURN for JOB ---
function parseJobFromTx(tx) {
  for (const vout of (tx.vout || [])) {
    if (!vout.scriptPubKey || vout.scriptPubKey.type !== 'nulldata') continue;
    try {
      const script = bsv().Script.fromHex(vout.scriptPubKey.hex);
      const pushes = [];
      for (const chunk of script.chunks) {
        if (chunk.buf) pushes.push(chunk.buf);
      }
      if (pushes.length >= 2 && pushes[0].toString('utf8') === 'JOB') {
        return pushes[1].toString('utf8');
      }
    } catch {}
  }
  return null;
}

// --- Find spendable UTXOs from a tx sent to our address ---
function findOurOutputs(tx, address) {
  const outputs = [];
  for (const vout of (tx.vout || [])) {
    if (vout.scriptPubKey && vout.scriptPubKey.addresses && vout.scriptPubKey.addresses.includes(address)) {
      outputs.push({
        txid: tx.txid,
        vout: vout.n,
        satoshis: Math.round(vout.value * 1e8),
        script: vout.scriptPubKey.hex,
      });
    }
  }
  return outputs;
}

// --- LLM ---
async function askLLM(prompt) {
  try {
    const resp = await httpPost(`${OLLAMA_URL}/api/generate`, {
      model: MODEL,
      prompt,
      stream: false,
    });
    // qwen3 puts the answer in thinking field sometimes
    let answer = resp.response || '';
    if (resp.thinking && !answer) answer = resp.thinking;
    // Strip thinking tags if present
    answer = answer.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return answer || '(no response)';
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// --- Build response TX ---
function buildResponseTx(privKey, utxos, jobTxid, resultText) {
  const B = bsv();
  const pubKey = privKey.toPublicKey();
  const address = privKey.toAddress();

  // Truncate result for OP_RETURN (keep under 100KB to be safe)
  let resultBuf = Buffer.from(resultText, 'utf8');
  let isHashed = false;
  if (resultBuf.length > 50000) {
    // Too large — hash it, store full result in follow-up
    const hash = crypto.createHash('sha256').update(resultBuf).digest('hex');
    resultBuf = Buffer.from(`HASH:${hash}`, 'utf8');
    isHashed = true;
  }

  const opReturn = new B.Script();
  opReturn.add(B.Opcode.OP_FALSE);
  opReturn.add(B.Opcode.OP_RETURN);
  opReturn.add(Buffer.from('RES', 'utf8'));
  opReturn.add(Buffer.from(jobTxid, 'hex').reverse()); // little-endian
  opReturn.add(resultBuf);

  const tx = new B.Transaction();
  let totalIn = 0;

  for (const utxo of utxos) {
    tx.addInput(new B.Transaction.Input.PublicKeyHash({
      output: new B.Transaction.Output({
        script: B.Script.fromHex(utxo.script),
        satoshis: utxo.satoshis,
      }),
      prevTxId: utxo.txid,
      outputIndex: utxo.vout,
      script: B.Script.empty(),
    }));
    totalIn += utxo.satoshis;
  }

  // Output 0: OP_RETURN
  tx.addOutput(new B.Transaction.Output({ script: opReturn, satoshis: 0 }));

  // Output 1: Keep the sats (minus fee) — accumulate
  const keep = totalIn - FEE;
  if (keep > 0) {
    tx.addOutput(new B.Transaction.Output({
      script: B.Script.buildPublicKeyHashOut(address),
      satoshis: keep,
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

  return { tx, isHashed, keep };
}

// --- Main loop ---
async function processJob(wallet, privKey, txid) {
  const address = wallet.address;

  log(`📥 New tx: ${txid.slice(0, 16)}...`);

  // Fetch full tx
  const tx = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}`);
  if (!tx) { log('   Could not fetch tx'); return; }

  // Parse JOB from OP_RETURN
  const prompt = parseJobFromTx(tx);
  if (!prompt) { log('   No JOB found in OP_RETURN — skipping'); return; }

  // Find our UTXOs in this tx
  const utxos = findOurOutputs(tx, address);
  if (utxos.length === 0) { log('   No outputs to our address — skipping'); return; }

  const satsReceived = utxos.reduce((s, u) => s + u.satoshis, 0);
  log(`   📋 JOB: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);
  log(`   💰 Received: ${satsReceived} sats`);

  // Do the work
  log('   🧠 Thinking...');
  const result = await askLLM(prompt);
  log(`   ✅ Result: "${result.slice(0, 80)}${result.length > 80 ? '...' : ''}"`);

  // Build and broadcast response
  const { tx: resTx, isHashed, keep } = buildResponseTx(privKey, utxos, txid, result);

  log(`   📤 Broadcasting response (${resTx.uncheckedSerialize().length / 2} bytes)...`);

  try {
    const resTxid = await wocBroadcast(resTx.uncheckedSerialize());
    log(`   ✅ Response TX: ${resTxid}`);
    log(`   💰 Kept: ${keep} sats`);

    // Save job
    saveJob({
      jobTxid: txid,
      resTxid,
      prompt,
      result: isHashed ? '(hashed — see follow-up tx)' : result,
      satsReceived,
      satsKept: keep,
      isHashed,
      timestamp: new Date().toISOString(),
    });

    if (isHashed) {
      log('   ⚠️  Result was hashed (too large). TODO: follow-up tx with full result.');
    }
  } catch (err) {
    log(`   ❌ Broadcast failed: ${err.message}`);
    // Still save the job attempt
    saveJob({
      jobTxid: txid,
      resTxid: null,
      prompt,
      result,
      satsReceived,
      satsKept: 0,
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
}

let lastSeenTxids = new Set();

async function pollForJobs(wallet, privKey) {
  try {
    const history = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/address/${wallet.address}/history`);
    if (!history || !Array.isArray(history)) return;

    for (const entry of history) {
      const txid = entry.tx_hash;
      if (lastSeenTxids.has(txid)) continue;
      lastSeenTxids.add(txid);

      if (isJobProcessed(txid)) continue;

      // Small delay to let tx propagate
      await new Promise(r => setTimeout(r, 2000));
      await processJob(wallet, privKey, txid);
    }
  } catch (err) {
    log(`⚠️  Poll error: ${err.message}`);
  }
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

async function main() {
  const wallet = loadOrCreateWallet();
  const privKey = bsv().PrivateKey.fromWIF(wallet.wif);

  console.log();
  console.log('═══════════════════════════════════════════════');
  console.log('   🦞 The Claw');
  console.log('   Works for satoshis. No account. No API key.');
  console.log('═══════════════════════════════════════════════');
  console.log(`   Address: ${wallet.address}`);
  console.log(`   Model:   ${MODEL}`);
  console.log(`   Polling:  every ${POLL_INTERVAL / 1000}s`);
  console.log(`   Jobs log: ${JOBS_PATH}`);
  console.log();
  console.log('   Send a tx to the address above with:');
  console.log('   OP_RETURN: JOB <your prompt>');
  console.log('   Include payment in a regular output.');
  console.log();
  console.log('   Watching for jobs...');
  console.log();

  // Pre-populate seen txids from existing history
  try {
    const history = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/address/${wallet.address}/history`);
    if (history && Array.isArray(history)) {
      for (const entry of history) lastSeenTxids.add(entry.tx_hash);
    }
  } catch {}

  // Also mark already-processed jobs
  const existingJobs = loadJobs();
  for (const j of existingJobs) lastSeenTxids.add(j.jobTxid);

  // Poll loop
  setInterval(() => pollForJobs(wallet, privKey), POLL_INTERVAL);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
