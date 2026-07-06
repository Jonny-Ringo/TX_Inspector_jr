import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataItem } from 'arbundles';
import Arweave from 'arweave';
import TransactionModule from 'arweave/node/lib/transaction.js';

const PRIMARY_UPLOAD_URL = 'https://up.neo.zephyrdev.xyz/tx';
const PRIMARY_UPLOAD_URLS = [
  PRIMARY_UPLOAD_URL,
  'https://up.arweave.net/tx',
];
const RETRY_ATTEMPTS = 2;
const NATIVE_UPLOAD_URL = 'https://arweave.net';
const VERIFY_ATTEMPTS = 6;
const VERIFY_DELAY_MS = 10000;
const GOLDSKY_URLS = [
  'https://arweave-search.goldsky.com/graphql',
  'https://ao-search-gateway.goldsky.com/graphql',
  'https://ao-search-gateway.goldsky.com./graphql',
];
const COPYCAT_ENDPOINTS = [
  'https://alpha.neo.zephyrdev.xyz/~copycat@1.0/arweave/',
  'https://charlie.neo2.zephyrdev.xyz/~copycat@1.0/arweave/',
];
const BUILTIN_SOURCE_BASES = [
  'https://arweave.ar.io',
  'https://turbo.ar.io',
  'https://arweave.net',
  'https://ardrive.net/raw/{txid}',
  'https://turbo-gateway.com',
  'https://turbo-gateway.com/raw/{txid}',
  'https://gateway.irys.xyz',
];

const NativeTransaction = TransactionModule.default || TransactionModule;

const SIGNATURE_TYPE_LENGTHS = {
  1: { sig: 512, owner: 512, label: 'Arweave' },
  2: { sig: 64, owner: 32, label: 'ED25519' },
  3: { sig: 65, owner: 65, label: 'Ethereum' },
  4: { sig: 64, owner: 32, label: 'Solana' },
  5: { sig: 64, owner: 32, label: 'Aptos' },
  6: { sig: 2052, owner: 1025, label: 'MultiAptos' },
  7: { sig: 65, owner: 42, label: 'Typed Ethereum' },
};

const GOLDSKY_TX_QUERY = `
  query GetTxMeta($id: ID!) {
    transaction(id: $id) {
      id
      signature
      anchor
      recipient
      block { height }
      owner { key }
      bundledIn { id }
      tags { name value }
      data { size }
    }
  }
`;

const GOLDSKY_TXS_QUERY = `
  query GetTxMetaFromConnection($id: ID!) {
    transactions(ids: [$id], first: 1) {
      edges {
        node {
          id
          signature
          anchor
          recipient
          block { height }
          owner { key }
          bundledIn { id }
          tags { name value }
          data { size }
        }
      }
    }
  }
`;

function parseArgs(argv) {
  const opts = {
    primaryUploadUrls: [...PRIMARY_UPLOAD_URLS],
    secondaryUploadUrl: '',
    successesFile: 'scripts/successes.txt',
    successOutputFile: '',
    failureOutputFile: '',
    sourceUrls: [],
    txIds: [],
    debug: false,
    rerun: false,
    nativeUploadUrl: NATIVE_UPLOAD_URL,
    verifyAttempts: VERIFY_ATTEMPTS,
    verifyDelayMs: VERIFY_DELAY_MS,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--upload-url' || arg === '--primary-upload-url') opts.primaryUploadUrls = [argv[++i]];
    else if (arg.startsWith('--upload-url=')) opts.primaryUploadUrls = [arg.slice('--upload-url='.length)];
    else if (arg.startsWith('--primary-upload-url=')) opts.primaryUploadUrls = [arg.slice('--primary-upload-url='.length)];
    else if (arg === '--add-primary-upload-url') opts.primaryUploadUrls.push(argv[++i]);
    else if (arg.startsWith('--add-primary-upload-url=')) opts.primaryUploadUrls.push(arg.slice('--add-primary-upload-url='.length));
    else if (arg === '--secondary-upload-url') opts.secondaryUploadUrl = argv[++i];
    else if (arg.startsWith('--secondary-upload-url=')) opts.secondaryUploadUrl = arg.slice('--secondary-upload-url='.length);
    else if (arg === '--no-secondary') opts.secondaryUploadUrl = '';
    else if (arg === '--native-upload-url') opts.nativeUploadUrl = argv[++i];
    else if (arg.startsWith('--native-upload-url=')) opts.nativeUploadUrl = arg.slice('--native-upload-url='.length);
    else if (arg === '--no-native') opts.nativeUploadUrl = '';
    else if (arg === '--verify-attempts') opts.verifyAttempts = Number(argv[++i]);
    else if (arg.startsWith('--verify-attempts=')) opts.verifyAttempts = Number(arg.slice('--verify-attempts='.length));
    else if (arg === '--verify-delay-ms') opts.verifyDelayMs = Number(argv[++i]);
    else if (arg.startsWith('--verify-delay-ms=')) opts.verifyDelayMs = Number(arg.slice('--verify-delay-ms='.length));
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--successes-file') opts.successesFile = argv[++i];
    else if (arg.startsWith('--successes-file=')) opts.successesFile = arg.slice('--successes-file='.length);
    else if (arg === '--success-output-file') opts.successOutputFile = argv[++i];
    else if (arg.startsWith('--success-output-file=')) opts.successOutputFile = arg.slice('--success-output-file='.length);
    else if (arg === '--failure-output-file') opts.failureOutputFile = argv[++i];
    else if (arg.startsWith('--failure-output-file=')) opts.failureOutputFile = arg.slice('--failure-output-file='.length);
    else if (arg === '--no-skip-successes') opts.successesFile = '';
    else if (arg === '--rerun' || arg === '-rerun') opts.rerun = true;
    else if (arg === '--source-url') opts.sourceUrls.push(argv[++i]);
    else if (arg.startsWith('--source-url=')) opts.sourceUrls.push(arg.slice('--source-url='.length));
    else if (arg === '--debug' || arg === '--verbose') opts.debug = true;
    else if (arg === '--file') opts.file = argv[++i];
    else if (arg.startsWith('--file=')) opts.file = arg.slice('--file='.length);
    else opts.txIds.push(arg);
  }
  return opts;
}

function isValidTxId(id) {
  return /^[a-zA-Z0-9_-]{43}$/.test(id);
}

function shortTx(id) {
  return id && id.length > 12 ? `${id.slice(0, 6)}...${id.slice(-4)}` : id;
}

function b64urlToBytes(value) {
  return Buffer.from(value, 'base64url');
}

function b64urlToString(value) {
  return b64urlToBytes(value).toString('utf8');
}

function maybeB64urlText(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) && value.length % 4 !== 1;
}

function bytesToB64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function sha256B64url(bytes) {
  return createHash('sha256').update(bytes).digest('base64url');
}

function debugLog(opts, message) {
  if (opts?.debug) console.log(`  ${message}`);
}

function previewText(text, length = 600) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, length);
}

function arweaveFromUrl(url) {
  const parsed = new URL(url);
  return Arweave.init({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : 443,
    protocol: parsed.protocol.replace(':', ''),
  });
}

function concatU8(...arrays) {
  return Buffer.concat(arrays.map((array) => Buffer.from(array)));
}

function le8(n) {
  const b = Buffer.alloc(8);
  let v = n;
  for (let i = 0; i < 8 && v > 0; i++) {
    b[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return b;
}

function avroZigzag(n) {
  let z = n >= 0 ? n * 2 : n * -2 - 1;
  const bs = [];
  do {
    const b = z & 0x7f;
    z = Math.floor(z / 128);
    bs.push(z > 0 ? b | 0x80 : b);
  } while (z > 0);
  return Buffer.from(bs);
}

function encodeAvroTags(tags) {
  if (!tags || tags.length === 0) return Buffer.alloc(0);
  const parts = [avroZigzag(tags.length)];
  for (const tag of tags) {
    const name = Buffer.from(tag.name, 'utf8');
    const value = Buffer.from(tag.value, 'utf8');
    parts.push(avroZigzag(name.length), name);
    parts.push(avroZigzag(value.length), value);
  }
  parts.push(Buffer.from([0]));
  return concatU8(...parts);
}

function normalizeSignatureType(value) {
  const n = Number(value);
  return SIGNATURE_TYPE_LENGTHS[n] ? n : null;
}

function signatureTypeCandidates(meta) {
  const sigLen = b64urlToBytes(meta.signature || '').length;
  const ownerLen = b64urlToBytes(meta.owner || meta?.owner?.key || '').length;
  const explicit = normalizeSignatureType(meta.signature_type ?? meta.signatureType ?? meta.signatureTypeId);
  const matches = Object.entries(SIGNATURE_TYPE_LENGTHS)
    .filter(([, cfg]) => cfg.sig === sigLen && cfg.owner === ownerLen)
    .map(([type]) => Number(type));

  if (explicit && matches.includes(explicit)) {
    return [explicit, ...matches.filter((type) => type !== explicit)];
  }
  if (matches.length > 0) return matches;
  if (explicit) return [explicit];
  return [1];
}

function anchorByteCandidates(anchor) {
  if (!anchor) return [Buffer.alloc(0)];
  const candidates = [];
  const utf8 = Buffer.from(anchor, 'utf8');
  if (utf8.length === 32) candidates.push(utf8);
  try {
    const decoded = b64urlToBytes(anchor);
    if (decoded.length === 32) candidates.push(decoded);
  } catch {
    // Keep UTF-8 candidate only.
  }
  return candidates.length > 0 ? candidates : [utf8];
}

function buildAns104Item(meta, dataBytes, signatureType) {
  const sigType = signatureType ?? signatureTypeCandidates(meta)[0];
  const signature = b64urlToBytes(meta.signature);
  const owner = b64urlToBytes(meta.owner || meta?.owner?.key || '');
  const hasTarget = !!meta.target;
  const hasAnchor = !!meta.anchor;
  const target = hasTarget ? b64urlToBytes(meta.target) : Buffer.alloc(0);
  const anchor = hasAnchor ? meta.anchorBytes : Buffer.alloc(0);
  const tags = meta.tags || [];
  const tagBytes = encodeAvroTags(tags);

  return concatU8(
    Buffer.from([sigType & 0xff, (sigType >> 8) & 0xff]),
    signature,
    owner,
    Buffer.from([hasTarget ? 1 : 0]),
    target,
    Buffer.from([hasAnchor ? 1 : 0]),
    anchor,
    le8(tags.length),
    le8(tagBytes.length),
    tagBytes,
    dataBytes,
  );
}

function buildAns104Candidates(source, meta, dataBytes) {
  const candidates = [];
  for (const signatureType of signatureTypeCandidates(meta)) {
    const anchors = anchorByteCandidates(meta.anchor);
    for (let i = 0; i < anchors.length; i++) {
      const label = SIGNATURE_TYPE_LENGTHS[signatureType]?.label || `signature type ${signatureType}`;
      candidates.push({
        source,
        signatureType,
        label: anchors.length > 1 ? `${label}, anchor ${i + 1}` : label,
        signature: b64urlToBytes(meta.signature),
        body: buildAns104Item({ ...meta, anchorBytes: anchors[i] }, dataBytes, signatureType),
      });
    }
  }
  return candidates;
}

function candidateFromAns104Bytes(source, label, bytes) {
  if (bytes.length < 2) return null;
  const signatureType = bytes[0] + (bytes[1] << 8);
  const sigLength = SIGNATURE_TYPE_LENGTHS[signatureType]?.sig;
  if (!sigLength || bytes.length < 2 + sigLength) return null;
  return {
    source,
    signatureType,
    label,
    signature: bytes.subarray(2, 2 + sigLength),
    body: bytes,
  };
}

function byteArrayToLong(bytes) {
  let value = 0;
  for (let i = bytes.length - 1; i >= 0; i--) value = value * 256 + bytes[i];
  return value;
}

function ans104HeaderLength(bytes) {
  const candidate = candidateFromAns104Bytes('probe', 'probe', bytes);
  if (!candidate) return null;
  let offset = 2 + SIGNATURE_TYPE_LENGTHS[candidate.signatureType].sig + SIGNATURE_TYPE_LENGTHS[candidate.signatureType].owner;
  const targetPresent = bytes[offset] === 1;
  offset += targetPresent ? 33 : 1;
  const anchorPresent = bytes[offset] === 1;
  offset += anchorPresent ? 33 : 1;
  const tagBytesLength = byteArrayToLong(bytes.subarray(offset + 8, offset + 16));
  return offset + 16 + tagBytesLength;
}

function extractAns104AtOffset(rootBytes, itemOffset, itemSize = '') {
  const start = Number(itemOffset);
  if (!Number.isFinite(start) || start < 0 || start >= rootBytes.length) return null;
  const size = Number(itemSize);
  if (Number.isFinite(size) && size > 0) {
    const end = start + size;
    if (end > rootBytes.length) return null;
    return rootBytes.subarray(start, end);
  }
  const slice = rootBytes.subarray(start);
  const headerLength = ans104HeaderLength(slice);
  if (!headerLength || headerLength > slice.length) return null;
  return slice;
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function tryFetchBytes(url) {
  try {
    return await fetchBytes(url);
  } catch {
    return null;
  }
}

async function tryFetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function tryFetchBytesWithHeaders(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      headers: res.headers,
    };
  } catch {
    return null;
  }
}

function titleCaseTagName(name) {
  return name.split('-').map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join('-');
}

function tagNamesFromSignatureInput(value) {
  const names = [];
  const re = /"x-arweave-tag-([^"]+)"/g;
  let match;
  while ((match = re.exec(value || ''))) {
    if (match[1] !== 'count') names.push(match[1]);
  }
  return names;
}

function headerMetaCandidate(source, headers) {
  const signature = headers.get('x-arweave-signature');
  const owner = headers.get('x-arweave-owner');
  if (!signature || !owner) return null;
  if (headers.get('x-arweave-signature-type') === '0') {
    return {
      source,
      nativeL1: true,
      servedDataId: headers.get('x-ar-io-data-id') || '',
      rootTransactionId: headers.get('x-ar-io-root-transaction-id') || '',
    };
  }

  const tags = [];
  const seen = new Set();
  for (const tagName of tagNamesFromSignatureInput(headers.get('signature-input'))) {
    const value = headers.get(`x-arweave-tag-${tagName}`);
    if (value == null) continue;
    tags.push({ name: titleCaseTagName(tagName), value });
    seen.add(`x-arweave-tag-${tagName}`);
  }
  for (const [name, value] of headers.entries()) {
    if (!name.startsWith('x-arweave-tag-') || name === 'x-arweave-tag-count' || seen.has(name)) continue;
    tags.push({ name: titleCaseTagName(name.slice('x-arweave-tag-'.length)), value });
  }

  return {
    source,
    meta: {
      signature,
      owner,
      signature_type: headers.get('x-arweave-signature-type') || undefined,
      target: headers.get('x-arweave-target') || '',
      anchor: headers.get('x-arweave-anchor') || '',
      tags,
      data: { size: headers.get('content-length') || '0' },
    },
    servedDataId: headers.get('x-ar-io-data-id') || '',
    rootTransactionId: headers.get('x-ar-io-root-transaction-id') || '',
  };
}

async function fetchHeaderReuploadCandidates(txId, opts) {
  const candidates = [];
  for (const base of sourceBaseUrls(opts)) {
    const url = urlForTx(base, txId);
    const result = await tryFetchBytesWithHeaders(url);
    if (opts.debug && result) {
      debugLog(opts, `bytes+headers ${url} -> ${result.bytes.length} bytes, content-type: ${result.headers.get('content-type') || 'unknown'}`);
      debugLog(opts, `bytes+headers ${url} -> x-ar-io-data-id: ${result.headers.get('x-ar-io-data-id') || 'none'}, root: ${result.headers.get('x-ar-io-root-transaction-id') || 'none'}`);
    }
    const headerMeta = result ? headerMetaCandidate(`${base} headers`, result.headers) : null;
    if (!headerMeta) continue;
    if (headerMeta.nativeL1) {
      console.log(`  headers ${base}: signature type 0/native L1; cannot rebuild as ANS-104 from headers`);
      continue;
    }
    if (headerMeta.servedDataId && headerMeta.servedDataId !== txId) {
      console.log(`  headers ${base}: served data id ${shortTx(headerMeta.servedDataId)} differs from requested ${shortTx(txId)}`);
    }
    candidates.push(...buildAns104Candidates(`${headerMeta.source} reconstructed`, headerMeta.meta, result.bytes));
  }
  return candidates;
}

async function fetchRootOffsetCandidates(txId, opts) {
  const candidates = [];
  for (const base of sourceBaseUrls(opts)) {
    const result = await tryFetchBytesWithHeaders(urlForTx(base, txId));
    if (!result) continue;
    const rootId = result.headers.get('x-ar-io-root-transaction-id');
    const itemOffset = result.headers.get('x-ar-io-root-data-item-offset');
    const itemSize = result.headers.get('x-ar-io-root-item-size') || result.headers.get('x-ar-io-data-item-size');
    if (!rootId || !itemOffset) continue;

    for (const rootBase of sourceBaseUrls(opts)) {
      const rootBytes = await tryFetchBytes(`${urlForTx(rootBase, rootId)}?require-codec=ans104@1.0`);
      if (!rootBytes) continue;
      const itemBytes = extractAns104AtOffset(rootBytes, itemOffset, itemSize);
      if (!itemBytes) continue;
      const sizeLabel = itemSize ? ` size ${itemSize}` : '';
      const candidate = candidateFromAns104Bytes('root-offset', `${rootBase} root ${shortTx(rootId)} offset ${itemOffset}${sizeLabel}`, itemBytes);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function sourceBaseUrls(opts = currentOpts) {
  return [
    ...extraSourceBaseUrls(opts),
    ...BUILTIN_SOURCE_BASES,
  ];
}

function urlForTx(baseOrTemplate, txId) {
  const trimmed = baseOrTemplate.replace(/\/+$/, '');
  if (trimmed.includes('{txid}')) return trimmed.replaceAll('{txid}', txId);
  return `${trimmed}/${txId}`;
}

function parentBundleUrls(parentId, opts) {
  const urls = [];
  const seen = new Set();
  const add = (label, url) => {
    if (seen.has(url)) return;
    seen.add(url);
    urls.push({ label, url });
  };

  add('arweave.net raw parent', `https://arweave.net/raw/${parentId}`);
  for (const base of sourceBaseUrls(opts)) {
    const trimmed = base.replace(/\/+$/, '');
    add(`${base} parent`, urlForTx(base, parentId));
    if (!trimmed.includes('{txid}')) add(`${base} raw parent`, `${trimmed}/raw/${parentId}`);
  }
  return urls;
}

async function tryFetchRange(url, start, end, opts) {
  const expected = end - start + 1;
  try {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    const contentLength = Number.parseInt(res.headers.get('content-length') || '0', 10);
    debugLog(opts, `range ${url} ${start}-${end} -> HTTP ${res.status}${contentLength ? ` ${contentLength} bytes` : ''}`);
    if (!res.ok && res.status !== 206) return null;
    if (res.status !== 206 && contentLength > Math.max(expected * 4, 1024 * 1024)) {
      await res.body?.cancel?.();
      debugLog(opts, `range ${url} -> skipped because server ignored Range and advertised ${contentLength} bytes`);
      return null;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === expected) return bytes;
    if (bytes.length > end && res.status !== 206) return bytes.subarray(start, end + 1);
    if (bytes.length > expected) return bytes.subarray(0, expected);
    return bytes;
  } catch (err) {
    debugLog(opts, `range ${url} ${start}-${end} -> error: ${err.message}`);
    return null;
  }
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function fetchBundleItemFromUrl(parentId, childId, url, opts) {
  const countBytes = await tryFetchRange(url, 0, 31, opts);
  if (!countBytes || countBytes.length < 32) return null;
  const count = byteArrayToLong(countBytes.subarray(0, 32));
  if (!Number.isSafeInteger(count) || count <= 0 || count > 1_000_000) {
    debugLog(opts, `bundle ${url} -> invalid item count ${count}`);
    return null;
  }

  const headerLength = 32 + count * 64;
  const header = await tryFetchRange(url, 0, headerLength - 1, opts);
  if (!header || header.length < headerLength) return null;

  const childIdBytes = b64urlToBytes(childId);
  let dataOffset = 0;
  for (let i = 0; i < count; i++) {
    const entryOffset = 32 + i * 64;
    const itemSize = byteArrayToLong(header.subarray(entryOffset, entryOffset + 32));
    const itemId = header.subarray(entryOffset + 32, entryOffset + 64);
    if (sameBytes(itemId, childIdBytes)) {
      const start = headerLength + dataOffset;
      const end = start + itemSize - 1;
      const itemBytes = await tryFetchRange(url, start, end, opts);
      if (!itemBytes || itemBytes.length < itemSize) return null;
      debugLog(opts, `bundle ${url} -> found ${shortTx(childId)} in parent ${shortTx(parentId)} at ${start}, ${itemSize} bytes`);
      return itemBytes.length === itemSize ? itemBytes : itemBytes.subarray(0, itemSize);
    }
    dataOffset += itemSize;
  }

  debugLog(opts, `bundle ${url} -> ${shortTx(childId)} not found in ${count} item headers`);
  return null;
}

async function fetchBundledInCandidates(txId, metas, opts) {
  const parentIds = [...new Set(metas.map(({ meta }) => meta.bundledIn).filter(isValidTxId))];
  const candidates = [];
  for (const parentId of parentIds) {
    for (const { label, url } of parentBundleUrls(parentId, opts)) {
      const itemBytes = await fetchBundleItemFromUrl(parentId, txId, url, opts);
      if (!itemBytes) continue;
      const candidate = candidateFromAns104Bytes('bundledIn', `${label} ${shortTx(parentId)}`, itemBytes);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

async function fetchExactCandidates(txId, opts) {
  const urls = [
    ...sourceBaseUrls(opts).map((base) => [`${base} codec`, `${urlForTx(base, txId)}?require-codec=ans104@1.0`]),
    ['arweave raw codec', `https://arweave.net/raw/${txId}?require-codec=ans104@1.0`],
  ];
  const candidates = [];
  for (const [label, url] of urls) {
    let bytes = null;
    try {
      const res = await fetch(url);
      debugLog(opts, `ans104 ${label} -> HTTP ${res.status}, content-type: ${res.headers.get('content-type') || 'unknown'}`);
      if (!res.ok) continue;
      bytes = Buffer.from(await res.arrayBuffer());
      debugLog(opts, `ans104 ${label} -> ${bytes.length} bytes`);
    } catch (err) {
      debugLog(opts, `ans104 ${label} -> error: ${err.message}`);
      continue;
    }
    const candidate = candidateFromAns104Bytes('exact', label, bytes);
    if (!candidate) debugLog(opts, `ans104 ${label} -> not a recognized ANS-104 item`);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

async function goldskyMetaCandidates(txId) {
  const out = [];
  const opts = currentOpts;
  for (const url of GOLDSKY_URLS) {
    for (const { label, query } of [
      { label: 'transaction', query: GOLDSKY_TX_QUERY },
      { label: 'transactions', query: GOLDSKY_TXS_QUERY },
    ]) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables: { id: txId } }),
        });
        debugLog(opts, `metadata ${url} ${label} -> HTTP ${res.status}`);
        if (!res.ok) continue;
        const json = await res.json();
        const tx = json?.data?.transaction || json?.data?.transactions?.edges?.[0]?.node;
        if (tx) out.push({ source: `${url} ${label}`, tx });
      } catch {
        // Try next GoldSky query/endpoint.
      }
    }
  }
  return out;
}

async function goldskyMeta(txId) {
  const first = (await goldskyMetaCandidates(txId))[0];
  return first?.tx ?? null;
}

async function irysMeta(txId) {
  const res = await fetch(`https://gateway.irys.xyz/tx/${txId}`);
  if (!res.ok) throw new Error(`IRYS metadata HTTP ${res.status}`);
  return res.json();
}

function normalizeOwner(owner) {
  if (!owner) return '';
  if (typeof owner === 'string') return owner;
  return owner.key || owner.address || '';
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [[]];
  const asIs = tags.map((tag) => ({
    name: String(tag.name ?? ''),
    value: String(tag.value ?? ''),
  }));

  const decoded = asIs.map((tag) => {
    try {
      return {
        name: maybeB64urlText(tag.name) ? b64urlToString(tag.name) : tag.name,
        value: maybeB64urlText(tag.value) ? b64urlToString(tag.value) : tag.value,
      };
    } catch {
      return tag;
    }
  });

  const variants = [];
  const seen = new Set();
  for (const tagSet of JSON.stringify(asIs) === JSON.stringify(decoded) ? [asIs] : [asIs, decoded]) {
    for (const variant of contentTypeTagVariants(tagSet)) {
      const key = JSON.stringify(variant);
      if (seen.has(key)) continue;
      seen.add(key);
      variants.push(variant);
    }
  }
  return variants.length > 0 ? variants : [[]];
}

function contentTypeTagVariants(tags) {
  const variants = [tags];
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (String(tag.name).toLowerCase() !== 'content-type') continue;
    if (tag.value !== 'application/x.arweave-manifest json') continue;
    const plusTags = tags.map((candidate, index) => index === i
      ? { ...candidate, value: 'application/x.arweave-manifest+json' }
      : candidate);
    variants.push(plusTags);
  }
  return variants;
}

function metaCandidates(source, rawMeta) {
  const base = rawMeta?.data?.transaction || rawMeta?.transaction || rawMeta;
  if (!base?.signature || !normalizeOwner(base.owner)) return [];

  return normalizeTags(base.tags).map((tags, i) => ({
    source: i === 0 ? source : `${source} decoded-tags`,
    meta: {
      signature: base.signature,
      owner: normalizeOwner(base.owner),
      target: base.target || base.recipient || '',
      anchor: base.anchor || '',
      tags,
      data: base.data || { size: '0' },
      bundledIn: base.bundledIn?.id || '',
    },
  }));
}

async function fetchGatewayMetaCandidates(txId, opts) {
  const out = [];
  const urls = sourceBaseUrls(opts).filter((base) => !base.includes('{txid}')).flatMap((base) => [
    [`${base} /tx`, `${base.replace(/\/+$/, '')}/tx/${txId}`],
    [`${base} /raw tx`, `${base.replace(/\/+$/, '')}/raw/${txId}`],
  ]);

  for (const [source, url] of urls) {
    let json = null;
    try {
      const res = await fetch(url);
      debugLog(opts, `json ${url} -> HTTP ${res.status}, content-type: ${res.headers.get('content-type') || 'unknown'}`);
      if (!res.ok) continue;
      const text = await res.text();
      try {
        json = JSON.parse(text);
        debugLog(opts, `json ${url} -> keys: ${Object.keys(json || {}).join(',') || 'none'}`);
      } catch (err) {
        debugLog(opts, `json ${url} -> parse error: ${err.message}; preview: ${previewText(text, 180)}`);
      }
    } catch (err) {
      debugLog(opts, `json ${url} -> error: ${err.message}`);
    }
    if (!json) continue;
    const metas = metaCandidates(source, json);
    debugLog(opts, `metadata ${source} -> ${metas.length} candidate metadata shapes`);
    out.push(...metas);
  }

  for (const { source, tx } of await goldskyMetaCandidates(txId)) {
    const metas = metaCandidates(source, tx);
    debugLog(opts, `metadata ${source} -> ${metas.length} candidate metadata shapes`);
    out.push(...metas);
  }

  debugLog(opts, `metadata total -> ${out.length}`);

  return out;
}

async function fetchArioData(txId, expectedSize, opts) {
  for (const url of sourceBaseUrls(opts).map((base) => urlForTx(base, txId))) {
    let bytes = null;
    try {
      const res = await fetch(url);
      debugLog(opts, `bytes ${url} -> HTTP ${res.status}, content-type: ${res.headers.get('content-type') || 'unknown'}`);
      if (!res.ok) continue;
      bytes = Buffer.from(await res.arrayBuffer());
      debugLog(opts, `bytes ${url} -> ${bytes.length} bytes`);
    } catch (err) {
      debugLog(opts, `bytes ${url} -> error: ${err.message}`);
      continue;
    }
    if (expectedSize > 0 && bytes.length !== expectedSize) {
      const text = bytes.toString('utf8').trim();
      try {
        const decoded = b64urlToBytes(text);
        if (decoded.length === expectedSize) return decoded;
      } catch {
        // Use original bytes.
      }
    }
    return bytes;
  }
  return null;
}

function extraSourceUrls(txId, opts = currentOpts) {
  return extraSourceBaseUrls(opts).map((sourceUrl) => urlForTx(sourceUrl, txId));
}

function extraSourceBaseUrls(opts = currentOpts) {
  return opts?.sourceUrls || [];
}

let currentOpts = null;

async function buildFallbackCandidates(txId, opts) {
  const candidates = await fetchHeaderReuploadCandidates(txId, opts);
  candidates.push(...await fetchRootOffsetCandidates(txId, opts));

  const metas = await fetchGatewayMetaCandidates(txId, opts);
  candidates.push(...await fetchBundledInCandidates(txId, metas, opts));

  for (const { source, meta } of metas) {
    const expectedSize = Number.parseInt(meta.data?.size || '0', 10);
    const dataBytes = await fetchArioData(txId, expectedSize, opts);
    if (dataBytes) {
      const built = buildAns104Candidates(`${source} reconstructed`, meta, dataBytes);
      debugLog(opts, `reconstruct ${source} -> ${built.length} candidate${built.length === 1 ? '' : 's'}`);
      candidates.push(...built);
    }
  }

  debugLog(opts, `candidate total -> ${candidates.length}`);
  return candidates;
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.label}:${bytesToB64url(candidate.signature)}:${sha256B64url(candidate.body)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function uploadCandidate(uploadUrl, candidate) {
  let res;
  try {
    res = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: candidate.body,
    });
  } catch (err) {
    return { ok: false, status: 0, text: err.message || String(err), contentType: 'fetch-error' };
  }
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, text, contentType: res.headers.get('content-type') || '' };
}

async function withLocalAns104Validity(candidates) {
  const checked = [];
  for (const candidate of candidates) {
    let valid = false;
    let verifyError = '';
    try {
      valid = await DataItem.verify(Buffer.from(candidate.body));
    } catch (err) {
      verifyError = err.message;
    }
    if (!valid && !verifyError) verifyError = 'DataItem.verify returned false';
    checked.push({ ...candidate, localAns104Valid: valid, verifyError });
  }
  return checked;
}

function isRetryableOnSecondary(result) {
  return result.status === 0 || result.status === 413 || result.status === 429 || result.status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchNativeTxHeaders(txId, opts) {
  const url = `https://arweave.net/tx/${txId}`;
  try {
    const res = await fetch(url);
    debugLog(opts, `native ${url} -> HTTP ${res.status}, content-type: ${res.headers.get('content-type') || 'unknown'}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    debugLog(opts, `native ${url} -> error: ${err.message}`);
    return null;
  }
}

async function resolveBlockHeight(txId, opts = currentOpts) {
  const native = await fetchNativeTxHeaders(txId, opts);
  if (Number.isInteger(native?.block?.height)) return native.block.height;

  const meta = await goldskyMeta(txId);
  if (Number.isInteger(meta?.block?.height)) return meta.block.height;

  return '';
}

async function headStatus(url) {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    await res.body?.cancel?.();
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      contentLength: res.headers.get('content-length') || '',
    };
  } catch (err) {
    return { ok: false, status: 0, error: err.message || String(err) };
  }
}

async function quickArweaveNetAvailability(txId) {
  const urls = [
    `https://arweave.net/${txId}`,
  ];

  const statuses = [];
  for (const url of urls) {
    const status = await headStatus(url);
    statuses.push(`${url} -> HTTP ${status.status}${status.contentType ? ` ${status.contentType}` : ''}${status.contentLength ? ` ${status.contentLength} bytes` : ''}`);
    if (status.ok) return { ok: true, url, statuses };
  }
  return { ok: false, statuses };
}

async function verifyArweaveNetAvailability(txId, opts) {
  const urls = [
    `https://arweave.net/${txId}`,
  ];

  let lastStatuses = [];
  const attempts = Math.max(1, Number(opts.verifyAttempts) || 1);
  const delayMs = Math.max(0, Number(opts.verifyDelayMs) || 0);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastStatuses = [];
    for (const url of urls) {
      const status = await headStatus(url);
      lastStatuses.push(`${url} -> HTTP ${status.status}${status.contentType ? ` ${status.contentType}` : ''}${status.contentLength ? ` ${status.contentLength} bytes` : ''}`);
      if (status.ok) {
        return { ok: true, url, attempt, statuses: lastStatuses };
      }
    }

    console.log(`  verify arweave.net availability ${attempt}/${attempts}: ${lastStatuses.join('; ')}`);
    if (attempt < attempts && delayMs > 0) await sleep(delayMs);
  }

  return { ok: false, statuses: lastStatuses };
}

async function verifyAcceptedUpload(txId, opts, routeName, endpoint) {
  const verified = await verifyArweaveNetAvailability(txId, opts);
  if (verified.ok) {
    console.log(`  ${routeName} availability verified: ${verified.url}`);
    return { txId, ok: true, route: routeName, endpoint };
  }

  const statusText = verified.statuses?.join('; ') || 'no verification status';
  console.log(`  ${routeName} accepted upload, but arweave.net is still not serving it: ${statusText}`);
  return {
    txId,
    ok: false,
    route: `${routeName}-pending`,
    endpoint,
    reason: `upload accepted, but arweave.net is not serving it yet (${statusText})`,
  };
}

async function callCopycatEndpoints(txId, blockHeight, opts) {
  const height = Number(blockHeight);
  if (!Number.isInteger(height) || height <= 0) {
    console.log('  copycat skipped: no block height available');
    return false;
  }

  let allOk = true;
  for (let i = 0; i < COPYCAT_ENDPOINTS.length; i++) {
    const endpoint = COPYCAT_ENDPOINTS[i];
    const url = `${endpoint}?from+integer=${height}&to+integer=${height}`;
    try {
      const res = await fetch(url);
      const text = await res.text().catch(() => '');
      console.log(`  copycat ${i + 1}/${COPYCAT_ENDPOINTS.length}: HTTP ${res.status}${text ? ` ${previewText(text, 160)}` : ''}`);
      if (!res.ok) allOk = false;
    } catch (err) {
      console.log(`  copycat ${i + 1}/${COPYCAT_ENDPOINTS.length}: ${err.message || err}`);
      allOk = false;
    }
    if (i < COPYCAT_ENDPOINTS.length - 1) await sleep(250);
  }
  return allOk;
}

function chunkIndexForByte(uploader, byteOffset) {
  return uploader.transaction.chunks.chunks.findIndex((chunk) =>
    byteOffset >= chunk.minByteRange && byteOffset < chunk.maxByteRange
  );
}

async function verifyNativeChunksAndRepair(arweave, uploader, txId, dataBytes, opts) {
  const attempts = Math.max(1, Number(opts.verifyAttempts) || 1);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const downloaded = Buffer.from(await arweave.chunks.downloadChunkedData(txId));
      if (downloaded.length !== dataBytes.length) {
        return { ok: false, reason: `chunk download size mismatch: expected ${dataBytes.length}, got ${downloaded.length}` };
      }
      if (!downloaded.equals(Buffer.from(dataBytes))) {
        return { ok: false, reason: 'chunk download bytes differ from source data' };
      }
      console.log(`  native chunk readback verified: ${downloaded.length} bytes`);
      return { ok: true };
    } catch (err) {
      const message = err.message || String(err);
      const match = message.match(/at (\d+)\/(\d+)/);
      if (!match) return { ok: false, reason: `chunk readback failed: ${message}` };

      const byteOffset = Number(match[1]);
      const chunkIndex = chunkIndexForByte(uploader, byteOffset);
      if (chunkIndex < 0) return { ok: false, reason: `could not map missing byte ${byteOffset} to a chunk index` };

      console.log(`  native chunk readback missing byte ${byteOffset}; retrying chunk ${chunkIndex} (${attempt}/${attempts})`);
      try {
        await uploader.uploadChunk(chunkIndex);
      } catch (uploadErr) {
        return { ok: false, reason: `retry chunk ${chunkIndex} failed: ${uploadErr.message || uploadErr}` };
      }
    }
  }

  return { ok: false, reason: `chunk readback still incomplete after ${attempts} repair attempts` };
}

async function reseedNativeDataChunks(txId, opts) {
  if (!opts.nativeUploadUrl) {
    return { ok: false, route: 'native', reason: 'native reseed disabled' };
  }

  const txHeaders = await fetchNativeTxHeaders(txId, opts);
  if (!txHeaders) return { ok: false, route: 'native', reason: 'native tx headers unavailable' };
  if (Number(txHeaders.format || 1) !== 2 || !txHeaders.data_root) {
    return { ok: false, route: 'native', reason: 'native tx is not a chunked format-2 data tx' };
  }

  const expectedSize = Number.parseInt(txHeaders.data_size || txHeaders.data?.size || '0', 10);
  if (!Number.isFinite(expectedSize) || expectedSize <= 0) {
    return { ok: false, route: 'native', reason: 'native tx has no data_size to reseed' };
  }

  const dataBytes = await fetchArioData(txId, expectedSize, opts);
  if (!dataBytes) return { ok: false, route: 'native', reason: 'native data bytes unavailable' };
  if (dataBytes.length !== expectedSize) {
    return { ok: false, route: 'native', reason: `native data size mismatch: expected ${expectedSize}, got ${dataBytes.length}` };
  }

  const arweave = arweaveFromUrl(opts.nativeUploadUrl);
  let uploader;
  let usedChunkOnlyFallback = false;
  try {
    const tx = new NativeTransaction({ ...txHeaders, data: new Uint8Array(0) });
    uploader = await arweave.transactions.getUploader(tx, dataBytes);
  } catch (err) {
    return { ok: false, route: 'native', reason: `native chunk prep failed: ${err.message}` };
  }

  console.log(`  native tx+chunk reseed ${opts.nativeUploadUrl}: posting tx header + ${uploader.totalChunks} chunks, data_root ${txHeaders.data_root}`);
  while (!uploader.isComplete) {
    try {
      await uploader.uploadChunk();
    } catch (err) {
      const message = err.message || String(err);
      if (!usedChunkOnlyFallback && uploader.chunkIndex === 0 && /Unable to upload transaction:/.test(message)) {
        console.log(`  native tx header post rejected (${message}); falling back to chunk-only reseed because tx metadata already exists`);
        usedChunkOnlyFallback = true;
        const serialized = {
          txPosted: true,
          chunkIndex: 0,
          lastResponseError: '',
          lastRequestTimeEnd: 0,
          lastResponseStatus: 0,
          transaction: { ...txHeaders, data: new Uint8Array(0) },
        };
        try {
          uploader = await arweave.transactions.getUploader(serialized, dataBytes);
          continue;
        } catch (fallbackErr) {
          return { ok: false, route: 'native', endpoint: opts.nativeUploadUrl, status: uploader.lastResponseStatus, reason: `native chunk-only prep failed: ${fallbackErr.message || fallbackErr}` };
        }
      }

      return {
        ok: false,
        route: 'native',
        endpoint: opts.nativeUploadUrl,
        status: uploader.lastResponseStatus,
        reason: `native chunk ${uploader.chunkIndex} failed: ${message}`,
      };
    }
    if (opts.debug || uploader.isComplete || uploader.chunkIndex % 10 === 0) {
      console.log(`  native chunk reseed progress: ${uploader.chunkIndex}/${uploader.totalChunks} (${uploader.pctComplete}%)`);
    }
  }

  const chunkVerified = await verifyNativeChunksAndRepair(arweave, uploader, txId, dataBytes, opts);
  if (!chunkVerified.ok) {
    return {
      txId,
      ok: false,
      route: 'native-pending',
      endpoint: opts.nativeUploadUrl,
      reason: `native chunks uploaded, but readback failed: ${chunkVerified.reason}`,
    };
  }

  const blockHeight = txHeaders.block?.height ?? await resolveBlockHeight(txId, opts);
  const copycatOk = await callCopycatEndpoints(txId, blockHeight, opts);

  const verified = await verifyArweaveNetAvailability(txId, opts);
  if (verified.ok) {
    console.log(`  native availability verified: ${verified.url}`);
    return { txId, ok: true, route: 'native', endpoint: opts.nativeUploadUrl };
  }

  const copycatText = copycatOk ? 'copycat re-index was attempted successfully' : 'copycat re-index was attempted but did not fully succeed';
  return {
    txId,
    ok: false,
    route: 'native-pending',
    endpoint: opts.nativeUploadUrl,
    reason: `native chunks are readable from arweave.net and ${copycatText}, but gateway routes are not serving the tx yet (${verified.statuses?.join('; ') || 'no verification status'})`,
  };
}

async function uploadMatchingCandidates(txId, matching, routeName, uploadUrl) {
  console.log(`  ${routeName} endpoint: ${uploadUrl}`);
  for (const candidate of matching) {
    for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
      const result = await uploadCandidate(uploadUrl, candidate);
      const retryLabel = attempt === 0 ? '' : ` retry ${attempt}/${RETRY_ATTEMPTS}`;
      const preview = result.text ? ` ${previewText(result.text)}` : '';
      const contentType = result.contentType ? ` ${result.contentType}` : '';
      console.log(`  ${routeName} upload${retryLabel} ${candidate.source}/${candidate.label}: HTTP ${result.status}${contentType}${preview}`);
      if (result.ok) return { ok: true, route: routeName, endpoint: uploadUrl };
      if (!isRetryableOnSecondary(result)) {
        return { ok: false, route: routeName, endpoint: uploadUrl, terminal: true, status: result.status, text: result.text };
      }
      if (attempt < RETRY_ATTEMPTS) await sleep(1500 * (attempt + 1));
    }
  }
  return { ok: false, route: routeName, endpoint: uploadUrl, terminal: false };
}

async function reuploadOne(txId, opts) {
  console.log(`\n${txId}`);
  const candidates = dedupeCandidates([
    ...(await fetchExactCandidates(txId, opts)),
    ...(await buildFallbackCandidates(txId, opts)),
  ]);

  if (candidates.length === 0) {
    console.log('  no ANS-104 candidates found');
    if (opts.dryRun) return { txId, ok: false, route: 'dry-run', reason: 'no ANS-104 candidates found' };
    console.log('  trying native tx/chunk recovery because no signed ANS-104 item was available');
    const native = await reseedNativeDataChunks(txId, opts);
    if (native.ok) return native;
    console.log(`  native recovery skipped/failed: ${native.reason || 'unknown reason'}`);
    return { txId, ok: false, route: native.route || 'native', endpoint: native.endpoint, status: native.status, reason: native.reason || 'no ANS-104 candidates found' };
  }

  const checked = candidates.map((candidate) => ({
    ...candidate,
    id: sha256B64url(candidate.signature),
  }));
  const matching = await withLocalAns104Validity(checked.filter((candidate) => candidate.id === txId));

  console.log(`  candidates: ${checked.length}; matching id: ${matching.length}`);
  for (const candidate of checked) {
    console.log(`  - ${candidate.source}: ${candidate.label}; id=${shortTx(candidate.id)}; bytes=${candidate.body.length}`);
  }

  if (matching.length === 0) return { txId, ok: false, reason: 'no matching candidate id' };
  const validMatching = matching.filter((candidate) => candidate.localAns104Valid);
  for (const candidate of matching.filter((candidate) => !candidate.localAns104Valid)) {
    console.log(`  skip invalid ANS-104 ${candidate.source}/${candidate.label}${candidate.verifyError ? `: ${candidate.verifyError}` : ''}`);
  }
  if (validMatching.length === 0) {
    console.log('  no matching candidates passed local ANS-104 signature verification');
    if (opts.dryRun) {
      return { txId, ok: false, route: 'dry-run', reason: 'no valid ANS-104 candidates' };
    }
    const native = await reseedNativeDataChunks(txId, opts);
    if (native.ok) return native;
    console.log(`  native chunk reseed skipped/failed: ${native.reason || 'unknown reason'}`);
    return { txId, ok: false, route: native.route || 'local-verify', endpoint: native.endpoint, status: native.status, reason: native.reason || 'no valid ANS-104 candidates' };
  }

  if (opts.dryRun) {
    console.log(`  dry run: ${validMatching.length} valid matching ANS-104 candidate${validMatching.length === 1 ? '' : 's'} recovered; upload skipped`);
    return { txId, ok: true, route: 'dry-run' };
  }

  let primary = null;
  let acceptedPending = null;
  for (const uploadUrl of opts.primaryUploadUrls) {
    primary = await uploadMatchingCandidates(txId, validMatching, 'primary', uploadUrl);
    if (primary.ok) {
      const verified = await verifyAcceptedUpload(txId, opts, 'primary', uploadUrl);
      if (verified.ok) return verified;
      acceptedPending ||= verified;
      continue;
    }
    if (primary.terminal) break;
  }

  if ((primary?.terminal || !opts.secondaryUploadUrl) && acceptedPending) return acceptedPending;

  if (primary?.terminal || !opts.secondaryUploadUrl) {
    return {
      txId,
      ok: false,
      route: 'primary',
      endpoint: primary?.endpoint,
      status: primary?.status,
      reason: primary?.text?.slice(0, 120) || (primary?.status ? `HTTP ${primary.status}` : 'primary upload failed'),
    };
  }

  console.log(`  ${acceptedPending ? 'primary accepted it but arweave.net did not serve it' : 'primary did not accept this item'}; trying secondary endpoint ${opts.secondaryUploadUrl}`);
  const secondary = await uploadMatchingCandidates(txId, validMatching, 'secondary', opts.secondaryUploadUrl);
  if (secondary.ok) {
    const verified = await verifyAcceptedUpload(txId, opts, 'secondary', opts.secondaryUploadUrl);
    if (verified.ok) return verified;
    acceptedPending ||= verified;
  }

  return acceptedPending || { txId, ok: false, route: 'secondary', endpoint: opts.secondaryUploadUrl };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  currentOpts = opts;
  if (opts.file) {
    const text = await readTxIdFile(opts.file);
    opts.txIds.push(...text.split(/\s+/).filter(Boolean));
  }

  const requestedTxIds = [...new Set(opts.txIds)].filter(isValidTxId);
  if (requestedTxIds.length === 0) {
    console.error('Usage: npm run reupload -- <txid...> [--file txids.txt] [--primary-upload-url https://up.neo.zephyrdev.xyz/tx] [--secondary-upload-url https://upload.ardrive.io/v1/tx]');
    process.exitCode = 1;
    return;
  }

  const previousSuccessText = await readOptionalTxIdFile(opts.successesFile);
  const previousSuccesses = new Set(previousSuccessText.split(/\s+/).filter(isValidTxId));
  const skipped = requestedTxIds.filter((txId) => previousSuccesses.has(txId));
  const txIds = requestedTxIds.filter((txId) => !previousSuccesses.has(txId));

  if (skipped.length > 0) {
    console.log(`Skipping ${skipped.length} previously successful TX${skipped.length === 1 ? '' : 's'} from ${opts.successesFile}:`);
    for (const txId of skipped) console.log(`  ${txId}`);
  }

  const successes = [];
  const failures = [];

  for (const txId of txIds) {
    if (!opts.rerun) {
      const alreadyAvailable = await quickArweaveNetAvailability(txId);
      if (alreadyAvailable.ok) {
        console.log(`\n${txId}`);
        console.log(`  already available on arweave.net: ${alreadyAvailable.url}`);
        successes.push({ txId, ok: true, route: 'already-available', url: alreadyAvailable.url });
        continue;
      }
    }

    const result = await reuploadOne(txId, opts);
    if (result.ok) successes.push(result);
    else failures.push(result);
  }

  const doneLabel = opts.dryRun ? 'recovered locally' : 'verified on arweave.net';
  console.log(`\nDone: ${successes.length}/${txIds.length} ${doneLabel} (${skipped.length} skipped).`);

  console.log('\nSuccesses:');
  if (successes.length === 0) console.log('  none');
  for (const result of successes) {
    const secondary = result.route === 'secondary' ? ' [SECONDARY]' : '';
    const native = result.route === 'native' ? ' [NATIVE-CHUNKS]' : '';
    const already = result.route === 'already-available' ? ' [ALREADY-AVAILABLE]' : '';
    console.log(`  ${result.txId}${secondary}${native}${already}`);
  }

  console.log('\nFailures:');
  if (failures.length === 0) console.log('  none');
  for (const result of failures) {
    console.log(`  ${result.txId}${result.status ? ` HTTP ${result.status}` : ''}`);
  }

  if (opts.successOutputFile) {
    const lines = [];
    for (const result of successes) {
      const blockHeight = await resolveBlockHeight(result.txId, opts);
      lines.push(`${result.txId}\t${blockHeight}`);
    }
    await writeOutputFile(opts.successOutputFile, lines);
    console.log(`\nWrote successes to ${opts.successOutputFile}`);
  }

  if (opts.failureOutputFile) {
    const lines = failures.map((result) => {
      const status = result.status ? ` HTTP ${result.status}` : '';
      const reason = result.reason ? ` ${result.reason}` : '';
      return `${result.txId}${status}${reason}`;
    });
    await writeOutputFile(opts.failureOutputFile, lines);
    console.log(`Wrote failures to ${opts.failureOutputFile}`);
  }
}

async function writeOutputFile(file, lines) {
  await writeFile(resolve(process.cwd(), file), `${lines.join('\n')}${lines.length ? '\n' : ''}`);
}

async function readTxIdFile(file) {
  const candidates = [resolve(process.cwd(), file)];
  if (process.env.INIT_CWD) candidates.push(resolve(process.env.INIT_CWD, file));

  let lastError;
  for (const candidate of [...new Set(candidates)]) {
    try {
      return await readFile(candidate, 'utf8');
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError;
}

async function readOptionalTxIdFile(file) {
  if (!file) return '';
  try {
    return await readTxIdFile(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return '';
    throw err;
  }
}

await main();
