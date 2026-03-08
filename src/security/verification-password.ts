import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const HASH_ALGORITHM = "scrypt";
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;
const HASH_PART_COUNT = 7;

export const SETUP_VERIFICATION_PASSWORD_ENV_VAR =
  "CODEX_TELEGRAM_BRIDGE_SETUP_VERIFICATION_PASSWORD";

export function hashVerificationPassword(password: string): string {
  const normalizedPassword = normalizeVerificationPassword(password);
  const salt = randomBytes(SALT_BYTES);
  const derived = deriveKey(normalizedPassword, salt);

  return [
    HASH_ALGORITHM,
    String(SCRYPT_COST),
    String(SCRYPT_BLOCK_SIZE),
    String(SCRYPT_PARALLELIZATION),
    String(KEY_LENGTH),
    salt.toString("hex"),
    derived.toString("hex")
  ].join("$");
}

export function verifyVerificationPassword(
  password: string,
  encodedHash: string
): boolean {
  const parsed = parseVerificationPasswordHash(encodedHash);
  if (!parsed) {
    return false;
  }

  const actual = deriveKey(
    normalizeVerificationPassword(password),
    parsed.salt,
    parsed.options
  );
  return (
    actual.length === parsed.derivedKey.length &&
    timingSafeEqual(actual, parsed.derivedKey)
  );
}

export function isVerificationPasswordHash(value: string): boolean {
  return parseVerificationPasswordHash(value) !== null;
}

export function normalizeVerificationPassword(password: string): string {
  return password.trim();
}

function deriveKey(
  password: string,
  salt: Uint8Array,
  options: {
    readonly cost?: number;
    readonly blockSize?: number;
    readonly parallelization?: number;
    readonly keyLength?: number;
  } = {}
): Buffer {
  return scryptSync(password, salt, options.keyLength ?? KEY_LENGTH, {
    N: options.cost ?? SCRYPT_COST,
    r: options.blockSize ?? SCRYPT_BLOCK_SIZE,
    p: options.parallelization ?? SCRYPT_PARALLELIZATION
  });
}

function parseVerificationPasswordHash(encodedHash: string): {
  readonly salt: Buffer;
  readonly derivedKey: Buffer;
  readonly options: {
    readonly cost: number;
    readonly blockSize: number;
    readonly parallelization: number;
    readonly keyLength: number;
  };
} | null {
  const parts = encodedHash.trim().split("$");
  if (parts.length !== HASH_PART_COUNT) {
    return null;
  }

  const [
    algorithm,
    costText,
    blockSizeText,
    parallelizationText,
    keyLengthText,
    saltHex,
    derivedHex
  ] = parts;
  if (algorithm !== HASH_ALGORITHM) {
    return null;
  }

  const cost = parsePositiveInteger(costText);
  const blockSize = parsePositiveInteger(blockSizeText);
  const parallelization = parsePositiveInteger(parallelizationText);
  const keyLength = parsePositiveInteger(keyLengthText);
  if (!cost || !blockSize || !parallelization || !keyLength) {
    return null;
  }

  if (!isHex(saltHex) || !isHex(derivedHex)) {
    return null;
  }

  const salt = Buffer.from(saltHex, "hex");
  const derivedKey = Buffer.from(derivedHex, "hex");
  if (salt.length === 0 || derivedKey.length !== keyLength) {
    return null;
  }

  return {
    salt,
    derivedKey,
    options: {
      cost,
      blockSize,
      parallelization,
      keyLength
    }
  };
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isHex(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(value)
  );
}
