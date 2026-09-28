/** Closed vocabularies mirrored from database enums / CHECK constraints (see catalog migration). */
export const EVENT_TYPES = [
  "birthday",
  "school",
  "church",
  "corporate",
  "community",
  "graduation",
  "festival",
  "wedding",
  "sports",
  "holiday",
  "other",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const SURFACES = [
  "grass",
  "turf",
  "concrete",
  "asphalt",
  "dirt",
  "gravel",
  "indoor_floor",
] as const;
export type Surface = (typeof SURFACES)[number];

export const ANCHORING_METHODS = ["stakes", "sandbags", "water_barrels"] as const;
export const PRICING_TYPES = ["per_event", "hourly", "daily", "per_unit"] as const;
export const TRACKING_MODES = ["serialized", "pooled"] as const;
export const MEDIA_RIGHTS = ["owned", "licensed", "supplier_permitted", "unverified"] as const;
export type MediaRights = (typeof MEDIA_RIGHTS)[number];
