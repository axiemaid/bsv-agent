#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const PORT = parseInt(process.argv.find((a, i) => process.argv[i - 1] === '--port') || '3008');
const WALLET_PATH = path.join(__dirname, 'wallet.json');
const JOBS_PATH = path.join(__dirname, 'jobs.json');

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function loadWallet() {
  if (!fs.existsSync(WALLET_PATH)) return null;
  return JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
}

function loadJobs() {
  if (!fs.existsSync(JOBS_PATH)) return [];
  return JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
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

async function getBalance(address) {
  try {
    const bal = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/address/${address}/balance`);
    return bal ? (bal.confirmed + bal.unconfirmed) : 0;
  } catch { return 0; }
}

function renderHTML(wallet, jobs, balance) {
  const totalEarned = jobs.reduce((s, j) => s + (j.satsKept || 0), 0);
  const totalReceived = jobs.reduce((s, j) => s + (j.satsReceived || 0), 0);
  const successCount = jobs.filter(j => j.resTxid).length;
  const failCount = jobs.filter(j => !j.resTxid).length;

  const jobRows = [...jobs].reverse().map(j => `
    <tr>
      <td class="ts">${new Date(j.timestamp).toLocaleString()}</td>
      <td><a href="https://whatsonchain.com/tx/${j.jobTxid}" target="_blank" class="txid">${j.jobTxid.slice(0, 12)}...</a></td>
      <td class="prompt">${escapeHtml(j.prompt).slice(0, 100)}${j.prompt.length > 100 ? '...' : ''}</td>
      <td class="result">${escapeHtml(j.result).slice(0, 100)}${(j.result || '').length > 100 ? '...' : ''}</td>
      <td class="sats">${(j.satsReceived || 0).toLocaleString()}</td>
      <td>${j.resTxid
        ? `<a href="https://whatsonchain.com/tx/${j.resTxid}" target="_blank" class="txid">${j.resTxid.slice(0, 12)}...</a>`
        : `<span class="error">❌ ${escapeHtml(j.error || 'failed').slice(0, 30)}</span>`}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head>
<title>🦞 BSV Agent</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'SF Mono', 'Fira Code', monospace;
    background: #0a0a0a; color: #e0e0e0; padding: 24px;
  }
  h1 { font-size: 28px; margin-bottom: 4px; color: #fff; }
  .tagline { color: #666; font-size: 14px; margin-bottom: 24px; font-style: italic; }
  .address {
    background: #141414; border: 1px solid #333; border-radius: 8px;
    padding: 16px 24px; margin-bottom: 24px; font-size: 14px;
    display: inline-block;
  }
  .address label { color: #666; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; display: block; margin-bottom: 4px; }
  .address code { color: #4a9eff; font-size: 16px; }
  .stats { display: flex; gap: 24px; margin-bottom: 32px; flex-wrap: wrap; }
  .stat {
    background: #141414; border: 1px solid #222;
    border-radius: 8px; padding: 16px 24px; min-width: 140px;
  }
  .stat-label { color: #666; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
  .stat-value { font-size: 24px; color: #fff; margin-top: 4px; }
  .stat-value.sats { color: #f5a623; }
  .stat-value.trust { color: #4ade80; }
  h2 { font-size: 18px; margin: 0 0 16px; color: #fff; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th {
    text-align: left; padding: 10px 12px; color: #666;
    font-size: 11px; text-transform: uppercase; letter-spacing: 1px;
    border-bottom: 1px solid #222;
  }
  td { padding: 12px; border-bottom: 1px solid #1a1a1a; vertical-align: top; }
  tr:hover { background: #141414; }
  .txid { color: #4a9eff; text-decoration: none; font-family: inherit; }
  .txid:hover { text-decoration: underline; }
  .sats { color: #f5a623; font-weight: bold; }
  .ts { color: #666; font-size: 12px; white-space: nowrap; }
  .prompt { color: #a78bfa; max-width: 250px; }
  .result { color: #d1d5db; max-width: 250px; }
  .error { color: #f87171; font-size: 12px; }
  .how-to {
    background: #141414; border: 1px solid #222; border-radius: 8px;
    padding: 20px 24px; margin-top: 32px; font-size: 13px; color: #888;
  }
  .how-to h3 { color: #fff; font-size: 14px; margin-bottom: 8px; }
  .how-to code { color: #4ade80; background: #1a2a1a; padding: 2px 6px; border-radius: 4px; }
  .footer { margin-top: 24px; color: #333; font-size: 11px; }
</style>
</head>
<body>
  <h1>🦞 BSV Agent</h1>
  <div class="tagline">Works for satoshis. No account. No API key. No permission.</div>

  <div class="address">
    <label>Service Address</label>
    <code>${wallet ? wallet.address : 'Not running'}</code>
  </div>

  <div class="stats">
    <div class="stat">
      <div class="stat-label">Balance (Trust Score)</div>
      <div class="stat-value trust">${balance.toLocaleString()} sats</div>
    </div>
    <div class="stat">
      <div class="stat-label">Jobs Completed</div>
      <div class="stat-value">${successCount}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Total Earned</div>
      <div class="stat-value sats">${totalEarned.toLocaleString()} sats</div>
    </div>
    <div class="stat">
      <div class="stat-label">Total Received</div>
      <div class="stat-value sats">${totalReceived.toLocaleString()} sats</div>
    </div>
    <div class="stat">
      <div class="stat-label">Failed</div>
      <div class="stat-value">${failCount}</div>
    </div>
  </div>

  <h2>📋 Job History</h2>
  <table>
    <thead>
      <tr>
        <th>Time</th><th>Job TX</th><th>Prompt</th><th>Response</th><th>Sats</th><th>Response TX</th>
      </tr>
    </thead>
    <tbody>
      ${jobRows || '<tr><td colspan="6" style="text-align:center;color:#666;padding:40px">No jobs yet. Send a transaction to get started.</td></tr>'}
    </tbody>
  </table>

  <div class="how-to">
    <h3>How to use BSV Agent</h3>
    <p>Send a BSV transaction to <code>${wallet ? wallet.address : '...'}</code> with:</p>
    <p style="margin-top:8px">• An <code>OP_RETURN</code> output containing: <code>JOB</code> followed by your prompt text</p>
    <p>• A payment output to the address above (any amount — more sats = you're supporting BSV Agent)</p>
    <p style="margin-top:8px">BSV Agent will spend your UTXO and broadcast a response transaction with:</p>
    <p>• <code>OP_RETURN</code>: <code>RES</code> <code>&lt;your job txid&gt;</code> <code>&lt;result&gt;</code></p>
  </div>

  <div class="footer">BSV Agent · Trust = Balance · ${new Date().toISOString()}</div>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/jobs') {
    const jobs = loadJobs();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(jobs, null, 2));
    return;
  }

  if (req.url === '/api/status') {
    const wallet = loadWallet();
    const balance = wallet ? await getBalance(wallet.address) : 0;
    const jobs = loadJobs();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      address: wallet?.address,
      balance,
      jobsCompleted: jobs.filter(j => j.resTxid).length,
      totalEarned: jobs.reduce((s, j) => s + (j.satsKept || 0), 0),
    }, null, 2));
    return;
  }

  const wallet = loadWallet();
  const balance = wallet ? await getBalance(wallet.address) : 0;
  const jobs = loadJobs();
  const html = renderHTML(wallet, jobs, balance);
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});

server.listen(PORT, () => {
  console.log(`🦞 BSV Agent Viewer running at http://localhost:${PORT}`);
});
