# Ingredient catalog coverage review

Reviewed and expanded 2026-10-14. This compares the live shared `data/catalog.sqlite` against manufacturer ranges and MoreBeer's current homebrew listings. [Catalog source pages](catalog-sources.md) records the provider URLs for future reviews. Counts below describe **our database**, not the number of products offered by a provider. This is a prioritized coverage review, not an import manifest or a claim that every provider SKU was enumerated.

## Completed catalog pass

The pre-pass backup held 86 products and 55 copied images. The catalog now holds **438 products and 370 copied images**, preserving the earlier IDs and rows. The pass added 352 products, copied 315 images, and enriched two existing grain specifications. It included the [Briess Lighthouse™ Munich Malt](https://brewingwithbriess.com/wp-content/uploads/documents/Briess-PISB-Lighthouse-Munich-Malt-040524.pdf) that prompted this review. Its catalog row has the manufacturer sheet, a square product image, an 80% typical extract yield, and the sheet's 6 SRM color value.

| Category | Before | Now | What changed |
| --- | ---: | ---: | --- |
| Grain | 32 | 313 | Expanded Briess, Weyermann, Crisp, Simpsons, BESTMALZ, Great Western, Dingemans, and Thomas Fawcett; added three Rahr base malts. |
| Other fermentables | 22 | 37 | Added Briess syrups/extracts and Weyermann extracts. |
| Adjunct | 1 | 3 | Added distinct manufacturer adjunct products. |
| Hops | 8 | 18 | Added ten verified Yakima Chief varieties, including Willamette, Idaho 7, Cashmere, Sabro, Fuggle, and Krush. |
| Yeast | 8 | 49 | Expanded Fermentis and Lallemand beer, cider, and mead strains. |
| Nutrient | 7 | 10 | Added Lallemand Servomyces, Yeastlife Extra, and Yeastlife O. |
| Chemical / Packaging | 2 / 6 | 2 / 6 | No additions in this pass. |

Manufacturer grain counts after the pass: Briess 59, Weyermann 46, Simpsons 45, Thomas Fawcett 39, Dingemans 36, BESTMALZ 32, Crisp 31, Great Western 22, and Rahr 3. These are distinct catalog products rather than bag sizes or milling variants. Source product pages are linked from the records. Where a manufacturer gives a grain color range, the stored single-value default uses its midpoint; unknown values remain null. Images were cropped to square and copied into SQLite, with none exceeding the app's 5 MB limit.

The database passed `PRAGMA integrity_check`, checks for orphaned product/spec/image rows, and a duplicate manufacturer/name check. The database is the sole source of product records and media; the source registry is only a list of provider pages. A backup was taken before the pass. Product URLs from older rows were retained where the manufacturer identity matched, so some existing Lallemand links still point to regional pages.

## Follow-up: yeast and hop media, 2026-10-14

The shared catalog now has **449 products and 415 copied images**. All 20 Lallemand yeast entries have images: 16 missing pack shots were copied from the [Lallemand US shop](https://shop-us.lallemandbrewing.com/catalog/). All 18 existing Yakima Chief hop entries now have variety photos from the [Yakima Chief variety pages](https://www.yakimachief.com/varieties); the Saaz row also has its specific product page instead of the generic variety index. Eleven [BarthHaas varieties](https://www.barthhaas.com/hops-and-products/hop-varieties-overview), including Hallertauer Mittelfrüh, Saaz, East Kent Goldings, and Galaxy, were added with their own product pages and variety artwork. Hop coverage is now 29 entries across two suppliers, each with an image. This is a coverage pass, not a complete inventory of either supplier's range. The authoritative records and images are in `data/catalog.sqlite`; they are not mirrored in Git seed files.

## Remaining coverage to add or review

| Priority | Provider/range | Representative missing products or families | Why |
| --- | --- | --- | --- |
| 1 | [Other maltsters found through MoreBeer](https://morebeer.com/pages/shop-by-brand) | Finish Rahr specialty malts; review Viking, Bairds, Canada Malting, and Muntons. | The eight major ranges above are much better covered, but these manufacturers still have little or no representation. Confirm current manufacturer pages and specs before adding products. |
| 1 | [MoreBeer pellet hops](https://morebeer.com/collections/pellet-hops) | Strata, additional New Zealand and Australian varieties, and other common supplier ranges. | Yakima Chief and BarthHaas cover more styles, but 29 entries still represent only a fraction of common hop use. Distinguish variety from supplier and crop lot. Many supplier pages are rate-limited, so do not invent product URLs or typical alpha acid values. |
| 2 | [MoreBeer extract listings](https://www.morebeer.com/category/malt-extract.html) | Store-brand LME formulations and dried rice or oat extract where distinct from existing Briess products. | The new syrups and Weyermann extracts help, but retailer aliases and package weights need deduplication before entry. |
| 2 | [Lallemand](https://www.lallemandbrewing.com/en/global/products/brewing-yeast/) and [Fermentis](https://fermentis.com/en/shop/) | Technical defaults still missing for some strains. | All current yeast entries have images. Add attenuation only where the exact manufacturer strain documentation provides it; do not guess from yeast style. |
| 3 | [MoreBeer brewing ingredients](https://www.morebeer.com/category/brewing-ingredients.html) | Water salts, clarifiers, acids, finings, enzymes, fruit concentrates, honey varieties, and priming products. | The catalog still has only two chemicals and three adjuncts. Add commodity generics when brand adds no useful distinction; add branded products when composition or instructions are specific. |

## Catalog entry rules

1. Make one catalog product for a distinct manufacturer formulation or malt variant. Do not duplicate it for package sizes, whole versus crushed grain, retailer aliases, or lot-specific analyses. Lots can override crop-dependent values.
2. Use the manufacturer product page or technical sheet as the primary source for product name, yield, color, attenuation, and images. A retailer may identify a gap or provide a purchase link, but its range often mixes products, kits, packaging, and aliases.
3. Preserve units and measurement context from the source. For example, Lighthouse's 6 SRM is a grain color value. An extract's SRM needs its stated test concentration before it can be used as a comparable calculation input. Leave unknown values null.
4. Add products, specs, links, and copied images directly to the authoritative SQLite catalog. Preserve IDs and existing rows; apply repeatable upserts so a range can be revisited safely. Back up and integrity-check the database before and after a large addition. The [source registry](catalog-sources.md) tracks provider pages, not product rows.
5. Review source ranges periodically. New or renamed products should be matched by manufacturer and product identity before inserting, and discontinued products should remain resolvable for existing recipes.

The next pass should prioritize other common hop supplier ranges and process ingredients, then review maltsters not yet represented. Do not treat a retailer's package listing as a distinct formulation.
