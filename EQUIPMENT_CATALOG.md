# Equipment catalog sources

The suggested models are a curated starting list, not a sales ranking. [MoreBeer's
best-selling products](https://morebeer.com/collections/top-50-best-selling-products)
and [all-grain systems](https://morebeer.com/collections/complete-all-grain-brewing-systems)
inform which homebrew product families to include. Manufacturer pages verify model names,
roles, and any preset capacity. Brewers can enter any other model by name.

| Product family | Manufacturer source |
| --- | --- |
| DigiBoil electric kettle | [KegLand 35L DigiBoil](https://kegland.com.au/products/35l-digiboil-digital-turbo-boiler-2400watt), [65L DigiBoil](https://kegland.com.au/products/65l-digiboil-digital-turbo-boiler-3500watt) |
| BrewZilla all-in-one | [KegLand BrewZilla Gen 4.1 35L](https://kegland.com.au/products/brewzilla-35l-gen-4), [BrewZilla range](https://kegland.com.au/collections/brewzilla-range-accessories) |
| Grainfather brewing systems | [Grainfather G30 and G40 comparison](https://us.grainfather.com/pages/compare-the-grainfather-brewing-systems) |
| Anvil Foundry | [Anvil all-in-one systems](https://anvilbrewing.com/all-in-one-systems/) |
| VEVOR electric brewing system | [VEVOR 9.2 gal / 35 L vessel, 2500 W model](https://eur.vevor.com/beer-brewing-system-c_11816/vevor-all-in-one-grain-brewing-system-home-beer-brewer-w-circulating-pump-30-l-p_010108577563) |
| Controlled fermentation | [Grainfather GF30](https://us.grainfather.com/products/gf30-conical-fermenter), [KegLand RAPT Fermentation Chamber](https://kegland.com.au/products/rapt-temperature-controlled-fermentation-chamber) |
| FermZilla fermenters | [30 L All Rounder](https://kegland.com.au/products/fermzilla-30l-all-rounder-pressure-rated-keg-fermenter-now-with-stainless-handle), [60 L All Rounder](https://kegland.com.au/products/fermzilla-60l-all-rounder-pressure-rated-keg-fermenter), [27 L Gen3 Tri-Conical](https://kegland.com.au/products/fermzilla-27l-tri-conical-uni-tank-fermenter-gen3), [55 L Gen3 Tri-Conical](https://kegland.com.au/products/55l-fermzilla-tri-conical-pressure-brewing-kit), [30 L Flat Bottom](https://kegland.com.au/products/fermzilla-flat-bottom-with-tap-30l-fermenter-includes-volume-sticker-and-temperature-sticker) |
| Temperature controllers | [Inkbird ITC-308 series](https://www.inkbird.com/collections/smart-appliances/products/temperature-controller-itc-308), [KegLand RAPT Controller](https://kegland.com.au/products/rapt-temperature-controller-standard-10amp-socket) |
| Glycol chillers | [Grainfather GC4](https://us.grainfather.com/products/gc4-glycol-chiller), [KegLand RAPT Glycol Chiller](https://kegland.com.au/products/rapt-bluetooth-glycol-chiller) |
| Gravity instruments | [Tilt hydrometer](https://tilthydrometer.com/), [KegLand RAPT Pill](https://kegland.com.au/products/yellow-rapt-pill-hydrometer-thermometer-wifi-bluetooth) |
| Anton Paar gravity and extract instruments | [EasyDens](https://www.anton-paar.com/ca-en/products/details/beer-hydrometer-easydens/), [DMA 35](https://www.anton-paar.com/us-en/products/details/dma-35/) |
| Anton Paar refractometer | [SmartRef](https://www.anton-paar.com/be-en/products/details/smartref/) |
| Anton Paar carbonation and oxygen instruments | [CarboQC](https://www.anton-paar.com/corp-en/products/details/carboqc/), [CboxQC](https://www.anton-paar.com/corp-en/products/details/cboxqc/), [OxyQC and OxyQC Wide Range](https://www.anton-paar.com/uk-en/products/details/o2-meter-oxyqc-oxyqc-wide-range/) |
| Other instruments | [ThermoWorks Thermapen ONE](https://www.thermoworks.com/products/thermapen-one), [Apera PH60](https://aperainst.de/produkt-kategorie/pocket-testers-products-en/60-series-premium/?lang=en), [Escali Primo](https://escali.com/) |

## Capability and media audit (October 2026)

The 69 seeded models were checked against their typed capability rows. All 47 branded
models have bundled product photos and thumbnails. The other 22 are generic equipment
choices, such as “Brew kettle” and “Hydrometer,” for which no product photo is claimed.
Older catalogs received only the first 18 photos because media was seeded in a prior
schema upgrade. Catalog version 20 adds the remaining bundled JPEG rows to existing
databases without replacing photos edited directly in the catalog. Clients clear their
weekly refresh timer on upgrade, so those rows arrive through incremental sync.

The following manufacturer specifications now fill previously empty fields:

| Models | Verified defaults | Source |
| --- | --- | --- |
| G30, G40, G70v2 | Maximum preboil fills of 30, 46, and 60 L; G40 US 230 V power of 3300 W | [Grainfather comparison](https://us.grainfather.com/pages/compare-the-grainfather-brewing-systems), [G40 US](https://us.grainfather.com/products/g40-brewing-system) |
| Braumeister PLUS 20/50 | Maximum fill marks of 25/55 L | [Speidel manual](https://www.speidels-braumeister.de/en/service/instruction-manuals/original-instruction-manual-speidels-braumeister-plus-10-20-50-100-litres.html) |
| BrewZilla 35/65, DigiBoil 65 | 2400/3500/3500 W | [KegLand 35 L](https://kegland.com.au/products/brewzilla-35l-gen-4), [65 L](https://kegland.com.au/products/brewzilla-65l-gen-4), [DigiBoil](https://kegland.com.au/products/65l-digiboil-digital-turbo-boiler-3500watt) |
| GC4, RAPT Glycol Chiller, RAPT Chamber | 196/400/300 W of heat removal; RAPT Chamber also has 50 W heating and −5 to 45 °C control | [Grainfather GC4](https://us.grainfather.com/products/gc4-glycol-chiller), [KegLand chiller](https://kegland.com.au/products/rapt-bluetooth-glycol-chiller), [KegLand chamber](https://kegland.com.au/products/rapt-temperature-controlled-fermentation-chamber) |
| ITC-308, RAPT Controller, VEVOR | Published temperature control ranges | [Inkbird](https://www.inkbird.com/collections/best-seller/products/temperature-controller-itc-308), [KegLand](https://kegland.com.au/products/rapt-temperature-controller-standard-10amp-socket), [VEVOR](https://eur.vevor.com/beer-brewing-system-c_11816/vevor-all-in-one-grain-brewing-system-home-beer-brewer-w-circulating-pump-30-l-p_010108577563) |
| Tilt, RAPT Pill, Apera PH60, Milwaukee MW102, DMA 35, Escali Primo, CboxQC | Documented measurement ranges and additional temperature channels where the device measures temperature | [Tilt](https://tilthydrometer.com/pages/faqs), [KegLand Pill](https://kegland.com.au/products/yellow-rapt-pill-hydrometer-thermometer-wifi-bluetooth), [Apera](https://aperainst.com/ph60-premium-waterproof-ph-tester-ph-meter-with-replaceable-probe-and-blacklight-apera-instruments), [Milwaukee](https://milwaukeeinstruments.com/milwaukee-MW102-pro-ph-meter-with-temperature-probe/), [Anton Paar DMA 35](https://www.anton-paar.com/uk-en/products/details/dma-35/), [Escali](https://kitchensupply.com/products/primo-digital-scale), [Anton Paar CboxQC](https://www.anton-paar.com/corp-en/products/details/cboxqc/) |

Empty fields remain where a published number does not describe the specific
capability or is ambiguous across variants. Examples: the G30 and Anvil Foundry
have voltage-dependent heating power; CarboQC and CboxQC carbonation ranges
depend on the instrument variant; and a glycol reservoir's volume is not a
fermenter's liquid capacity. Manufacturer sites often omit controller setpoint
limits for brewing systems, so reaching boiling temperature is not used as a
substitute for a documented controller range. Local equipment can override the
catalog defaults for its specific unit.

## FermZilla additions

Catalog version 23 adds the 60 L All Rounder, Gen3 Tri-Conical 27 L and 55 L,
and Flat Bottom 30 L alongside the existing 30 L All Rounder. KegLand's
[All Rounder instructions](https://docs.kegland.com.au/products/fermentation-equipment/fermzilla-all-rounder-30l-and-60l-or-user-guide/important-information-and-warnings)
specify a 2.5 bar limit for the 60 L vessel. The [27 L](https://kegland.com.au/products/27l-fermzilla-tri-conical-pressure-brewing-kit)
and [55 L](https://kegland.com.au/products/55l-fermzilla-tri-conical-pressure-brewing-kit-1)
Tri-Conical listings specify 2.4 bar. KegLand explicitly says the
[Flat Bottom](https://kegland.com.au/products/fermzilla-flat-bottom-with-tap-30l-fermenter-includes-volume-sticker-and-temperature-sticker)
is not pressure rated, so it has no pressure capability row. None of these
vessels has built-in temperature control. Their product photos and 128 px
thumbnails are bundled as JPEGs from the linked KegLand product pages for
offline catalog use.
