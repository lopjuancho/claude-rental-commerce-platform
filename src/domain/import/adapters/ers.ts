import type { ImportAdapter } from "./types";

/**
 * Event Rental Systems (ERS) inventory export.
 *
 * UNVERIFIED: these header synonyms are educated guesses until checked against a real ERS export
 * (MVP.md open question). Staff review and can correct every suggested mapping before import,
 * and corrected mappings can be saved as an organization preset.
 */
export const ersAdapter: ImportAdapter = {
  id: "ers",
  label: "Event Rental Systems (ERS) export",
  externalSource: "ers",
  verified: false,
  headerSynonyms: {
    external_ref: ["item id", "itemid", "id", "inventory id"],
    name: ["item name", "item", "name", "rental name"],
    short_description: ["short description", "summary"],
    description: ["description", "item description", "web description"],
    base_price: ["price", "rental price", "base price", "rate"],
    included_hours: ["hours", "rental hours", "rental period"],
    category: ["category", "categories", "item category"],
    quantity: ["quantity", "qty", "inventory", "quantity owned"],
    is_published: ["display on website", "show online", "active", "web active"],
    minimum_age: ["min age", "minimum age"],
    maximum_age: ["max age", "maximum age"],
    recommended_capacity: ["capacity", "max occupancy", "riders"],
    dimensions: ["size", "dimensions", "item size", "space required"],
    power_outlets_required: ["outlets", "outlets needed", "electrical outlets"],
    power_notes: ["power", "power requirements"],
    water_required: ["water", "water required"],
    operator_required: ["operator", "operator required"],
    attendants_required: ["attendants", "staff needed"],
    setup_requirements: ["setup requirements", "setup notes"],
    internal_notes: ["notes", "internal notes"],
  },
};
