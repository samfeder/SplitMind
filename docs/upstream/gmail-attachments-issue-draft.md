# Draft: Gmail attachments on non-streaming transit backends

Kind: issue, then PR from `patches/0003-gmail-attachments-on-non-streaming-transit-backends.patch`. Re-check upstream
`main` before filing: the gap may already be closed.

**Title:** gmail.download_attachment fails on Cloudflare Workers (KV/R2 transit files)

**Body:**

`gmail.download_attachment` requires `transitFiles.createFromStream`, which only the filesystem backend has. On the
Cloudflare Worker, both `KVTransitFileService` and `R2TransitFileService` lack it, so every Gmail attachment download
fails with `400 Gmail attachment downloads require a streaming transit file backend (filesystem).`

Proposal: when the store has no `createFromStream`, read the response with `readBoundedResponseBytes` (bounded at
4/3 of `maxBytes` plus the envelope allowance), `JSON.parse` it, decode `data` with `Buffer.from(…, "base64url")`,
apply the same checks as `AttachmentParser` (valid base64url, `size` matches, `maxBytes` → 413), and call `create()`.

Native decoding is also much cheaper in CPU than the character-level streaming parser: about 4.5 ms against 100 ms
per MiB on Node 22. That matters under Workers CPU limits. Streaming backends keep the current bounded-memory path.

Tested with a new `attachment-buffered.test.ts` (KV store: padded and unpadded data, invalid base64, impossible
length, size mismatch, missing data, truncated JSON, and over-limit before and after parsing). The existing
"refuses a store without streaming support" assertion becomes "reports the provider's error on that store too".
