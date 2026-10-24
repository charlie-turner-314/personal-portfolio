"use client";

import { SidebarTrigger } from "@/components/ui/sidebar";

export function MobileNavigation() {
  return (
    <nav aria-label="Mobile navigation" className="sticky top-0 z-40 flex min-h-12 items-center gap-2 border-b bg-background px-4 pt-[env(safe-area-inset-top)] md:hidden">
      <SidebarTrigger className="size-11" />
      <span className="text-sm font-medium">Personal Portfolio</span>
    </nav>
  );
}
