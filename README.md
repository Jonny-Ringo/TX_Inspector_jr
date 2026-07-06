# TX Inspector

Permaweb application to help debug transaction IDs.

## Re-upload from Node

Browser re-upload can be blocked by CORS even when the network request shows a 200. Use the Node CLI for real repair attempts and full response diagnostics:

```bash
npm run reupload -- <txid>
npm run reupload -- --file txids.txt
```

By default, the CLI skips TXIDs already listed in `scripts/successes.txt`. Disable that with:

```bash
npm run reupload -- --no-skip-successes --file txids.txt
```

The CLI strictly uses `up.arweave.net` by default. It tries both primary routes:

- `https://up.arweave.net/tx`
- `https://up.arweave.net/tx/arweave`

Secondary uploads are disabled by default because they may not populate `arweave.net`.

Optional endpoint overrides:

```bash
npm run reupload -- --primary-upload-url https://up.arweave.net/tx --secondary-upload-url https://upload.ardrive.io/v1/tx --file txids.txt
```

Use `--secondary-upload-url` only for diagnostics or explicitly non-counting fallback attempts.

If a TX is live on a specific AR.IO node, add it as a source:

```bash
npm run reupload -- --source-url https://your-node.example.com --file txids.txt
```

You can also use `{txid}` in the source URL:

```bash
npm run reupload -- --source-url https://your-node.example.com/raw/{txid} --file txids.txt
```

Last deployment: https://arweave.net/VRt6gIQ_p-7ov4dKUWMKRcLRX3Aobcgw7M_tXFq0NlI
