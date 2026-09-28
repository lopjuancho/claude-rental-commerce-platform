import { z } from "zod";

/** Weather/safety hazards (mirrors public.weather_hazard). Wind is one of several, not a special case. */
export const WEATHER_HAZARDS = [
  "wind",
  "lightning",
  "rain",
  "severe_weather",
  "temperature",
  "custom",
] as const;
export type WeatherHazard = (typeof WEATHER_HAZARDS)[number];

export const THRESHOLD_UNITS = ["mph", "kph", "fahrenheit", "celsius", "inches_per_hour"] as const;
export type ThresholdUnit = (typeof THRESHOLD_UNITS)[number];

/** Hazards that usually carry a numeric operating limit, and the default unit offered in forms. */
export const HAZARD_DEFAULT_UNIT: Partial<Record<WeatherHazard, ThresholdUnit>> = {
  wind: "mph",
  temperature: "fahrenheit",
  rain: "inches_per_hour",
};

export const HAZARD_LABELS: Record<WeatherHazard, string> = {
  wind: "Wind",
  lightning: "Lightning",
  rain: "Rain",
  severe_weather: "Severe weather",
  temperature: "Temperature",
  custom: "Custom / manual safety",
};

/** One rule at one level (organization, category or product). */
export const hazardRuleInputSchema = z
  .object({
    hazard: z.enum(WEATHER_HAZARDS),
    sensitive: z.boolean(),
    thresholdValue: z.number().positive().max(9999).nullish(),
    thresholdUnit: z.enum(THRESHOLD_UNITS).nullish(),
    notes: z.string().trim().max(1000).nullish(),
  })
  .refine((r) => (r.thresholdValue == null) === (r.thresholdUnit == null), {
    message: "A threshold needs both a value and a unit.",
    path: ["thresholdUnit"],
  });
export type HazardRuleInput = z.infer<typeof hazardRuleInputSchema>;
