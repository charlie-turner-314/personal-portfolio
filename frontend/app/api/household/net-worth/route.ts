import { NextResponse } from "next/server";
import { getAuthenticatedSession } from "@/lib/auth-helpers";
import { getVisibleNetWorthTotals } from "@/lib/household/net-worth";
export const dynamic = "force-dynamic";
export async function GET() {
  const session = await getAuthenticatedSession();
  if (!session?.user.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  return NextResponse.json({ totals: await getVisibleNetWorthTotals(session.user.id) }, { headers: { "Cache-Control": "private, no-store" } });
}
