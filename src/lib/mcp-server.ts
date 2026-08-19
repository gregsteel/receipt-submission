import { appOrigin } from "@/lib/app-origin";
import { createImageAccessToken } from "@/lib/auth/image-token";
import {
  getReceipt,
  listReceipts,
  markProcessed,
  readReceiptImage,
  saveAnalysis,
} from "@/lib/receipts-store";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "receipts", version: "0.1.0" };

const TOOLS = [
  {
    name: "list_receipts",
    description:
      "List stored receipts (newest first). Use unanalysed=true to find receipts that still need review.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: "ISO-8601 lower bound on createdAt (inclusive)",
        },
        until: {
          type: "string",
          description: "ISO-8601 upper bound on createdAt (inclusive)",
        },
        unanalysed: {
          type: "boolean",
          description: "If true, only receipts with no saved analysis",
        },
        unprocessed: {
          type: "boolean",
          description: "If true, only receipts not yet marked processed",
        },
        limit: {
          type: "integer",
          description: "Max rows (1–200, default 50)",
        },
      },
    },
  },
  {
    name: "get_receipt",
    description:
      "Fetch one receipt’s metadata and JPEG image for analysis.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Receipt id from list_receipts" },
      },
    },
  },
  {
    name: "save_analysis",
    description:
      "Persist analysis for a receipt (vendor, totals, tax, notes, etc.).",
    inputSchema: {
      type: "object",
      required: ["id", "analysis"],
      properties: {
        id: { type: "string" },
        analysis: {
          description: "JSON object with extracted fields",
        },
      },
    },
  },
  {
    name: "mark_processed",
    description:
      "Mark a receipt as processed once it has been recorded downstream (e.g. in your accounting system). Does not delete anything.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Receipt id from list_receipts" },
      },
    },
    annotations: {
      title: "Mark receipt processed",
      destructiveHint: false,
      idempotentHint: true,
    },
  },
];

function rpcResult(id: JsonRpcId | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(
  id: JsonRpcId | undefined,
  code: number,
  message: string,
) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function asLimit(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: ToolContent[]; isError?: boolean }> {
  if (name === "list_receipts") {
    const rows = listReceipts({
      since: typeof args.since === "string" ? args.since : undefined,
      until: typeof args.until === "string" ? args.until : undefined,
      unanalysed: asBool(args.unanalysed),
      unprocessed: asBool(args.unprocessed),
      limit: asLimit(args.limit),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
    };
  }

  if (name === "get_receipt") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) {
      return {
        isError: true,
        content: [{ type: "text", text: "id is required" }],
      };
    }
    const receipt = getReceipt(id);
    if (!receipt) {
      return {
        isError: true,
        content: [{ type: "text", text: `Receipt not found: ${id}` }],
      };
    }
    const bytes = await readReceiptImage(id);
    if (!bytes) {
      return {
        isError: true,
        content: [{ type: "text", text: `Image missing for receipt ${id}` }],
      };
    }
    // Cowork can view the image content block below but can't read its
    // base64 back out as text to hand to another MCP server (e.g.
    // manager-mcp's attach_receipt_to_purchase_invoice), and has no
    // filesystem to stage a file on either. imageUrl is a signed,
    // unauthenticated, 10-minute link any such server can just GET —
    // see docs/SIGNED_IMAGE_URL.md. Additive: the image content block
    // stays for Cowork's own analysis step.
    const imageToken = await createImageAccessToken(id);
    const imageUrl = `${appOrigin()}/api/receipts/${id}/image?token=${imageToken}`;
    const content: ToolContent[] = [
      { type: "text", text: JSON.stringify({ ...receipt, imageUrl }, null, 2) },
      {
        type: "image",
        data: bytes.toString("base64"),
        mimeType: receipt.mimeType,
      },
    ];
    return { content };
  }

  if (name === "save_analysis") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) {
      return {
        isError: true,
        content: [{ type: "text", text: "id is required" }],
      };
    }
    if (args.analysis === undefined) {
      return {
        isError: true,
        content: [{ type: "text", text: "analysis is required" }],
      };
    }
    const updated = saveAnalysis(id, args.analysis);
    if (!updated) {
      return {
        isError: true,
        content: [{ type: "text", text: `Receipt not found: ${id}` }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(updated, null, 2) }],
    };
  }

  if (name === "mark_processed") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) {
      return {
        isError: true,
        content: [{ type: "text", text: "id is required" }],
      };
    }
    const updated = markProcessed(id);
    if (!updated) {
      return {
        isError: true,
        content: [{ type: "text", text: `Receipt not found: ${id}` }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(updated, null, 2) }],
    };
  }

  return {
    isError: true,
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
  };
}

async function handleMessage(message: JsonRpcRequest) {
  const method = message.method ?? "";
  const id = message.id;
  const isNotification = id === undefined;

  if (method === "notifications/initialized" || method.startsWith("notifications/")) {
    return isNotification ? null : rpcResult(id, {});
  }

  if (method === "ping") {
    return rpcResult(id, {});
  }

  if (method === "initialize") {
    const requested =
      typeof message.params?.protocolVersion === "string"
        ? message.params.protocolVersion
        : PROTOCOL_VERSION;
    return rpcResult(id, {
      protocolVersion: requested || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === "tools/list") {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const name =
      typeof message.params?.name === "string" ? message.params.name : "";
    const args =
      message.params?.arguments &&
      typeof message.params.arguments === "object" &&
      !Array.isArray(message.params.arguments)
        ? (message.params.arguments as Record<string, unknown>)
        : {};
    try {
      const result = await callTool(name, args);
      return rpcResult(id, result);
    } catch (err) {
      const text = err instanceof Error ? err.message : "Tool failed";
      return rpcResult(id, {
        isError: true,
        content: [{ type: "text", text }],
      });
    }
  }

  if (isNotification) {
    return null;
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export async function handleMcpBody(body: unknown): Promise<{
  status: number;
  payload: unknown | null;
}> {
  if (Array.isArray(body)) {
    const results = [];
    for (const item of body) {
      const handled = await handleMessage(item as JsonRpcRequest);
      if (handled) results.push(handled);
    }
    if (results.length === 0) {
      return { status: 202, payload: null };
    }
    return { status: 200, payload: results };
  }

  if (!body || typeof body !== "object") {
    return {
      status: 200,
      payload: rpcError(null, -32600, "Invalid request"),
    };
  }

  const handled = await handleMessage(body as JsonRpcRequest);
  if (!handled) {
    return { status: 202, payload: null };
  }
  return { status: 200, payload: handled };
}
