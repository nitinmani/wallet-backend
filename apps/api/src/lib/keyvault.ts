import crypto from "crypto";
import { config } from "./config";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  return Buffer.from(config.encryptionKey, "hex");
}

export interface EncryptedData {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let ciphertext = cipher.update(plaintext, "utf8", "hex");
  ciphertext += cipher.final("hex");
  const tag = cipher.getAuthTag();

  const data: EncryptedData = {
    ciphertext,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
  };

  return JSON.stringify(data);
}

export function decrypt(encryptedJson: string): string {
  const key = getKey();
  const data: EncryptedData = JSON.parse(encryptedJson);

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(data.iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(data.tag, "hex"));

  let plaintext = decipher.update(data.ciphertext, "hex", "utf8");
  plaintext += decipher.final("utf8");

  return plaintext;
}
