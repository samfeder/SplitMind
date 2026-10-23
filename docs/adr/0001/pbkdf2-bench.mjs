// Time PBKDF2-SHA256 at 100,000 iterations, the same parameters as upstream's WorkerAesGcmSecretCodec.create.
const enc = new TextEncoder();
const passphrase = "dummy-not-a-real-key-" + Math.random();
async function once() {
  const t0 = process.cpuUsage();
  const w0 = performance.now();
  const material = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  await crypto.subtle.deriveKey({ name: "PBKDF2", salt: enc.encode("oomol-connect-worker-secret-store-v1"), iterations: 100_000, hash: "SHA-256" },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const c = process.cpuUsage(t0);
  return { wallMs: +(performance.now() - w0).toFixed(1), cpuMs: +((c.user + c.system) / 1000).toFixed(1) };
}
const runs = [];
for (let i = 0; i < 7; i++) runs.push(await once());
console.log(JSON.stringify(runs));
const walls = runs.map(r => r.wallMs).sort((a, b) => a - b);
console.log("median wall ms:", walls[3], "min:", walls[0], "max:", walls[6]);
