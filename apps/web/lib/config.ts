import { createPoiClient } from "@poi/shared";

// Browser-visible config (inlined at build time).
export const POI_API_URL = process.env.NEXT_PUBLIC_POI_API_URL ?? "http://localhost:4000";
export const BAZAAR_PUBLIC_URL = process.env.NEXT_PUBLIC_BAZAAR_URL ?? "http://localhost:4100";
export const PAYPAL_CLIENT_ID = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? "";

export const poi = createPoiClient({ baseUrl: POI_API_URL });
