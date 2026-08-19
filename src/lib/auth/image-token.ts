import { SignJWT, jwtVerify } from "jose";

const IMAGE_TOKEN_TTL = "10m";

function getSecretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) {
    throw new Error("Missing required environment variable: SESSION_SECRET");
  }
  return new TextEncoder().encode(secret);
}

/**
 * Scoped to one receipt id, short-lived, unauthenticated once issued — lets
 * an unrelated MCP server (manager-mcp) fetch a receipt image with a plain
 * GET, no session or API key of this app's own. See docs/SIGNED_IMAGE_URL.md.
 */
export async function createImageAccessToken(receiptId: string): Promise<string> {
  return new SignJWT({ purpose: "image-access", receiptId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(IMAGE_TOKEN_TTL)
    .sign(getSecretKey());
}

export async function verifyImageAccessToken(
  token: string | null,
  receiptId: string,
): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), {
      algorithms: ["HS256"],
    });
    return payload.purpose === "image-access" && payload.receiptId === receiptId;
  } catch {
    return false;
  }
}
