import { readFile } from 'node:fs/promises';

const INPUT_FILE = 'scripts/native-chunks-address-heights.txt';
const ENDPOINTS = [
  'https://alpha.neo.zephyrdev.xyz/~copycat@1.0/arweave/',
  'https://charlie.neo2.zephyrdev.xyz/~copycat@1.0/arweave/',
];
const GRAPHQL_ENDPOINTS = [
  'https://arweave-search.goldsky.com/graphql',
  'https://ao-search-gateway.goldsky.com/graphql',
  'https://ao-search-gateway.goldsky.com./graphql',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRows(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [txId, blockHeight] = line.split(/\s+/);
      if (!/^[A-Za-z0-9_-]{43}$/.test(txId) || (blockHeight && !/^\d+$/.test(blockHeight))) {
        throw new Error(`Invalid row: ${line}`);
      }
      return { txId, blockHeight: blockHeight || null };
    });
}

function parseArgs(argv) {
  const opts = { file: INPUT_FILE, txIds: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') opts.file = argv[++i];
    else if (arg.startsWith('--file=')) opts.file = arg.slice('--file='.length);
    else opts.txIds.push(arg);
  }
  return opts;
}

async function resolveBlockHeight(txId) {
  const arweaveRes = await fetch(`https://arweave.net/tx/${txId}`, {
    headers: { accept: 'application/json' },
  });
  if (arweaveRes.ok) {
    const tx = await arweaveRes.json();
    const height = tx?.block?.height;
    if (Number.isInteger(height)) return String(height);
  }

  const query = `
    query($id: ID!) {
      transaction(id: $id) { block { height } }
      transactions(ids: [$id], first: 1) { edges { node { block { height } } } }
    }
  `;

  const errors = [`arweave.net/tx HTTP ${arweaveRes.status}`];
  for (const endpoint of GRAPHQL_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables: { id: txId } }),
      });
      if (!res.ok) {
        errors.push(`${endpoint} HTTP ${res.status}`);
        continue;
      }

      const json = await res.json();
      const height =
        json?.data?.transaction?.block?.height ??
        json?.data?.transactions?.edges?.[0]?.node?.block?.height;
      if (Number.isInteger(height)) return String(height);
      errors.push(`${endpoint} missing block.height`);
    } catch (err) {
      errors.push(`${endpoint} ${err.message || err}`);
    }
  }

  throw new Error(errors.join('; '));
}

async function callEndpoint(endpoint, txId, blockHeight) {
  const url = `${endpoint}?from+integer=${blockHeight}&to+integer=${blockHeight}`;
  const started = Date.now();
  try {
    const res = await fetch(url);
    const body = await res.text().catch(() => '');
    const elapsed = Date.now() - started;
    console.log(`  ${res.status} ${endpoint} ${elapsed}ms${body ? ` ${body.slice(0, 160).replace(/\s+/g, ' ')}` : ''}`);
    return res.ok;
  } catch (err) {
    console.log(`  ERR ${endpoint} ${err.message || err}`);
    return false;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = opts.txIds.length > 0
    ? opts.txIds.map((txId) => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(txId)) throw new Error(`Invalid txid: ${txId}`);
      return { txId, blockHeight: null };
    })
    : parseRows(await readFile(opts.file, 'utf8'));
  let ok = 0;
  let failed = 0;

  for (const row of rows) {
    const { txId } = row;
    let { blockHeight } = row;

    if (!blockHeight) {
      try {
        blockHeight = await resolveBlockHeight(txId);
        console.log(`\n${txId} resolved block ${blockHeight}`);
      } catch (err) {
        console.log(`\n${txId}`);
        console.log(`  failed to resolve block height: ${err.message || err}`);
        failed += ENDPOINTS.length;
        continue;
      }
    } else {
      console.log(`\n${txId} block ${blockHeight}`);
    }

    for (const endpoint of ENDPOINTS) {
      const success = await callEndpoint(endpoint, txId, blockHeight);
      if (success) ok += 1;
      else failed += 1;
      await sleep(250);
    }
  }

  console.log(`\nDone: ${ok} endpoint calls succeeded, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

await main();
