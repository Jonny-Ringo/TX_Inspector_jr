import { writeFile } from 'node:fs/promises';

const DEFAULT_GRAPHQL_URL = 'https://arweave-search.goldsky.com/graphql';
const DEFAULT_OUTPUT = 'scripts/owner-unindexed.txt';
const DEFAULT_REPORT = 'scripts/owner-unindexed-report.tsv';
const DEFAULT_ALL_OUTPUT = 'scripts/owner-all-txids.txt';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_BATCH_DELAY_MS = 60000;
const DEFAULT_RATE_LIMIT_DELAY_MS = 60000;
const DEFAULT_RATE_LIMIT_RETRIES = 3;

const OWNER_TX_QUERY = `
  query OwnerTxs($owner: String!, $first: Int!, $after: String) {
    transactions(owners: [$owner], first: $first, after: $after, sort: HEIGHT_DESC) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node {
          id
          block { height }
          bundledIn { id }
          data { size }
          tags { name value }
        }
      }
    }
  }
`;

function parseArgs(argv) {
  const opts = {
    owner: '',
    graphqlUrl: DEFAULT_GRAPHQL_URL,
    output: DEFAULT_OUTPUT,
    report: DEFAULT_REPORT,
    allOutput: DEFAULT_ALL_OUTPUT,
    pageSize: DEFAULT_PAGE_SIZE,
    concurrency: DEFAULT_CONCURRENCY,
    batchSize: DEFAULT_BATCH_SIZE,
    batchDelayMs: DEFAULT_BATCH_DELAY_MS,
    rateLimitDelayMs: DEFAULT_RATE_LIMIT_DELAY_MS,
    rateLimitRetries: DEFAULT_RATE_LIMIT_RETRIES,
    limit: Infinity,
    includeFetchErrors: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--owner') opts.owner = argv[++i];
    else if (arg.startsWith('--owner=')) opts.owner = arg.slice('--owner='.length);
    else if (arg === '--graphql-url') opts.graphqlUrl = argv[++i];
    else if (arg.startsWith('--graphql-url=')) opts.graphqlUrl = arg.slice('--graphql-url='.length);
    else if (arg === '--output') opts.output = argv[++i];
    else if (arg.startsWith('--output=')) opts.output = arg.slice('--output='.length);
    else if (arg === '--report') opts.report = argv[++i];
    else if (arg.startsWith('--report=')) opts.report = arg.slice('--report='.length);
    else if (arg === '--all-output') opts.allOutput = argv[++i];
    else if (arg.startsWith('--all-output=')) opts.allOutput = arg.slice('--all-output='.length);
    else if (arg === '--page-size') opts.pageSize = Number(argv[++i]);
    else if (arg.startsWith('--page-size=')) opts.pageSize = Number(arg.slice('--page-size='.length));
    else if (arg === '--concurrency') opts.concurrency = Number(argv[++i]);
    else if (arg.startsWith('--concurrency=')) opts.concurrency = Number(arg.slice('--concurrency='.length));
    else if (arg === '--batch-size') opts.batchSize = Number(argv[++i]);
    else if (arg.startsWith('--batch-size=')) opts.batchSize = Number(arg.slice('--batch-size='.length));
    else if (arg === '--batch-delay-ms') opts.batchDelayMs = Number(argv[++i]);
    else if (arg.startsWith('--batch-delay-ms=')) opts.batchDelayMs = Number(arg.slice('--batch-delay-ms='.length));
    else if (arg === '--rate-limit-delay-ms') opts.rateLimitDelayMs = Number(argv[++i]);
    else if (arg.startsWith('--rate-limit-delay-ms=')) opts.rateLimitDelayMs = Number(arg.slice('--rate-limit-delay-ms='.length));
    else if (arg === '--rate-limit-retries') opts.rateLimitRetries = Number(argv[++i]);
    else if (arg.startsWith('--rate-limit-retries=')) opts.rateLimitRetries = Number(arg.slice('--rate-limit-retries='.length));
    else if (arg === '--limit') opts.limit = Number(argv[++i]);
    else if (arg.startsWith('--limit=')) opts.limit = Number(arg.slice('--limit='.length));
    else if (arg === '--no-fetch-errors') opts.includeFetchErrors = false;
    else if (!opts.owner) opts.owner = arg;
  }

  opts.pageSize = Math.max(1, Math.min(100, Number(opts.pageSize) || DEFAULT_PAGE_SIZE));
  opts.concurrency = Math.max(1, Number(opts.concurrency) || DEFAULT_CONCURRENCY);
  opts.batchSize = Math.max(1, Number(opts.batchSize) || DEFAULT_BATCH_SIZE);
  opts.batchDelayMs = Math.max(0, Number(opts.batchDelayMs) || 0);
  opts.rateLimitDelayMs = Math.max(0, Number(opts.rateLimitDelayMs) || 0);
  opts.rateLimitRetries = Math.max(0, Number(opts.rateLimitRetries) || 0);
  if (!Number.isFinite(opts.limit) || opts.limit <= 0) opts.limit = Infinity;
  return opts;
}

function isLikelyAddress(value) {
  return /^[A-Za-z0-9_-]{43}$/.test(value || '');
}

function csvSafe(value) {
  return String(value ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function graphqlPage(opts, after) {
  const res = await fetch(opts.graphqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      query: OWNER_TX_QUERY,
      variables: { owner: opts.owner, first: opts.pageSize, after },
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`${opts.graphqlUrl} HTTP ${res.status}: ${text.slice(0, 300)}`);

  const json = JSON.parse(text);
  if (json.errors?.length) {
    throw new Error(json.errors.map((err) => err.message).join('; '));
  }
  return json.data?.transactions || { edges: [], pageInfo: { hasNextPage: false } };
}

async function fetchOwnedTransactions(opts) {
  const txs = [];
  const seen = new Set();
  let after = null;
  let page = 0;

  while (txs.length < opts.limit) {
    page += 1;
    const result = await graphqlPage(opts, after);
    const edges = result.edges || [];
    console.log(`page ${page}: ${edges.length} transaction${edges.length === 1 ? '' : 's'}`);

    for (const edge of edges) {
      const node = edge.node;
      if (!node?.id || seen.has(node.id)) continue;
      seen.add(node.id);
      txs.push(node);
      if (txs.length >= opts.limit) break;
    }

    after = edges.at(-1)?.cursor || null;
    if (!result.pageInfo?.hasNextPage || !after || edges.length === 0) break;
  }

  return txs;
}

async function checkArweaveNet(txId, opts) {
  const url = `https://arweave.net/${txId}`;
  for (let attempt = 0; attempt <= opts.rateLimitRetries; attempt += 1) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { Range: 'bytes=0-0', accept: '*/*' },
      });
      await res.body?.cancel?.();

      if (res.status === 429 && attempt < opts.rateLimitRetries) {
        console.log(`429 ${txId}; waiting ${opts.rateLimitDelayMs}ms before retry ${attempt + 1}/${opts.rateLimitRetries}`);
        if (opts.rateLimitDelayMs > 0) await sleep(opts.rateLimitDelayMs);
        continue;
      }

      return {
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        contentLength: res.headers.get('content-length') || '',
        error: '',
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        contentType: '',
        contentLength: '',
        error: err.message || String(err),
      };
    }
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

async function checkAvailabilityInBatches(txs, opts) {
  const checked = [];
  for (let start = 0; start < txs.length; start += opts.batchSize) {
    const batch = txs.slice(start, start + opts.batchSize);
    const batchNumber = Math.floor(start / opts.batchSize) + 1;
    const batchTotal = Math.ceil(txs.length / opts.batchSize);
    console.log(`availability batch ${batchNumber}/${batchTotal}: checking ${batch.length} TX${batch.length === 1 ? '' : 's'}`);

    const batchChecked = await mapLimit(batch, opts.concurrency, async (tx, index) => {
      const availability = await checkArweaveNet(tx.id, opts);
      const label = availability.ok ? 'OK' : `MISS ${availability.status || availability.error}`;
      console.log(`${start + index + 1}/${txs.length} ${label} ${tx.id}`);
      return { tx, availability };
    });
    checked.push(...batchChecked);

    const remaining = txs.length - checked.length;
    if (remaining > 0 && opts.batchDelayMs > 0) {
      console.log(`batch pause: ${opts.batchDelayMs}ms before next ${Math.min(opts.batchSize, remaining)} TX${remaining === 1 ? '' : 's'}`);
      await sleep(opts.batchDelayMs);
    }
  }
  return checked;
}

function txSummary(tx, availability) {
  const contentType = (tx.tags || []).find((tag) => tag.name === 'Content-Type')?.value || '';
  return [
    tx.id,
    tx.block?.height ?? '',
    tx.bundledIn?.id || '',
    tx.data?.size ?? '',
    availability.status,
    availability.contentType,
    availability.contentLength,
    availability.error,
    contentType,
  ].map(csvSafe).join('\t');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!isLikelyAddress(opts.owner)) {
    console.error('Usage: node scripts/find-owner-unindexed.mjs --owner <43-char-arweave-address>');
    process.exitCode = 1;
    return;
  }

  console.log(`Scanning owner ${opts.owner}`);
  console.log(`GraphQL: ${opts.graphqlUrl}`);

  const txs = await fetchOwnedTransactions(opts);
  console.log(`Fetched ${txs.length} unique transaction${txs.length === 1 ? '' : 's'}.`);

  const checked = await checkAvailabilityInBatches(txs, opts);

  const missing = checked.filter(({ availability }) => (
    availability.ok ? false : opts.includeFetchErrors || availability.status !== 0
  ));

  const reportLines = [
    ['txid', 'block_height', 'bundled_in', 'data_size', 'arweave_net_status', 'arweave_net_content_type', 'arweave_net_content_length', 'error', 'gql_content_type'].join('\t'),
    ...checked.map(({ tx, availability }) => txSummary(tx, availability)),
  ];

  await writeFile(opts.allOutput, `${txs.map((tx) => tx.id).join('\n')}${txs.length ? '\n' : ''}`);
  await writeFile(opts.output, `${missing.map(({ tx }) => tx.id).join('\n')}${missing.length ? '\n' : ''}`);
  await writeFile(opts.report, `${reportLines.join('\n')}\n`);

  console.log('');
  console.log(`Wrote all TXIDs: ${opts.allOutput}`);
  console.log(`Wrote missing TXIDs: ${opts.output}`);
  console.log(`Wrote report: ${opts.report}`);
  console.log(`Done: ${missing.length}/${txs.length} not serving on arweave.net.`);
}

await main();
