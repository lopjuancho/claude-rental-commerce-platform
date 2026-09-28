import {
  HAZARD_DEFAULT_UNIT,
  HAZARD_LABELS,
  THRESHOLD_UNITS,
  WEATHER_HAZARDS,
  type WeatherHazard,
} from "@/domain/weather/hazards";

export interface WeatherRuleValue {
  hazard: WeatherHazard;
  sensitive: boolean;
  threshold_value: number | null;
  threshold_unit: string | null;
}

const UNIT_LABELS: Record<string, string> = {
  mph: "mph",
  kph: "km/h",
  fahrenheit: "°F",
  celsius: "°C",
  inches_per_hour: "in/h",
};

/**
 * Per-hazard sensitivity at one level. "Inherit" leaves the decision to the next level
 * (product → category → organization). Field names: weather.<hazard>.mode|value|unit.
 */
export function WeatherRulesEditor({
  rules,
  inheritLabel = "Inherit",
  disabled,
}: {
  rules: WeatherRuleValue[];
  inheritLabel?: string;
  disabled?: boolean;
}) {
  const byHazard = new Map(rules.map((r) => [r.hazard, r]));
  return (
    <div className="grid gap-2">
      {WEATHER_HAZARDS.map((hazard) => {
        const rule = byHazard.get(hazard);
        const mode = rule ? (rule.sensitive ? "yes" : "no") : "inherit";
        const id = `weather-${hazard}`;
        return (
          <div
            key={hazard}
            className="grid grid-cols-[8rem_1fr] items-center gap-2 sm:grid-cols-[10rem_10rem_6rem_6rem]"
          >
            <label htmlFor={`${id}-mode`} className="text-sm font-medium">
              {HAZARD_LABELS[hazard]}
            </label>
            <select
              id={`${id}-mode`}
              name={`weather.${hazard}.mode`}
              defaultValue={mode}
              disabled={disabled}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="inherit">{inheritLabel}</option>
              <option value="yes">Sensitive</option>
              <option value="no">Not affected</option>
            </select>
            <label className="sr-only" htmlFor={`${id}-value`}>
              {HAZARD_LABELS[hazard]} limit
            </label>
            <input
              id={`${id}-value`}
              name={`weather.${hazard}.value`}
              type="number"
              step="0.5"
              min="0"
              placeholder="Limit"
              defaultValue={rule?.threshold_value ?? ""}
              disabled={disabled}
              className="col-start-2 h-9 rounded-md border bg-background px-2 text-sm sm:col-start-auto"
            />
            <label className="sr-only" htmlFor={`${id}-unit`}>
              {HAZARD_LABELS[hazard]} unit
            </label>
            <select
              id={`${id}-unit`}
              name={`weather.${hazard}.unit`}
              defaultValue={rule?.threshold_unit ?? HAZARD_DEFAULT_UNIT[hazard] ?? "mph"}
              disabled={disabled}
              className="col-start-2 h-9 rounded-md border bg-background px-2 text-sm sm:col-start-auto"
            >
              {THRESHOLD_UNITS.map((u) => (
                <option key={u} value={u}>
                  {UNIT_LABELS[u]}
                </option>
              ))}
            </select>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        A limit is optional. Without one, any confirmed weather block for that hazard applies.
      </p>
    </div>
  );
}
