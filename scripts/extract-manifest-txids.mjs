import { writeFile } from 'node:fs/promises';

function usage() {
  console.error('Usage: node scripts/extract-manifest-txids.mjs <manifest-txid-or-url> [output-file]');
  console.error('Example: node scripts/extract-manifest-txids.mjs lY4chOJD0SVrMfOtjWUNu1NEI4ieqty7dPA1lMyvdMw scripts/steve2.txt');
}

function isTxId(value) {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function manifestUrl(input) {
  if (/^https?:\/\//i.test(input)) return input;
  if (isTxId(input)) return `https://arweave.net/raw/${input}`;
  throw new Error(`Not a txid or URL: ${input}`);
}

function numericPathSort([a], [b]) {
  const an = Number.parseInt(a.replace(/\D+$/g, ''), 10);
  const bn = Number.parseInt(b.replace(/\D+$/g, ''), 10);
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
  return a.localeCompare(b, undefined, { numeric: true });
}

function extractIds(manifest) {
  const ids = [];

  if (manifest?.paths && typeof manifest.paths === 'object') {
    for (const [, entry] of Object.entries(manifest.paths).sort(numericPathSort)) {
      if (isTxId(entry?.id)) ids.push(entry.id);
    }
  }

  if (Array.isArray(manifest?.weightsManifest)) {
    for (const group of manifest.weightsManifest) {
      for (const path of group.paths || []) {
        if (isTxId(path)) ids.push(path);
      }
    }
  }

  return [...new Set(ids)];
}

const input = process.argv[2];
const output = process.argv[3] || 'scripts/manifest-txids.txt';

if (!input) {
  usage();
  process.exitCode = 1;
} else {
  try {
    const url = manifestUrl(input);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);

    const text = await res.text();
    const manifest = JSON.parse(text);
    const ids = extractIds(manifest);
    if (ids.length === 0) throw new Error('No child txids found in manifest');

    await writeFile(output, `${ids.join('\n')}\n`, 'ascii');
    console.log(`Wrote ${ids.length} txids to ${output}`);
  } catch (err) {
    console.error(err.message || String(err));
    process.exitCode = 1;
  }
}
