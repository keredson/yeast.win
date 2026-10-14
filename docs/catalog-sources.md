# Catalog source pages

This is the tracked list of pages consulted for product discovery and catalog coverage. Product records, specifications, and copied images live only in `data/catalog.sqlite`; this file is provenance and a review checklist, not seed data. Prefer each manufacturer's current product page and technical sheet for names and specifications. Retail listings help identify products available to homebrewers, but may group sizes or relabel products. Reviewed 2026-10-14.

| Provider | Role | Pages reviewed | Catalog use |
| --- | --- | --- | --- |
| Briess | Manufacturer | [All malts and adjuncts](https://brewingwithbriess.com/products/), [extracts](https://brewingwithbriess.com/products/extracts/), [malt typical analysis](https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf), [extract typical analysis](https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TA-Extract-Sheet-Apr22.pdf), [Lighthouse Munich sheet](https://brewingwithbriess.com/wp-content/uploads/documents/Briess-PISB-Lighthouse-Munich-Malt-040524.pdf) | Grain and extract names, yield/color, product links, images. |
| Weyermann | Manufacturer | [Brewery product range](https://www.weyermann.de/produkte/brauerei/), [US brewery brochure](https://www.weyermann.de/wp-content/uploads/2023/03/WEYERMANN_PRODUCTS_BREWERY_US.pdf) | Malt and extract variants, technical defaults. |
| Crisp Malt | Manufacturer | [Our malts](https://crispmalt.com/en-us/our-malts/), [specialty malts](https://crispmalt.com/en-us/our-malts/speciality/) | Base and specialty malt variants. |
| Simpsons Malt | Manufacturer | [Our malts](https://www.simpsonsmalt.co.uk/our-malts), [product range](https://www.simpsonsmalt.co.uk/media/krolitr5/simpsons-malt-baltic-brewing-supplies-product-range-nov25.pdf) | Base, crystal, roasted, and flaked malt variants. |
| BESTMALZ | Manufacturer | [Malts overview](https://bestmalz.de/en/), [2026 product brochure](https://bestmalz.de/wp-content/uploads/2026/01/BESTMALZ_Malz-Broschuere_ENG_A6_2026-01_WEB.pdf) | Candidate malt family and variants. |
| Great Western Malting | Manufacturer | [Products](https://www.greatwesternmalting.com/products/) | Base and specialty malt names, product pages, technical defaults, and images. |
| Dingemans | Manufacturer | [Malt products](https://www.dingemansmout.be/projects) | Base and specialty malt names, product pages, technical defaults, and images. |
| Thomas Fawcett | Manufacturer | [Our malts](https://www.fawcett-maltsters.co.uk/our-malts/) | Base and specialty malt names, product pages, technical defaults, and images. |
| Rahr | Manufacturer | [The Brewer’s Standard 2-Row](https://www.rahrbsg.com/rahr-the-brewers-standard-2-row-malt-55-lb/p), [The Brewer’s Standard Pale Ale](https://www.rahrbsg.com/rahr-the-brewers-standard-pale-ale-malt/p), [Premium Pilsner](https://www.rahrbsg.com/rahr-premium-pilsner-malt-2200-lb-tote/p) | Three distinct base malt products; no technical values were inferred from retail package size. |
| Fermentis | Manufacturer | [Beer yeast range](https://fermentis.com/en/fermentation-solutions/beer/), [SafCider AC-4](https://fermentis.com/en/product/safcider-ac-4/) | Beer and cider yeast candidates; manufacturer technical sheets. |
| Lallemand Brewing | Manufacturer | [Current yeast range](https://www.lallemandbrewing.com/en/global/products/brewing-yeast/), [nutrients and additives](https://www.lallemandbrewing.com/en/continental-europe/products/nutrients/), [US product catalog](https://shop-us.lallemandbrewing.com/catalog/) | Current yeast strain pages, three nutrient formulations, and copied yeast pack images from the US shop. The existing Fermaid entries retain their Scott Labs distributor links. |
| Yakima Chief Hops | Grower cooperative/supplier | [Current varieties](https://www.yakimachief.com/varieties), [Willamette](https://www.yakimachief.com/variety/willamette), [Idaho 7](https://www.yakimachief.com/variety/idaho-7-brand), [Saaz](https://www.yakimachief.com/variety/saaz-czs01) | Verify variety identity and link to each variety page; copy the variety cone photos from Yakima Chief's media CDN. Pellet versus whole-cone form and crop-specific alpha acid remain inventory-lot information. |
| BarthHaas | Hop supplier | [Hop varieties](https://www.barthhaas.com/hops-and-products/hop-varieties-overview), [Hallertauer Mittelfrüh](https://www.barthhaas.com/hops-and-products/hops/hallertauer-mittelfrueh), [East Kent Goldings](https://www.barthhaas.com/hops-and-products/hops/east-kent-golding) | Eleven verified European and Australian variety entries, their product links, and copied variety artwork. Crop-specific alpha acid remains an inventory-lot value. |
| MoreBeer | Retailer/discovery | [Grains and malts](https://morebeer.com/collections/grains-malt-and-barley), [malt extracts](https://www.morebeer.com/category/malt-extract.html), [pellet hops](https://morebeer.com/collections/pellet-hops), [brewing ingredients](https://www.morebeer.com/category/brewing-ingredients.html), [brands](https://morebeer.com/pages/shop-by-brand) | Find common homebrew products and brands missing from the catalog; confirm specs with manufacturer. |

When adding a source, record the provider, its role, the exact pages consulted, and how the page informs catalog work. Record each product's own best information URL in the catalog database. Review this list when provider ranges or URLs change.

## Yeast apparent attenuation reviewed 2026-10-14

The catalog currently has one attenuation percentage per yeast. The values below are the midpoint of the manufacturer's published range, used as a planning default rather than a guarantee for a particular wort or fermentation. These are catalog data edits, not startup seeds.

| Catalog yeast | Manufacturer range | Catalog value | Source |
| --- | ---: | ---: | --- |
| Fermentis SafAle K-97 | 80–84% | 82% | [Fermentis beer yeast chart](https://fermentis.com/wp-content/uploads/2021/06/Beer-Yeast-Chart.pdf) (medium attenuation) |
| Fermentis SafAle S-04 | 80–84% | 82% | [Fermentis beer yeast chart](https://fermentis.com/wp-content/uploads/2021/06/Beer-Yeast-Chart.pdf) (medium attenuation) |
| Fermentis SafAle US-05 | 80–84% | 82% | [Fermentis beer yeast chart](https://fermentis.com/wp-content/uploads/2021/06/Beer-Yeast-Chart.pdf) (medium attenuation) |
| Fermentis SafLager W-34/70 | 80–84% | 82% | [Fermentis W-34/70 specifications](https://fermentis.com/en/news/testimonials/brewer-stories-highland-park-brewery-saflager-w-34-70/) |
| Lallemand Brewing LalBrew Diamond Lager | 77–83% | 80% | [Lallemand Diamond](https://www.lallemandbrewing.com/en/global/products/diamond-lager-yeast) |
| Lallemand Brewing LalBrew New England | 78–83% | 80.5% | [Lallemand New England](https://www.lallemandbrewing.com/en/global/products/lalbrew-new-england/) |
| Lallemand Brewing LalBrew Nottingham | 78–84% | 81% | [Lallemand Nottingham](https://www.lallemandbrewing.com/en/united-kingdom/products/nottingham-high-performance-ale-yeast/) |
| Lallemand Brewing LalBrew Verdant IPA | 75–82% | 78.5% | [Lallemand Verdant IPA](https://www.lallemandbrewing.com/en/continental-europe/products/lalbrew-verdant-ipa/) |
