"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RiArrowRightLine, RiLoader4Line } from "@remixicon/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress";
import { ProfilePhotoUpload } from "@/components/onboarding/profile-photo-upload";
import { CurrencySelector } from "@/components/onboarding/currency-selector";
import { updatePersonalDetails, getCurrentUser } from "@/lib/actions/onboarding";
import {
  COUNTRY_OPTIONS,
  FALLBACK_REGIONAL_DEFAULTS,
  LOCALE_OPTIONS,
  getCountryDefaults,
  inferCountryCodeFromProfile,
} from "@/lib/constants";

export default function OnboardingStep1Page() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [countryCode, setCountryCode] = useState(FALLBACK_REGIONAL_DEFAULTS.code);
  const [locale, setLocale] = useState(FALLBACK_REGIONAL_DEFAULTS.defaultLocale);
  const [currency, setCurrency] = useState(FALLBACK_REGIONAL_DEFAULTS.defaultCurrency);
  const [profilePhoto, setProfilePhoto] = useState<File | null>(null);
  const [defaultImage, setDefaultImage] = useState<string | null>(null);
  const currencyWasManuallyChanged = useRef(false);

  // Load current user data on mount
  useEffect(() => {
    async function loadUser() {
      const user = await getCurrentUser();
      if (user) {
        setName(user.name || "");
        const browserLocale = typeof navigator === "undefined" ? null : navigator.language;
        const browserTimeZone = typeof Intl === "undefined"
          ? null
          : Intl.DateTimeFormat().resolvedOptions().timeZone;
        const hasSavedRegion = Boolean(user.countryCode || user.locale);
        const savedFunctionalCurrency = hasSavedRegion || user.functionalCurrency !== "EUR"
          ? user.functionalCurrency
          : null;
        const inferredCountryCode = inferCountryCodeFromProfile({
          countryCode: user.countryCode,
          functionalCurrency: savedFunctionalCurrency,
          locale: user.locale || browserLocale,
          timeZone: browserTimeZone,
        });
        const defaults = getCountryDefaults(inferredCountryCode);
        setCountryCode(defaults.code);
        setLocale(user.locale || defaults.defaultLocale);
        setCurrency(savedFunctionalCurrency || defaults.defaultCurrency);
        setDefaultImage(user.profilePhotoPath || user.image || null);
      }
    }
    loadUser();
  }, []);

  const handleCountryChange = (nextCountryCode: string) => {
    const defaults = getCountryDefaults(nextCountryCode);
    setCountryCode(defaults.code);
    setLocale(defaults.defaultLocale);
    if (!currencyWasManuallyChanged.current) {
      setCurrency(defaults.defaultCurrency);
    }
  };

  const handleCurrencyChange = (nextCurrency: string) => {
    currencyWasManuallyChanged.current = true;
    setCurrency(nextCurrency);
    if (nextCurrency === "AUD") {
      setCountryCode("AU");
      setLocale("en-AU");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      toast.error("Please enter your name");
      return;
    }

    startTransition(async () => {
      const formData = new FormData();
      formData.append("name", name);
      formData.append("currency", currency);
      formData.append("countryCode", countryCode);
      formData.append("locale", locale);
      if (profilePhoto) {
        formData.append("profilePhoto", profilePhoto);
      }

      const result = await updatePersonalDetails(formData);

      if (result.success) {
        router.push("/step-2");
      } else {
        toast.error(result.error || "Failed to save profile");
      }
    });
  };

  return (
    <div className="space-y-8">
      <OnboardingProgress currentStep={1} />

      <Card className="min-h-[720px] flex flex-col">
        <CardHeader>
          <CardTitle>Welcome! Let&apos;s set up your profile</CardTitle>
          <CardDescription>
            Tell us a bit about yourself to personalize your experience.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit} className="flex flex-1 flex-col">
          <CardContent className="space-y-6 flex-1 min-h-0">
            <div className="flex flex-col items-center gap-4">
              <Label className="text-center">Profile Photo</Label>
              <ProfilePhotoUpload
                value={profilePhoto}
                onChange={setProfilePhoto}
                defaultImage={defaultImage}
                name={name}
              />
              <p className="text-xs text-muted-foreground text-center">
                Click or drag to upload a profile photo (optional)
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">Your Name *</Label>
              <Input
                id="name"
                placeholder="Enter your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            <CurrencySelector
              value={currency}
              onChange={handleCurrencyChange}
              label="Functional Currency"
              showTooltip={true}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="country">Country</Label>
                <Select value={countryCode} onValueChange={(v) => v && handleCountryChange(v)}>
                  <SelectTrigger id="country">
                    <SelectValue placeholder="Select country" />
                  </SelectTrigger>
                  <SelectContent>
                    {COUNTRY_OPTIONS.map((country) => (
                      <SelectItem key={country.code} value={country.code}>
                        {country.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="locale">Locale</Label>
                <Select value={locale} onValueChange={(v) => v && setLocale(v)}>
                  <SelectTrigger id="locale">
                    <SelectValue placeholder="Select locale" />
                  </SelectTrigger>
                  <SelectContent>
                    {LOCALE_OPTIONS.map((localeOption) => (
                      <SelectItem key={localeOption.code} value={localeOption.code}>
                        {localeOption.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
          <CardFooter className="flex justify-end">
            <Button type="submit" disabled={isPending || !name.trim()}>
              {isPending ? (
                <>
                  <RiLoader4Line className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  Continue
                  <RiArrowRightLine className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
