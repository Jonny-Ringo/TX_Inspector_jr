import { readFile, writeFile } from 'node:fs/promises';

const inputPath = process.argv[2] || 'scripts/hyperbeam-404s.txt';
const outputPath = process.argv[3] || 'scripts/hyperbeam-404-header-ids.txt';

function alternateGateway(url) {
  const parsed = new URL(url);
  parsed.hostname = 'hyperbeam.ar.io';
  return parsed.href;
}

async function readUrls() {
  const text = await readFile(inputPath, 'utf8');
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.split(/\s+/).at(-1))
    .filter(Boolean);
}

async function fetchHeaders(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        accept: '*/*',
        'user-agent': 'tx-inspector-hyperbeam-header-resolver/1.0'
      }
    });

    return {
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      dataId: res.headers.get('x-ar-io-data-id') || '',
      rootTx: res.headers.get('x-ar-io-root-transaction-id') || '',
      owner: res.headers.get('x-arweave-owner-address') || '',
      arnsResolvedId: res.headers.get('x-arns-resolved-id') || '',
      digest: res.headers.get('x-ar-io-digest') || res.headers.get('etag') || ''
    };
  } catch (error) {
    return {
      status: 'FETCH_ERROR',
      contentType: '',
      dataId: '',
      rootTx: '',
      owner: '',
      arnsResolvedId: '',
      digest: '',
      error: error.message
    };
  }
}

const urls = await readUrls();
const lines = [
  ['original_status', 'resolved_status', 'data_id', 'root_tx', 'arns_resolved_id', 'content_type', 'url', 'resolved_url'].join('\t')
];

for (const url of urls) {
  const resolvedUrl = alternateGateway(url);
  const original = await fetchHeaders(url);
  const resolved = await fetchHeaders(resolvedUrl);

  lines.push([
    original.status,
    resolved.status,
    resolved.dataId || original.dataId || 'NONE',
    resolved.rootTx || original.rootTx || 'NONE',
    resolved.arnsResolvedId || original.arnsResolvedId || 'NONE',
    resolved.contentType || original.contentType || 'unknown',
    url,
    resolvedUrl
  ].join('\t'));

  console.log(`${original.status} -> ${resolved.status} ${resolved.dataId || 'NO_ID'} ${url}`);
}

await writeFile(outputPath, `${lines.join('\n')}\n`);
console.log('');
console.log(`Wrote ${outputPath}`);
