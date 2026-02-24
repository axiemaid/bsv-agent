#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { bsv } = require('scrypt-ts');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args[process.argv[i].replace(/^--/, '')] = process.argv[++i];
}

const TO = args.to;
const PROMPT = args.prompt;
const SATS = parseInt(args.sats || '5000');
const WALLET_PATH = args.wallet || path.join(__dirname, '../bsv-wallet.json');

if (!TO || !PROMPT) {
  console.log('Usage: node send-job.cjs --to <agent-address> --prompt <text> [--sats <amount>] [--wallet <path>]');
  process.exit(1);
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
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

async function main() {
  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  const privKey = bsv.PrivateKey.fromWIF(wallet.wif);
  const pubKey = privKey.toPublicKey();
  const address = privKey.toAddress();

  console.log('📤 Sending Job to BSV Agent');
  console.log(`   To:      ${TO}`);
  console.log(`   Prompt:  ${PROMPT}`);
  console.log(`   Payment: ${SATS} sats`);
  console.log(`   From:    ${address.toString()}`);
  console.log();

  // Get UTXOs
  const utxos = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/address/${address.toString()}/unspent`);
  if (!utxos || utxos.length === 0) { console.error('❌ No UTXOs'); process.exit(1); }

  const tx = new bsv.Transaction();
  let totalIn = 0;

  for (const utxo of utxos) {
    tx.addInput(new bsv.Transaction.Input.PublicKeyHash({
      output: new bsv.Transaction.Output({
        script: bsv.Script.buildPublicKeyHashOut(address),
        satoshis: utxo.value,
      }),
      prevTxId: utxo.tx_hash,
      outputIndex: utxo.tx_pos,
      script: bsv.Script.empty(),
    }));
    totalIn += utxo.value;
    if (totalIn >= SATS + 1000) break;
  }

  // Output 0: OP_RETURN with JOB
  const opReturn = new bsv.Script();
  opReturn.add(bsv.Opcode.OP_FALSE);
  opReturn.add(bsv.Opcode.OP_RETURN);
  opReturn.add(Buffer.from('JOB', 'utf8'));
  opReturn.add(Buffer.from(PROMPT, 'utf8'));
  tx.addOutput(new bsv.Transaction.Output({ script: opReturn, satoshis: 0 }));

  // Output 1: Payment to agent
  tx.addOutput(new bsv.Transaction.Output({
    script: bsv.Script.buildPublicKeyHashOut(bsv.Address.fromString(TO)),
    satoshis: SATS,
  }));

  // Output 2: Change
  const fee = 500;
  const change = totalIn - SATS - fee;
  if (change > 0) {
    tx.addOutput(new bsv.Transaction.Output({
      script: bsv.Script.buildPublicKeyHashOut(address),
      satoshis: change,
    }));
  }

  // Sign
  const sighashType = bsv.crypto.Signature.SIGHASH_ALL | bsv.crypto.Signature.SIGHASH_FORKID;
  for (let i = 0; i < tx.inputs.length; i++) {
    const sig = bsv.Transaction.Sighash.sign(
      tx, privKey, sighashType,
      i, tx.inputs[i].output.script, new bsv.crypto.BN(tx.inputs[i].output.satoshis)
    );
    const scriptSig = new bsv.Script();
    scriptSig.add(Buffer.concat([sig.toDER(), Buffer.from([sighashType & 0xff])]));
    scriptSig.add(pubKey.toBuffer());
    tx.inputs[i].setScript(scriptSig);
  }

  console.log(`   TX size: ${tx.uncheckedSerialize().length / 2} bytes`);
  console.log('   Broadcasting...');

  const txid = await wocBroadcast(tx.uncheckedSerialize());

  console.log();
  console.log('═══════════════════════════════════════════════');
  console.log('   📤 Job sent!');
  console.log(`   TXID:    ${txid}`);
  console.log(`   Prompt:  ${PROMPT}`);
  console.log(`   Payment: ${SATS} sats`);
  console.log(`   https://whatsonchain.com/tx/${txid}`);
  console.log('═══════════════════════════════════════════════');
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
