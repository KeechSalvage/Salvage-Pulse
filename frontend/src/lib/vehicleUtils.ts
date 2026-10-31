import type { BodyType } from "./types";

/**
 * Normalizes vehicle body type label and code based on make, model, or existing body_type field.
 * Common categories: "Pickup" | "SUV" | "Car" | "Van" | "Other"
 */

const MODEL_BODY_MAP: Record<string, BodyType> = {
  // Pickups / Trucks
  "f-150": "pickup",
  "f-250": "pickup",
  "f-350": "pickup",
  "f-450": "pickup",
  "silverado": "pickup",
  "silverado 1500": "pickup",
  "silverado 2500": "pickup",
  "silverado 3500": "pickup",
  "sierra": "pickup",
  "sierra 1500": "pickup",
  "sierra 2500": "pickup",
  "sierra 3500": "pickup",
  "ram 1500": "pickup",
  "ram 2500": "pickup",
  "ram 3500": "pickup",
  "1500": "pickup",
  "2500": "pickup",
  "3500": "pickup",
  "tacoma": "pickup",
  "tundra": "pickup",
  "colorado": "pickup",
  "canyon": "pickup",
  "ranger": "pickup",
  "frontier": "pickup",
  "titan": "pickup",
  "gladiator": "pickup",
  "ridgeline": "pickup",
  "dakota": "pickup",

  // SUVs / Crossovers
  "grand cherokee": "suv",
  "cherokee": "suv",
  "wrangler": "suv",
  "compass": "suv",
  "renegade": "suv",
  "explorer": "suv",
  "expedition": "suv",
  "escape": "suv",
  "edge": "suv",
  "bronco": "suv",
  "bronco sport": "suv",
  "tahoe": "suv",
  "suburban": "suv",
  "equinox": "suv",
  "traverse": "suv",
  "blazer": "suv",
  "trailblazer": "suv",
  "yukon": "suv",
  "yukon xl": "suv",
  "acadia": "suv",
  "terrain": "suv",
  "rav4": "suv",
  "highlander": "suv",
  "4runner": "suv",
  "sequoia": "suv",
  "cr-v": "suv",
  "pilot": "suv",
  "passport": "suv",
  "hr-v": "suv",
  "rogue": "suv",
  "murano": "suv",
  "pathfinder": "suv",
  "armada": "suv",
  "tucson": "suv",
  "santa fe": "suv",
  "palisade": "suv",
  "sportage": "suv",
  "sorento": "suv",
  "telluride": "suv",
  "cx-3": "suv",
  "cx-30": "suv",
  "cx-5": "suv",
  "cx-50": "suv",
  "cx-9": "suv",
  "cx-90": "suv",
  "outback": "suv",
  "forester": "suv",
  "crosstrek": "suv",
  "ascent": "suv",
  "journey": "suv",
  "durango": "suv",

  // Vans / Minivans / Commercial Vans
  "transit": "van",
  "transit connect": "van",
  "e-series": "van",
  "e-150": "van",
  "e-250": "van",
  "e-350": "van",
  "grand caravan": "van",
  "caravan": "van",
  "pacifica": "van",
  "town & country": "van",
  "town and country": "van",
  "promaster": "van",
  "promaster city": "van",
  "sienna": "van",
  "odyssey": "van",
  "sedona": "van",
  "carnival": "van",
  "express": "van",
  "express 1500": "van",
  "express 2500": "van",
  "express 3500": "van",
  "savana": "van",

  // Cars / Sedans / Coupes / Hatchbacks
  "camry": "car",
  "corolla": "car",
  "avalon": "car",
  "prius": "car",
  "accord": "car",
  "civic": "car",
  "insight": "car",
  "fit": "car",
  "altima": "car",
  "sentra": "car",
  "maxima": "car",
  "versa": "car",
  "fusion": "car",
  "focus": "car",
  "fiesta": "car",
  "taurus": "car",
  "mustang": "car",
  "malibu": "car",
  "impala": "car",
  "cruze": "car",
  "sonic": "car",
  "spark": "car",
  "camaro": "car",
  "corvette": "car",
  "optima": "car",
  "k5": "car",
  "forte": "car",
  "rio": "car",
  "stinger": "car",
  "cadenza": "car",
  "elantra": "car",
  "sonata": "car",
  "accent": "car",
  "veloster": "car",
  "charger": "car",
  "challenger": "car",
  "dart": "car",
  "chrysler 300": "car",
  "300": "car",
  "3 series": "car",
  "328i": "car",
  "330i": "car",
  "5 series": "car",
  "c-class": "car",
  "e-class": "car",
  "impreza": "car",
  "legacy": "car",
  "wrx": "car",
};

/**
 * Returns normalized BodyType ("pickup" | "suv" | "car" | "van" | "other").
 */
export function inferBodyType(
  model?: string | null,
  make?: string | null,
  explicitBodyType?: string | null
): BodyType {
  if (explicitBodyType) {
    const raw = explicitBodyType.trim().toLowerCase();
    if (raw === "pickup" || raw === "truck") return "pickup";
    if (raw === "suv" || raw === "crossover") return "suv";
    if (raw === "van" || raw === "minivan") return "van";
    if (raw === "car" || raw === "sedan" || raw === "coupe" || raw === "hatchback") return "car";
  }

  const m = (model ?? "").trim().toLowerCase();
  if (m && MODEL_BODY_MAP[m]) {
    return MODEL_BODY_MAP[m];
  }

  // Fuzzy check on model string
  if (
    m.includes("f-150") ||
    m.includes("f-250") ||
    m.includes("f-350") ||
    m.includes("silverado") ||
    m.includes("sierra") ||
    m.includes("tacoma") ||
    m.includes("tundra") ||
    m.includes("ram 1500") ||
    m.includes("ram 2500") ||
    m.includes("colorado") ||
    m.includes("canyon") ||
    m.includes("ranger") ||
    m.includes("frontier") ||
    m.includes("titan") ||
    m.includes("pickup") ||
    m.includes("truck")
  ) {
    return "pickup";
  }

  if (
    m.includes("cherokee") ||
    m.includes("wrangler") ||
    m.includes("explorer") ||
    m.includes("expedition") ||
    m.includes("tahoe") ||
    m.includes("suburban") ||
    m.includes("equinox") ||
    m.includes("traverse") ||
    m.includes("yukon") ||
    m.includes("rav4") ||
    m.includes("highlander") ||
    m.includes("4runner") ||
    m.includes("cr-v") ||
    m.includes("pilot") ||
    m.includes("rogue") ||
    m.includes("pathfinder") ||
    m.includes("tucson") ||
    m.includes("santa fe") ||
    m.includes("sportage") ||
    m.includes("sorento") ||
    m.includes("cx-5") ||
    m.includes("outback") ||
    m.includes("forester") ||
    m.includes("suv")
  ) {
    return "suv";
  }

  if (
    m.includes("caravan") ||
    m.includes("transit") ||
    m.includes("pacifica") ||
    m.includes("sienna") ||
    m.includes("odyssey") ||
    m.includes("promaster") ||
    m.includes("express") ||
    m.includes("van")
  ) {
    return "van";
  }

  if (
    m.includes("camry") ||
    m.includes("corolla") ||
    m.includes("accord") ||
    m.includes("civic") ||
    m.includes("altima") ||
    m.includes("sentra") ||
    m.includes("fusion") ||
    m.includes("malibu") ||
    m.includes("impala") ||
    m.includes("optima") ||
    m.includes("elantra") ||
    m.includes("sonata") ||
    m.includes("charger") ||
    m.includes("sedan") ||
    m.includes("coupe")
  ) {
    return "car";
  }

  // Check make fallback (e.g. Ram without model is likely truck, Jeep likely suv)
  const mk = (make ?? "").trim().toLowerCase();
  if (mk === "ram") return "pickup";
  if (mk === "jeep") return "suv";

  return "other";
}

/**
 * Returns human-friendly display label for a body type.
 */
export function formatBodyType(body: BodyType | string): string {
  switch (body) {
    case "pickup":
      return "Truck / Pickup";
    case "suv":
      return "SUV";
    case "car":
      return "Sedan / Car";
    case "van":
      return "Van";
    default:
      return "Other";
  }
}
