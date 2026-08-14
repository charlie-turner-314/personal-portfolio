"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { ProfilePhotoUpload } from "@/components/onboarding/profile-photo-upload";
import { updateUserProfile } from "@/lib/actions/settings";
import {
  COUNTRY_OPTIONS,
  LOCALE_OPTIONS,
  getCountryDefaults,
  inferCountryCodeFromProfile,
} from "@/lib/constants";
import type { User } from "@/lib/db/schema";

interface ProfileEditorProps {
  user: User;
}

export function ProfileEditor({ user }: ProfileEditorProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [name, setName] = useState(user.name || "");
  const initialCountryDefaults = getCountryDefaults(inferCountryCodeFromProfile({
    countryCode: user.countryCode,
    functionalCurrency: user.functionalCurrency,
    locale: user.locale,
  }));
  const [countryCode, setCountryCode] = useState(initialCountryDefaults.code);
  const [locale, setLocale] = useState(user.locale || initialCountryDefaults.defaultLocale);
  const [profilePhoto, setProfilePhoto] = useState<File | null>(null);

  const handleCountryChange = (nextCountryCode: string) => {
    const defaults = getCountryDefaults(nextCountryCode);
    setCountryCode(defaults.code);
    setLocale(defaults.defaultLocale);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      toast.error("Please enter your name");
      return;
    }

    setIsLoading(true);

    try {
      const formData = new FormData();
      formData.append("name", name.trim());
      formData.append("countryCode", countryCode);
      formData.append("locale", locale);
      if (profilePhoto) {
        formData.append("profilePhoto", profilePhoto);
      }

      const result = await updateUserProfile(formData);

      if (result.success) {
        toast.success("Profile updated successfully");
        setProfilePhoto(null);
        router.refresh();
      } else {
        toast.error(result.error || "Failed to update profile");
      }
    } catch {
      toast.error("An error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>
          Update your personal information and preferences.
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-6 pb-6">
          <ProfilePhotoUpload
            value={profilePhoto}
            onChange={setProfilePhoto}
            defaultImage={user.profilePhotoPath || user.image}
            name={name}
          />

          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className="w-fit min-w-[200px]"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              value={user.email}
              disabled
              className="w-fit min-w-[200px] bg-muted"
            />
            <p className="text-xs text-muted-foreground">
              Email cannot be changed.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="currency">Functional Currency</Label>
            <Input
              id="currency"
              value={user.functionalCurrency || "EUR"}
              disabled
              className="w-fit min-w-[80px] bg-muted"
            />
            <p className="text-xs text-muted-foreground">
              Functional currency is set during onboarding and cannot be changed.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="country">Country</Label>
              <Select value={countryCode} onValueChange={(v) => v && handleCountryChange(v)}>
                <SelectTrigger id="country" className="w-fit min-w-[200px]">
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
              <p className="text-xs text-muted-foreground">
                Used for local defaults, financial-year periods, and onboarding guidance.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="locale">Locale</Label>
              <Select value={locale} onValueChange={(v) => v && setLocale(v)}>
                <SelectTrigger id="locale" className="w-fit min-w-[200px]">
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
              <p className="text-xs text-muted-foreground">
                Used for display preferences separate from reporting currency.
              </p>
            </div>
          </div>
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={isLoading}>
            {isLoading ? "Saving..." : "Save Changes"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
