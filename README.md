# Dannegracht waterstroom

Browser-simulatie van de waterstroom in de **Dannegracht in Breukelen**, tussen de **Vecht** en het
**Amsterdam-Rijnkanaal (ARK)**, met speciale aandacht voor het punt bij **Brugstraat 10e**.

- Schematische kaart met stromingspijlen en bewegende deeltjes
- Klik op het water (of zoek een adres) om op elk punt snelheid en richting te zien
- Waterstanden van de Vecht en het ARK instelbaar, of live op te halen
- Boten beïnvloeden de stroming: virtuele boten, en live AIS-schepen met geschatte massa en volume
- Schakelaar voor de historische schutsluis aan de Vecht-kant

## Starten

Vereist Node.js 26 (met [nvm](https://github.com/nvm-sh/nvm) volstaat `nvm use`) en
[pnpm](https://pnpm.io/installation) (`npm install -g pnpm`; de versie staat in `packageManager`).

```bash
pnpm install
pnpm run dev
```

Open daarna de URL die Vite toont. Alles rekent in de browser; er is geen server nodig.

## Hoe het werkt

| Map          | Inhoud                                                                              |
| ------------ | ----------------------------------------------------------------------------------- |
| `src/geo`    | Geometrie: live uit OpenStreetMap (Overpass), met een ingebouwde schets als reserve |
| `src/sim`    | 2D-ondiepwatermodel in een Web Worker                                               |
| `src/boats`  | AIS-client, schatting van waterverplaatsing en massa, virtuele boten                |
| `src/levels` | Live waterstanden (via `server/`)                                                   |
| `src/ui`     | Kaartlaag met pijlen/deeltjes en het meetpuntenpaneel                               |
| `server`     | Node-server: serveert de app plus `/levels` en `/ais`                               |

**Model.** Het water wordt gemodelleerd met de diepte-gemiddelde ondiepwatervergelijkingen op een
rooster van 3 m. De Vecht en het ARK worden op afstand van de gracht op hun ingestelde peil gehouden;
het peilverschil drijft de stroming door de Dannegracht. Beide rivieren hebben daarnaast een eigen
stroming naar het noorden (instelbaar): standaard **Vecht 5 cm/s** (ca. 4 m³/s, het streefdebiet via
de Weerdsluis in Utrecht) en **ARK 2 cm/s** (ca. 13 m³/s, de gemiddelde inlaat bij Wijk bij Duurstede
en Vreeswijk). De stroming volgt de bochten van de rivier (potentiaalstroming) en komt binnen via
open randen aan de uiteinden. Boten zijn bewegende drukvelden ter grootte
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
- **Peilen.** Zonder live gegevens staan Vecht en ARK beide op −0,40 m NAP (aanname). Live peilen
  vereisen `server/` (zie [Docker](#docker)). Het dichtstbijzijnde Vecht-meetpunt van HDSR ligt bij
  de Daalseweg in Oud-Zuilen, zo'n 9 km stroomopwaarts; het ARK-meetpunt van RWS ligt bij Maarssen.
- **Brugstraat 10e** wordt in de browser opgezocht via PDOK en naar het dichtstbijzijnde water verplaatst.
- **Plezierboten** in de gracht hebben meestal geen AIS; gebruik daarvoor de virtuele boten.
- **Rivierstroming** is een typische waarde, geen meting. Het werkelijke debiet wisselt met inlaat en
  spuien; de Vecht kan bij Muiden zelfs tijdelijk terugstromen.
- **Snelheid in de gracht** is bij een peilverschil ongeveer de helft van wat de Manning-formule geeft:
  de smalle, schuin liggende gracht krijgt op het rooster trapjesranden die extra weerstand geven.
- **Boten die verschijnen of optrekken.** Een boot die in het model verschijnt, verdringt zijn
  waterverplaatsing binnen 15 s en een boot die direct op snelheid is, geeft een aanloopgolf. Beide
  lopen als een golf van enkele centimeters voor de boot uit en komen bij een schip in het ARK vóór
  het schip zelf bij de Dannegracht aan. Kijk daarom naar het moment dat het schip de monding passeert.
- **Rivieren op peil houden** dempt ook de waterspiegeldaling van een schip in het ARK. Bij een
  binnenvaartschip dat de monding passeert, is de stroming in de gracht daardoor ongeveer een derde
  lager dan zonder die demping.
- Niet gemodelleerd: wind, korte scheepsgolven, schroefwater.

## Live AIS en waterstanden

De browser haalt AIS en waterstanden op bij `server/` (`/ais` en `/levels`), dat de site en beide
endpoints op hetzelfde adres serveert (Docker of `pnpm start`, zie [Docker](#docker)). `pnpm run dev`
start `server/` zelf op poort 8787 en stuurt `/ais` en `/levels` daarheen door. Zet in `.env`
`VITE_AIS_PROXY_URL=/ais` en de variabelen uit de tabel onder [Docker](#docker). De versie op GitHub
Pages heeft geen server en dus geen live gegevens.

Standaard gebruikt `/levels` het RWS-meetpunt `maarssen.kanaal` voor het ARK en de HDSR-tijdreeks
van de Vecht bij de Daalseweg (Oud-Zuilen); met `RWS_ARK_LOCATION_CODE` en `HDSR_VECHT_TIMESERIES_UUID`
kies je andere meetpunten. Is een meetpunt niet bereikbaar, dan geeft `/levels` voor die kant het
streefpeil terug (bron `ark-fallback` of `vecht-fallback`).

## Docker

Het image bevat één Node-proces (`server/`) dat de gebouwde site serveert en de endpoints `/levels`
en `/ais` levert op hetzelfde adres.

Draaien met Docker Compose (poort 8533): zet in `compose.yaml` je aisstream.io-sleutel (en
eventueel andere meetpuntcodes) onder `environment` en start het image van Docker Hub:

```bash
docker compose pull && docker compose up -d
```

| Variabele                    | Betekenis                                                            |
| ---------------------------- | -------------------------------------------------------------------- |
| `AISSTREAM_API_KEY`          | API-sleutel van [aisstream.io](https://aisstream.io) voor AIS        |
| `RWS_ARK_LOCATION_CODE`      | ARK-meetpunt (waterinfo.rws.nl), standaard `maarssen.kanaal`         |
| `HDSR_VECHT_TIMESERIES_UUID` | Lizard-tijdreeks van de Vecht (hdsr.lizard.net), standaard Daalseweg |

Zet je ingevulde `compose.yaml` niet terug in git; de sleutel is geheim. Een image lokaal bouwen kan
met `docker build -t pofsok/dannegracht-waterstroom .`.

Zonder Docker: `pnpm run build && pnpm start` (poort 8080, zelfde variabelen), met
`VITE_AIS_PROXY_URL=/ais` tijdens de build.

De GitHub Actions-workflow `.github/workflows/docker.yml` bouwt bij elke push naar `main` (en bij
tags `v*`) een image voor `linux/amd64` en `linux/arm64` en zet het op Docker Hub; bij pull requests
wordt het image alleen gebouwd. Stel daarvoor in de repository-instellingen in:

- secret `DOCKERHUB_USERNAME` – je Docker Hub-gebruikersnaam
- secret `DOCKERHUB_TOKEN` – een Docker Hub access token (Account settings → Personal access tokens)
- optioneel variabele `DOCKER_IMAGE` – imagenaam, standaard `<gebruikersnaam>/dannegracht-waterstroom`

## Ontwikkelen

```bash
pnpm run lint && pnpm run typecheck && pnpm test && pnpm run build
```

Zie [`CONTRIBUTING.md`](CONTRIBUTING.md) voor de branch- en commitconventies.
