export const effectiveSuppliesView = `CREATE TEMP VIEW effective_supplies AS
  SELECT s.id, s.id AS supply_id, s.name, s.category, s.default_unit,
    s.default_unit AS display_unit, NULL AS location_id, s.catalog_supply_id,
    COALESCE(g.grain_class, cgclass.grain_class) AS grain_class,
    COALESCE(g.yield_pct, cg.yield_pct) AS yield_pct,
    COALESCE(g.color_lovibond, cg.color_lovibond) AS color_lovibond,
    COALESCE(h.alpha_acid_pct, ch.alpha_acid_pct) AS alpha_acid_pct,
    COALESCE(h.hop_form, ch.hop_form) AS hop_form,
    COALESCE(y.attenuation_pct, cy.attenuation_pct) AS attenuation_pct,
    COALESCE(o.typical_brix, co.typical_brix) AS typical_brix,
    COALESCE(o.extract_color_value, co.extract_color_value) AS extract_color_value,
    COALESCE(o.extract_color_scale, co.extract_color_scale) AS extract_color_scale,
    COALESCE(o.extract_color_reference_value, co.extract_color_reference_value) AS extract_color_reference_value,
    COALESCE(o.extract_color_reference_unit, co.extract_color_reference_unit) AS extract_color_reference_unit
  FROM main.supplies s
  LEFT JOIN main.supply_grain_specs g ON g.supply_id = s.id
  LEFT JOIN main.supply_hop_specs h ON h.supply_id = s.id
  LEFT JOIN main.supply_yeast_specs y ON y.supply_id = s.id
  LEFT JOIN main.supply_other_fermentable_specs o ON o.supply_id = s.id
  LEFT JOIN catalog.supply_grain_specs cg ON cg.supply_id = s.catalog_supply_id
  LEFT JOIN catalog.supply_grain_classes cgclass ON cgclass.supply_id = s.catalog_supply_id
  LEFT JOIN catalog.supply_hop_specs ch ON ch.supply_id = s.catalog_supply_id
  LEFT JOIN catalog.supply_yeast_specs cy ON cy.supply_id = s.catalog_supply_id
  LEFT JOIN catalog.supply_other_fermentable_specs co ON co.supply_id = s.catalog_supply_id`;
