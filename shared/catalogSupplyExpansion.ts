import type { CatalogInventory } from './catalog.ts';

// Product identity and ranges are manufacturer level, never a substitute for
// a lot analysis. Leave variable hop alpha and yeast attenuation unset.
const briess = 'https://brewingwithbriess.com/products/';
const briessPdf = 'https://brewingwithbriess.com/wp-content/uploads/documents/Briess-PISB-';
const weyermann = 'https://www.weyermann.de/en-gb/products/brewing-malting/';
const ych = 'https://www.yakimachief.com/varieties';
const fermentis = 'https://fermentis.com/en/products/';
const briessSheets: Record<string, string> = {
  brewers_2_row: 'Brewers-Malt', pale_ale: 'Pale-Ale-Malt', pilsen: 'Pilsen-Malt-1',
  bonlander_munich_10: 'Bonlander-Munich-Malt-10L', aromatic_munich_20: 'Aromatic-Munich-Malt-20L',
  vienna: 'Goldpils-Vienna-Malt', white_wheat: 'Wheat-Malt-White', caramel_20: 'Caramel-Malt-20L',
  caramel_40: 'Caramel-Malt-40L', caramel_60: 'Caramel-Malt-60L',
  caramel_80: 'Caramel-Malt-80L', caramel_120: 'Caramel-Malt-120L',
  carapils: 'Carapils-Malt', chocolate: 'Chocolate-Malt', black: 'Black-Malt',
  roasted_barley: 'Roasted-Barley', flaked_oats: 'Brewers-Oat-Flakes'
};

type Product = CatalogInventory & { manufacturer: string; product_url: string };
const grain = (id: string, name: string, manufacturer: string, grainClass: string,
  productUrl: string, color?: number, yieldPct?: number): Product => ({
  id: `supply_${id}`, name: `${manufacturer} ${name}`, category: 'Grain', unit: 'g', manufacturer,
  grain_class: grainClass,
  product_url: manufacturer === 'Briess' ? `${briessPdf}${briessSheets[id.replace('briess_', '')]}.pdf` : productUrl,
  color_lovibond: color ?? null, yield_pct: yieldPct ?? null
});
const hops = (id: string, name: string, manufacturer: string, productUrl: string): Product => ({
  id: `supply_${id}`, name: `${manufacturer} ${name}`, category: 'Hops', unit: 'g', manufacturer,
  product_url: productUrl
});
const yeast = (id: string, name: string, manufacturer: string, productUrl: string): Product => ({
  id: `supply_${id}`, name: `${manufacturer} ${name}`, category: 'Yeast', unit: 'packet', manufacturer,
  product_url: productUrl
});
const nutrient = (id: string, name: string, productUrl: string): Product => ({
  id: `supply_${id}`, name, category: 'Nutrient', unit: 'g', manufacturer: 'Lallemand',
  product_url: productUrl
});

export const catalogSupplyManufacturers = [
  { name: 'Briess', website_url: 'https://brewingwithbriess.com/' },
  { name: 'Weyermann', website_url: 'https://www.weyermann.de/en-gb/' },
  { name: 'Crisp Malt', website_url: 'https://crispmalt.com/' },
  { name: 'Simpsons Malt', website_url: 'https://www.simpsonsmalt.co.uk/' },
  { name: 'Yakima Chief Hops', website_url: 'https://www.yakimachief.com/' },
  { name: 'Fermentis', website_url: 'https://fermentis.com/' },
  { name: 'Lallemand Brewing', website_url: 'https://www.lallemandbrewing.com/' },
  { name: 'Lallemand', website_url: 'https://www.lallemandwine.com/' }
];

export const expandedCatalogSupplies: Product[] = [
  grain('briess_brewers_2_row', 'Brewers Malt', 'Briess', 'base', briess, 2.1, 81),
  grain('briess_pale_ale', 'Pale Ale Malt', 'Briess', 'base', briess, 3.5, 80),
  grain('briess_pilsen', 'Pilsen Malt', 'Briess', 'base', briess, 1.5, 81),
  grain('briess_bonlander_munich_10', 'Bonlander Munich Malt 10L', 'Briess', 'kilned', briess, 10, 78),
  grain('briess_aromatic_munich_20', 'Aromatic Munich Malt 20L', 'Briess', 'kilned', briess, 20, 79),
  grain('briess_vienna', 'Goldpils Vienna Malt', 'Briess', 'kilned', briess, 3.5, 80),
  grain('briess_white_wheat', 'White Wheat Malt', 'Briess', 'base', briess, 2.8, 83),
  grain('briess_caramel_20', 'Caramel Malt 20L', 'Briess', 'caramel', briess, 20, 76),
  grain('briess_caramel_40', 'Caramel Malt 40L', 'Briess', 'caramel', briess, 40, 77),
  grain('briess_caramel_60', 'Caramel Malt 60L', 'Briess', 'caramel', briess, 60, 77),
  grain('briess_caramel_80', 'Caramel Malt 80L', 'Briess', 'caramel', briess, 80, 76),
  grain('briess_caramel_120', 'Caramel Malt 120L', 'Briess', 'caramel', briess, 120, 75),
  grain('briess_carapils', 'Carapils Malt', 'Briess', 'base', briess, 1.5, 75),
  grain('briess_chocolate', 'Chocolate Malt', 'Briess', 'roasted', briess, 350),
  grain('briess_black', 'Black Malt', 'Briess', 'roasted', briess, 500),
  grain('briess_roasted_barley', 'Roasted Barley', 'Briess', 'roasted', briess, 300),
  grain('briess_flaked_oats', 'Brewers Oat Flakes', 'Briess', 'flaked', briess, 2.5, 70),
  grain('weyermann_pilsner', 'Pilsner Malt', 'Weyermann', 'base',
    'https://www.weyermann.de/en-gb/product/weyermann-pilsner-malt/', 1.8),
  grain('weyermann_munich_type_1', 'Munich Malt Type 1', 'Weyermann', 'kilned', weyermann),
  grain('weyermann_munich_type_2', 'Munich Malt Type 2', 'Weyermann', 'kilned',
    'https://www.weyermann.de/en-gb/product/weyermann-munich-malt-type-2/', 9),
  grain('weyermann_vienna', 'Vienna Malt', 'Weyermann', 'kilned', weyermann),
  grain('weyermann_wheat', 'Pale Wheat Malt', 'Weyermann', 'base', weyermann),
  grain('weyermann_carapils', 'CARAPILS Malt', 'Weyermann', 'base', weyermann),
  grain('weyermann_carahell', 'CARAHELL Malt', 'Weyermann', 'caramel', weyermann),
  grain('weyermann_caramunich_1', 'CARAMUNICH Type 1', 'Weyermann', 'caramel', weyermann),
  grain('weyermann_caramunich_2', 'CARAMUNICH Type 2', 'Weyermann', 'caramel', weyermann),
  grain('weyermann_carafa_2', 'CARAFA Type 2', 'Weyermann', 'roasted', weyermann),
  grain('weyermann_melanoidin', 'Melanoidin Malt', 'Weyermann', 'kilned', weyermann),
  grain('crisp_maris_otter', 'Finest Maris Otter Ale Malt', 'Crisp Malt', 'base',
    'https://crispmalt.com/malts/finest-maris-otter-ale-malt/', undefined, 80.6),
  grain('crisp_best_ale', 'Best Ale Malt', 'Crisp Malt', 'base',
    'https://crispmalt.com/malts/best-ale-malt/', undefined, 80.8),
  grain('simpsons_maris_otter', 'Finest Pale Ale Maris Otter', 'Simpsons Malt', 'base',
    'https://www.simpsonsmalt.co.uk/our-malts/base-malts/finest-pale-ale-maris-otter/', undefined, 81),
  grain('simpsons_golden_promise', 'Finest Pale Ale Golden Promise', 'Simpsons Malt', 'base',
    'https://www.simpsonsmalt.co.uk/our-malts/base-malts/finest-pale-ale-golden-promise/', undefined, 81),
  hops('ych_cascade', 'Cascade', 'Yakima Chief Hops', 'https://www.yakimachief.com/variety/cascade'),
  hops('ych_centennial', 'Centennial', 'Yakima Chief Hops', 'https://www.yakimachief.com/variety/centennial'),
  hops('ych_citra', 'Citra Brand', 'Yakima Chief Hops', 'https://www.yakimachief.com/variety/citra-brand'),
  hops('ych_mosaic', 'Mosaic Brand', 'Yakima Chief Hops', 'https://www.yakimachief.com/variety/mosaic-brand'),
  hops('ych_simcoe', 'Simcoe Brand', 'Yakima Chief Hops', 'https://www.yakimachief.com/variety/simcoe-brand'),
  hops('ych_amarillo', 'Amarillo Brand', 'Yakima Chief Hops', 'https://www.yakimachief.com/variety/amarillo-brand'),
  hops('ych_chinook', 'Chinook', 'Yakima Chief Hops', 'https://www.yakimachief.com/variety/chinook'),
  hops('ych_saaz', 'Saaz', 'Yakima Chief Hops', ych),
  yeast('fermentis_us05', 'SafAle US-05', 'Fermentis', 'https://fermentis.com/en/product/safale-us-05/'),
  yeast('fermentis_s04', 'SafAle S-04', 'Fermentis', 'https://fermentis.com/en/product/safale-s-04/'),
  yeast('fermentis_w3470', 'SafLager W-34/70', 'Fermentis', 'https://fermentis.com/en/product/saflager-w-34-70/'),
  yeast('fermentis_k97', 'SafAle K-97', 'Fermentis', fermentis),
  yeast('lallemand_nottingham', 'LalBrew Nottingham', 'Lallemand Brewing',
    'https://www.lallemandbrewing.com/en/united-states/products/nottingham-high-performance-ale-yeast/'),
  yeast('lallemand_verdant', 'LalBrew Verdant IPA', 'Lallemand Brewing',
    'https://www.lallemandbrewing.com/en/united-states/products/lalbrew-verdant-ipa/'),
  yeast('lallemand_new_england', 'LalBrew New England', 'Lallemand Brewing',
    'https://www.lallemandbrewing.com/en/canada/products/lalbrew-new-england/'),
  yeast('lallemand_diamond', 'LalBrew Diamond Lager', 'Lallemand Brewing',
    'https://www.lallemandbrewing.com/en/united-states/products/diamond-lager-yeast/'),
  nutrient('fermaid_o', 'Lallemand Fermaid O',
    'https://scottlab.com/fermaid-o-yeast-fermentation-nutrient-2-5kg-15067'),
  nutrient('fermaid_k', 'Lallemand Fermaid K',
    'https://scottlab.com/fermaid-k-yeast-fermentation-nutrient-2-5kg-15073'),
  nutrient('fermaid_a', 'Lallemand Fermaid A',
    'https://scottlab.com/fermaid-a-yeast-fermentation-nutrient-10-kg-15070a'),
  nutrient('fermaid_performens_m', 'Lallemand Fermaid Performens M',
    'https://scottlab.com/fermaid-performens-m-yeast-fermentation-nutrient-2-15087')
];

// Historic generic rows keep their stable IDs and become usable with app class defaults.
export const retiredGenericSupplies = new Set([
  'inventory_maris_otter', 'inventory_pilsner_malt', 'inventory_two_row',
  'inventory_wheat_malt', 'inventory_munich_malt', 'inventory_crystal_60', 'inventory_roasted_barley',
  'inventory_cascade_hops', 'inventory_citra_hops', 'inventory_centennial',
  'inventory_saaz', 'inventory_mosaic', 'inventory_us05', 'inventory_s04', 'inventory_w34_70'
]);
