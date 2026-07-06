import { writeFile } from 'node:fs/promises';

const DEFAULT_ROOT = 'https://hyperbeam.arweave.net/';
const root = new URL(process.argv[2] || DEFAULT_ROOT);
const origin = root.origin;
const maxPages = Number(process.env.MAX_PAGES || 500);

const pageTypes = new Set(['text/html', 'application/xhtml+xml']);
const seen = new Set();
const queued = [root.href];
const checked = [];
const missing = [];

function normalizeUrl(value, base) {
  if (!value) return null;
  if (value.startsWith('mailto:') || value.startsWith('tel:') || value.startsWith('javascript:')) return null;

  let url;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }

  url.hash = '';
  if (url.origin !== origin) return null;
  return url.href;
}

function contentType(headers) {
  return (headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
}

function extractLinks(html, base) {
  const links = new Set();
  const attrPattern = /\b(?:href|src)=["']([^"']+)["']/gi;
  const srcsetPattern = /\bsrcset=["']([^"']+)["']/gi;

  for (const match of html.matchAll(attrPattern)) {
    const normalized = normalizeUrl(match[1], base);
    if (normalized) links.add(normalized);
  }

  for (const match of html.matchAll(srcsetPattern)) {
    for (const candidate of match[1].split(',')) {
      const normalized = normalizeUrl(candidate.trim().split(/\s+/)[0], base);
      if (normalized) links.add(normalized);
    }
  }

  return [...links];
}

async function check(url) {
  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'user-agent': 'tx-inspector-hyperbeam-404-crawler/1.0'
      }
    });
  } catch (error) {
    return { url, status: 'FETCH_ERROR', type: '', error: error.message, body: '' };
  }

  const type = contentType(response.headers);
  const body = pageTypes.has(type) ? await response.text() : '';
  return { url, status: response.status, type, body };
}

while (queued.length > 0 && seen.size < maxPages) {
  const url = queued.shift();
  if (seen.has(url)) continue;
  seen.add(url);

  const result = await check(url);
  checked.push(result);
  console.log(`${result.status} ${url}`);

  if (result.status === 404) missing.push(result);
  if (result.body && result.status >= 200 && result.status < 400) {
    for (const link of extractLinks(result.body, url)) {
      if (!seen.has(link) && !queued.includes(link)) queued.push(link);
    }
  }
}

const missingLines = missing.map(item => `${item.status}\t${item.url}`);
const reportLines = checked.map(item => `${item.status}\t${item.type || 'unknown'}\t${item.url}`);

await writeFile('scripts/hyperbeam-404s.txt', `${missingLines.join('\n')}${missingLines.length ? '\n' : ''}`);
await writeFile('scripts/hyperbeam-crawl-report.txt', `${reportLines.join('\n')}${reportLines.length ? '\n' : ''}`);

console.log('');
console.log(`Checked ${checked.length} URLs.`);
console.log(`Found ${missing.length} 404s.`);
console.log('Wrote scripts/hyperbeam-404s.txt');
console.log('Wrote scripts/hyperbeam-crawl-report.txt');
