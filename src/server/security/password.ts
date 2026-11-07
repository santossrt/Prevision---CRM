import "server-only";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const passwordSchema = z.string()
  .min(12, "A senha deve possuir pelo menos 12 caracteres.")
  .max(128, "A senha deve possuir no máximo 128 caracteres.");

const PARAMETERS = { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 } as const;
const KEY_BYTES = 64;
const SALT_BYTES = 16;
const PREFIX = "scrypt$v1$32768$8$3";
const HASH_PATTERN = /^scrypt\$v1\$32768\$8\$3\$([0-9a-f]{32})\$([0-9a-f]{128})$/;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, PARAMETERS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Versioned, bounded format: a stored hash cannot request arbitrary work. */
export async function hashPassword(password: string): Promise<string> {
  const validated = passwordSchema.parse(password);
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(validated, salt);
  return `${PREFIX}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (typeof hash !== "string" || hash.length > 256 || !passwordSchema.safeParse(password).success) return false;
  const match = HASH_PATTERN.exec(hash);
  if (!match) return false;
  try {
    const expected = Buffer.from(match[2], "hex");
    const actual = await derive(password, Buffer.from(match[1], "hex"));
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
