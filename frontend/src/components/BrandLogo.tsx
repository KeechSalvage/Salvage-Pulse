import type { Branding } from "@/lib/types";

/** The yard's logo when uploaded, otherwise the Salvage Pulse logo. */
export default function BrandLogo({ branding, className = "h-10 w-auto", testId = "brand-logo" }: { branding?: Branding; className?: string; testId?: string }) {
  const own = !!branding?.logo_url;
  return (
    <img
      data-testid={testId}
      src={own ? branding.logo_url : "/salvage-pulse-logo.jpg"}
      alt={own ? branding.yard_name : "Salvage Pulse"}
      className={`${className} max-w-[120px] rounded object-contain`}
    />
  );
}
