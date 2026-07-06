// Script to calculate Arweave partition number from transaction ID
// Based on the formula: partition = ChunkOffset / 3,600,000,000,000 (3.6TB)

import https from 'https';
import { readFile, writeFile } from 'node:fs/promises';

// Partition size constant (3.6 TB in bytes)
const PARTITION_SIZE = 3_600_000_000_000;
const PARTITION_SIZE_BIGINT = BigInt(PARTITION_SIZE);

/**
 * Fetch transaction offset from Arweave
 * @param {string} txid - The transaction ID
 * @returns {Promise<object>} Transaction offset info
 */
function fetchTxOffset(txid) {
  return new Promise((resolve, reject) => {
    const url = `https://arweave.net/tx/${txid}/offset`;

    https.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const offsetData = JSON.parse(data);
            // The offset endpoint returns {size: "...", offset: "..."}
            resolve({
              offset: offsetData.offset,
              size: offsetData.size || '',
              nativeOffset: offsetData.offset,
              source: url,
              rootTxId: txid,
              rootDataOffset: '',
              itemOffset: '',
            });
          } catch (err) {
            reject(new Error(`Failed to parse JSON: ${err.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

function fetchHeaderOffset(txid, gateway) {
  return new Promise((resolve, reject) => {
    const url = `${gateway.replace(/\/+$/, '')}/${txid}`;

    https.get(url, (res) => {
      const location = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
        res.resume();
        https.get(location, (redirectRes) => {
          redirectRes.resume();
          const rootOffset = redirectRes.headers['x-ar-io-root-data-offset'];
          const itemOffset = redirectRes.headers['x-ar-io-root-data-item-offset'];
          const rootTxId = redirectRes.headers['x-ar-io-root-transaction-id'];
          if (rootOffset) {
            resolve({ rootDataOffset: rootOffset, itemOffset: itemOffset || '', rootTxId: rootTxId || '', source: location });
          } else {
            reject(new Error(`No root offset header from ${location}`));
          }
        }).on('error', reject);
        return;
      }

      res.resume();
      const rootOffset = res.headers['x-ar-io-root-data-offset'];
      const itemOffset = res.headers['x-ar-io-root-data-item-offset'];
      const rootTxId = res.headers['x-ar-io-root-transaction-id'];
      if (rootOffset) {
        resolve({ rootDataOffset: rootOffset, itemOffset: itemOffset || '', rootTxId: rootTxId || '', source: url });
      } else {
        reject(new Error(`No root offset header from ${url}`));
      }
    }).on('error', reject);
  });
}

async function fetchOffsetInfo(txid) {
  try {
    return await fetchTxOffset(txid);
  } catch (nativeError) {
    for (const gateway of ['https://arweave.ar.io', 'https://turbo.ar.io']) {
      try {
        const headerOffset = await fetchHeaderOffset(txid, gateway);
        if (!headerOffset.rootTxId) return headerOffset;

        const rootOffset = await fetchTxOffset(headerOffset.rootTxId);
        const rootEndOffset = BigInt(rootOffset.offset);
        const rootSize = BigInt(rootOffset.size || 0);
        const rootStartOffset = rootSize > 0n ? rootEndOffset - rootSize : rootEndOffset;
        const itemWeaveOffset = rootStartOffset + BigInt(headerOffset.rootDataOffset || 0);

        return {
          ...headerOffset,
          offset: itemWeaveOffset.toString(),
          rootNativeOffset: rootOffset.offset,
          rootSize: rootOffset.size,
        };
      } catch {
        // Try next gateway.
      }
    }
    throw nativeError;
  }
}

/**
 * Calculate partition from chunk offset
 * @param {string|number} offset - The chunk offset
 * @returns {number} Partition number
 */
function calculatePartition(offset) {
  let offsetNum;
  try {
    offsetNum = BigInt(offset);
  } catch {
    throw new Error(`Invalid offset value: ${offset}`);
  }

  return Number(offsetNum / PARTITION_SIZE_BIGINT);
}

/**
 * Get partition info from transaction ID
 * @param {string} txid - The transaction ID
 * @returns {Promise<object>} Partition information
 */
async function getPartitionFromTxId(txid) {
  try {
    console.log(`Fetching transaction: ${txid}`);
    const offsetInfo = await fetchOffsetInfo(txid);
    const offset = offsetInfo.offset;

    if (!offset) {
      throw new Error('No offset found in transaction data');
    }

    const partition = calculatePartition(offset);

    const result = {
      txid: txid,
      offset: offset,
      partition: partition,
      partitionSize: PARTITION_SIZE,
      rootTxId: offsetInfo.rootTxId,
      rootDataOffset: offsetInfo.rootDataOffset,
      rootNativeOffset: offsetInfo.rootNativeOffset,
      rootSize: offsetInfo.rootSize,
      itemOffset: offsetInfo.itemOffset,
      source: offsetInfo.source,
    };

    console.log('\n--- Partition Info ---');
    console.log(`TxId: ${result.txid}`);
    console.log(`Offset: ${result.offset}`);
    if (result.itemOffset) console.log(`Item Offset: ${result.itemOffset}`);
    if (result.rootDataOffset) console.log(`Root Data Offset: ${result.rootDataOffset}`);
    if (result.rootNativeOffset) console.log(`Root Native Offset: ${result.rootNativeOffset}`);
    if (result.rootTxId) console.log(`Root Tx: ${result.rootTxId}`);
    console.log(`Partition: ${result.partition}`);
    console.log(`Partition Size: ${result.partitionSize.toLocaleString()} bytes (3.6 TB)`);
    console.log('---------------------\n');

    return result;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    throw error;
  }
}

function parseArgs(argv) {
  const opts = {
    file: '',
    output: 'scripts/partition-results.tsv',
    txids: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') opts.file = argv[++i];
    else if (arg.startsWith('--file=')) opts.file = arg.slice('--file='.length);
    else if (arg === '--output') opts.output = argv[++i];
    else if (arg.startsWith('--output=')) opts.output = arg.slice('--output='.length);
    else opts.txids.push(arg);
  }

  return opts;
}

function parseTxRows(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [txid, blockHeight = ''] = line.split(/[\t,\s]+/);
      return { txid, blockHeight };
    })
    .filter(({ txid }) => /^[A-Za-z0-9_-]{43}$/.test(txid));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  let rows = opts.txids.map((txid) => ({ txid, blockHeight: '' }));
  if (opts.file) {
    rows = parseTxRows(await readFile(opts.file, 'utf8'));
  }

  if (rows.length === 0) {
    console.error('Usage: node scripts/partition.mjs <txid> OR node scripts/partition.mjs --file scripts/jason2-successes.txt');
    process.exitCode = 1;
    return;
  }

  console.log('Arweave Partition Calculator\n');

  const output = [];
  let failed = 0;

  for (const row of rows) {
    try {
      const result = await getPartitionFromTxId(row.txid);
      output.push(`${row.txid}\t${row.blockHeight}\t${result.partition}`);
    } catch {
      failed += 1;
      output.push(`${row.txid}\t${row.blockHeight}\tFAILED`);
    }
  }

  if (opts.file || rows.length > 1) {
    await writeFile(opts.output, `${output.join('\n')}\n`);
    console.log(`Wrote ${opts.output}`);
    console.log(`Done: ${rows.length - failed}/${rows.length} succeeded, ${failed} failed.`);
  }
}

await main();

export {
  getPartitionFromTxId,
  calculatePartition,
  fetchTxOffset,
  PARTITION_SIZE
};
