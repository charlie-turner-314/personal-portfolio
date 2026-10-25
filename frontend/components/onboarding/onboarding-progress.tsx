"use client";

import { cn } from "@/lib/utils";

interface Step {
  number: number;
  title: string;
  description: string;
}

const steps: Step[] = [
  {
    number: 1,
    title: "Profile",
    description: "Set up your account",
  },
  {
    number: 2,
    title: "Categories",
    description: "Customize spending categories",
  },
  {
    number: 3,
    title: "Bank Accounts",
    description: "Create your first account",
  },
  {
    number: 4,
    title: "Add Transactions",
    description: "Import your data",
  },
];

interface OnboardingProgressProps {
  currentStep: number;
}

export function OnboardingProgress({ currentStep }: OnboardingProgressProps) {
  return (
    <div className="w-full">
      <div className="grid grid-cols-2 gap-4 md:flex md:items-center md:justify-between">
        {steps.map((step, index) => (
          <div key={step.number} className="flex min-w-0 items-center">
            <div className="flex min-w-0 flex-1 flex-col items-center">
              <div
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-full border-2 text-sm font-medium transition-colors",
                  currentStep === step.number
                    ? "border-primary bg-primary text-primary-foreground"
                    : currentStep > step.number
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-muted-foreground/30 text-muted-foreground"
                )}
              >
                {currentStep > step.number ? (
                  <svg
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  step.number
                )}
              </div>
              <div className="mt-2 text-center">
                <p
                  className={cn(
                    "text-sm font-medium",
                    currentStep >= step.number ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {step.title}
                </p>
                <p className="text-xs text-muted-foreground">{step.description}</p>
              </div>
            </div>
            {index < steps.length - 1 && (
              <div
                className={cn(
                  "mx-0 h-0.5 w-0 md:mx-4 md:flex-1 md:min-w-[60px]",
                  currentStep > step.number ? "bg-primary" : "bg-muted-foreground/30"
                )}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
