const errorNames = new Set([
  "PrismaClientKnownRequestError",
  "PrismaClientUnknownRequestError",
  "PrismaClientInitializationError",
  "PrismaClientValidationError",
  "PrismaClientRustPanicError",
  "DriverAdapterError",
  "DatabaseError",
  "ConnectionError"
]);

const sqlStates = new Set([
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
  "22001", "22P02", "23502", "23503", "23505", "23514",
  "40001", "40P01", "42501", "42601", "42703", "42704", "42883", "42P01",
  "53300", "53400", "55P03", "57014", "57P01", "57P02", "57P03"
]);

const connectionCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "ENOTFOUND", "EAI_AGAIN", "EACCES", "EPIPE"
]);

// Read data properties only: an unexpected accessor must not run during logging.
function stringProperty(error: unknown, key: string): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    let current: object | null = error;
    for (let depth = 0; current && depth < 4; depth++, current = Object.getPrototypeOf(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
    }
  } catch {
    // Proxies or inaccessible properties cannot prevent the generic response.
  }
  return undefined;
}

/** Only fixed categories and tightly constrained codes may reach server logs. */
export function errorDiagnostic(error: unknown): { name: string; code?: string } {
  const suppliedName = stringProperty(error, "name");
  const suppliedCode = stringProperty(error, "code") ?? stringProperty(error, "errorCode");
  const code = suppliedCode?.length === 5 && (/^P\d{4}$/.test(suppliedCode) || sqlStates.has(suppliedCode)) ? suppliedCode : undefined;
  const name = suppliedName && errorNames.has(suppliedName)
    ? suppliedName
    : suppliedCode && connectionCodes.has(suppliedCode)
      ? "ConnectionError"
      : code && sqlStates.has(code) ? "DatabaseError" : "UnexpectedError";
  return { name, ...(code ? { code } : {}) };
}
