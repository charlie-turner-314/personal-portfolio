"use client";
import * as React from "react";
import { Label } from "@/components/ui/label";

export { Input } from "@/components/ui/input";
export { Label } from "@/components/ui/label";
export { Button as PrimaryButton } from "@/components/ui/button";

export function Field({
  label,
  children,
  className,
  htmlFor,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={`space-y-2 ${className ?? ""}`}>
      <Label htmlFor={htmlFor} className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
