import { NextResponse } from "next/server";
import { isValidMcpRequest, mcpWwwAuthenticate } from "@/lib/mcp-oauth";
import { handleMcpBody } from "@/lib/mcp-server";

export const runtime = "nodejs";

function unauthorized() {
  return NextResponse.json(
    { error: "Unauthorized" },
    {
      status: 401,
      headers: { "WWW-Authenticate": mcpWwwAuthenticate() },
    },
  );
}

export async function POST(request: Request) {
  if (!(await isValidMcpRequest(request))) {
    return unauthorized();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
      { status: 400 },
    );
  }

  const { status, payload } = await handleMcpBody(body);
  if (payload === null) {
    return new NextResponse(null, { status });
  }
  return NextResponse.json(payload, {
    status,
    headers: {
      "mcp-session-id": "receipts",
    },
  });
}

export async function GET(request: Request) {
  if (!(await isValidMcpRequest(request))) {
    return unauthorized();
  }
  return new NextResponse(null, { status: 405 });
}

export async function DELETE(request: Request) {
  if (!(await isValidMcpRequest(request))) {
    return unauthorized();
  }
  return new NextResponse(null, { status: 200 });
}
