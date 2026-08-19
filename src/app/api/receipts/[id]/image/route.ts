import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { verifyImageAccessToken } from "@/lib/auth/image-token";
import { getReceipt, readReceiptImage } from "@/lib/receipts-store";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Session cookie/Bearer (review page, human use) or a short-lived
  // token scoped to this receipt (manager-mcp fetching on Cowork's
  // behalf — see docs/SIGNED_IMAGE_URL.md) — either is sufficient.
  const url = new URL(request.url);
  const imageToken = url.searchParams.get("token");
  const [session, tokenOk] = await Promise.all([
    getSession(request),
    verifyImageAccessToken(imageToken, id),
  ]);
  if (!session && !tokenOk) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const receipt = getReceipt(id);
  if (!receipt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const bytes = await readReceiptImage(id);
  if (!bytes) {
    return NextResponse.json({ error: "Image missing" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": receipt.mimeType,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
