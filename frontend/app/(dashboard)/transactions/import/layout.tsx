import { redirect } from "next/navigation";
import { getAuthenticatedSession } from "@/lib/household/financial-auth";
import { isDemoRestrictedUserEmail } from "@/lib/demo-access";

export default async function TransactionsImportLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getAuthenticatedSession();

  if (!session) {
    redirect("/login");
  }

  if (isDemoRestrictedUserEmail(session.user.email)) {
    redirect("/transactions");
  }

  return children;
}
