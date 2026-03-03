import crypto from "crypto";

function hashPassword(plainPassword) {
  const N = 16384;
  const r = 8;
  const p = 1;
  const saltHex = crypto.randomBytes(16).toString("hex");
  const keyLen = 64;
  const derived = crypto.scryptSync(plainPassword, Buffer.from(saltHex, "hex"), keyLen, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${N}$${r}$${p}$${saltHex}$${derived.toString("hex")}`;
}

const plain = process.argv[2];
if (!plain) {
  console.error("Usage: node scripts/hash-password.mjs \"YourStrongPassword\"");
  process.exit(1);
}

console.log(hashPassword(plain));
