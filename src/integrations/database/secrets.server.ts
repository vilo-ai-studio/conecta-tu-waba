import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

function encryptionKey(): Buffer {
  const encoded = process.env.DATA_ENCRYPTION_KEY;
  if (!encoded) throw new Error("Falta DATA_ENCRYPTION_KEY");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32)
    throw new Error("DATA_ENCRYPTION_KEY debe contener exactamente 32 bytes en base64");
  return key;
}

export function validateEncryptionKey(): void {
  encryptionKey();
}

export function encryptSecret(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0 || value.startsWith(PREFIX)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptSecret(value: unknown): unknown {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return value;
  const [prefix, version, ivEncoded, tagEncoded, ciphertextEncoded] = value.split(":");
  if (`${prefix}:${version}:` !== PREFIX || !ivEncoded || !tagEncoded || !ciphertextEncoded) {
    throw new Error("Formato de secreto cifrado inválido");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivEncoded, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
