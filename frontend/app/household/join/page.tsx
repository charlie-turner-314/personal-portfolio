import Link from "next/link";
import { getAuthenticatedSession } from "@/lib/auth-helpers";
import { JoinHousehold } from "./join-household";

export const metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function JoinHouseholdPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const session = await getAuthenticatedSession();
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return <main className="mx-auto max-w-lg p-8">This invitation link is invalid. Ask the household owner for a new one.</main>;
  const returnTo = `/household/join?token=${token}`;
  return <main className="mx-auto max-w-lg space-y-5 p-8">
    <h1 className="text-2xl font-semibold">Join a household</h1>
    <p>Use your own login to work with this household’s accounts, transactions, investments and reports. Your existing personal data stays saved separately and becomes available again if you leave.</p>
    <p>Your personal finances and bank connections stay private. You can view and edit accounts explicitly shared with you. Joining does not share your own accounts or net worth. The household owner manages membership, and each account owner controls sharing.</p>
    {session ? <JoinHousehold token={token} email={session.user.email} /> : <div className="flex gap-4">
      <Link className="underline" href={`/login?redirect=${encodeURIComponent(returnTo)}`}>Sign in</Link>
      <Link className="underline" href={`/register?redirect=${encodeURIComponent(returnTo)}`}>Create an account</Link>
    </div>}
  </main>;
}
