import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getOnboardingStatus } from "@/lib/actions/onboarding";

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/login");
  }

  const onboardingStatus = await getOnboardingStatus();

  // If already completed onboarding, redirect to dashboard
  if (onboardingStatus?.isCompleted) {
    redirect("/");
  }

  return (
    <div className="min-h-svh flex items-start md:items-center justify-center bg-background p-4">
      <div className="w-full min-w-0 max-w-5xl">
        {children}
      </div>
    </div>
  );
}
