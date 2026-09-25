# Dannegracht waterstroom

Browser-simulatie van de waterstroom in de **Dannegracht in Breukelen**, tussen de **Vecht** en het
**Amsterdam-Rijnkanaal (ARK)**, met speciale aandacht voor het punt bij **Brugstraat 10e**.

- Schematische kaart met stromingspijlen en bewegende deeltjes
- Klik op het water (of zoek een adres) om op elk punt snelheid en richting te zien
- Waterstanden van de Vecht en het ARK instelbaar, of live op te halen
- Boten beïnvloeden de stroming: virtuele boten, en live AIS-schepen met geschatte massa en volume
- Schakelaar voor de historische schutsluis aan de Vecht-kant

## Starten

Vereist Node.js 24 (LTS); met [nvm](https://github.com/nvm-sh/nvm) volstaat `nvm use`.

```bash
npm ci
npm run dev
```

Open daarna de URL die Vite toont. Alles rekent in de browser; er is geen server nodig.

## Hoe het werkt

| Map          | Inhoud                                                                              |
| ------------ | ----------------------------------------------------------------------------------- |
| `src/geo`    | Geometrie: live uit OpenStreetMap (Overpass), met een ingebouwde schets als reserve |
| `src/sim`    | 2D-ondiepwatermodel in een Web Worker                                               |
| `src/boats`  | AIS-client, schatting van waterverplaatsing en massa, virtuele boten                |
| `src/levels` | Live waterstanden (via de proxy)                                                    |
| `src/ui`     | Kaartlaag met pijlen/deeltjes en het meetpuntenpaneel                               |
| `proxy`      | Cloudflare Worker voor AIS en waterstanden (optioneel)                              |

**Model.** Het water wordt gemodelleerd met de diepte-gemiddelde ondiepwatervergelijkingen op een
rooster van 3 m. De Vecht en het ARK worden op afstand van de gracht op hun ingestelde peil gehouden;
het peilverschil drijft de stroming door de Dannegracht. Boten zijn bewegende drukvelden ter grootte
van de romp. Die geven de bekende effecten: retourstroom langs de romp, waterspiegeldaling en opstuwing
voor de boeg.

**Boten.** AIS geeft positie, koers, snelheid, lengte, breedte en (soms) diepgang, maar geen massa.
Waterverplaatsing = L × B × T × blokcoëfficiënt (afhankelijk van scheepstype); massa = waterverplaatsing
× 1000 kg/m³.

## Beperkingen en aannames

Lees de uitkomsten als **indicatief**. De belangrijkste onzekerheden:

- **Geen metingen.** Er zijn geen stroomsnelheidsmetingen in de Dannegracht gebruikt om het model te
  kalibreren.
- **Diepte en breedte van de gracht** zijn geschat (10 m breed, 1,8 m diep); zie `src/geo/RESEARCH.md`.
- **De schutsluis** aan de Vecht-kant is een rijksmonument; of hij open of dicht staat is niet bekend.
  Bij een dichte sluis is er vrijwel geen doorstroming.
- **Peilen.** Standaard staan Vecht en ARK beide op −0,40 m NAP (aanname). Live peilen vereisen de
  proxy; de meetlocaties van RWS en HDSR moeten nog worden ingesteld in `proxy/wrangler.toml`.
- **Brugstraat 10e** wordt in de browser opgezocht via PDOK en naar het dichtstbijzijnde water verplaatst.
- **Plezierboten** in de gracht hebben meestal geen AIS; gebruik daarvoor de virtuele boten.
- Niet gemodelleerd: de eigen afvoer van de Vecht, wind, korte scheepsgolven, schroefwater.

## Live AIS en waterstanden

1. Zet de proxy op volgens [`proxy/README.md`](proxy/README.md) (gratis API-sleutel van aisstream.io).
2. Zet de proxy-URL in `.env` als `VITE_AIS_PROXY_URL` (zie `.env.example`), of als
   repository-variabele `VITE_AIS_PROXY_URL` voor de GitHub Pages-build.

## Ontwikkelen

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

Zie [`CONTRIBUTING.md`](CONTRIBUTING.md) voor de branch- en commitconventies.
