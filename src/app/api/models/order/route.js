import { NextResponse } from "next/server";
import { getModelOrder, getAllModelOrders, setModelOrder, resetModelOrder } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/models/order?providerAlias=xxx&kind=yyy
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const kind = searchParams.get("kind") || "llm";

    if (providerAlias) {
      const order = await getModelOrder(providerAlias, kind);
      return NextResponse.json({ providerAlias, kind, order });
    }

    const all = await getAllModelOrders();
    return NextResponse.json({ orders: all });
  } catch (error) {
    console.error("Error fetching model order:", error);
    return NextResponse.json({ error: "Failed to fetch model order" }, { status: 500 });
  }
}

// PUT /api/models/order  body: { providerAlias, kind, order: [...] }
export async function PUT(request) {
  try {
    const body = await request.json();
    const { providerAlias, kind = "llm", order } = body;
    if (!providerAlias || !Array.isArray(order)) {
      return NextResponse.json({ error: "providerAlias and order array required" }, { status: 400 });
    }
    await setModelOrder(providerAlias, kind, order);
    return NextResponse.json({ success: true, providerAlias, kind, order });
  } catch (error) {
    console.error("Error setting model order:", error);
    return NextResponse.json({ error: "Failed to set model order" }, { status: 500 });
  }
}

// DELETE /api/models/order?providerAlias=xxx&kind=yyy
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const kind = searchParams.get("kind") || "llm";
    if (!providerAlias) {
      return NextResponse.json({ error: "providerAlias required" }, { status: 400 });
    }
    await resetModelOrder(providerAlias, kind);
    return NextResponse.json({ success: true, providerAlias, kind });
  } catch (error) {
    console.error("Error resetting model order:", error);
    return NextResponse.json({ error: "Failed to reset model order" }, { status: 500 });
  }
}
