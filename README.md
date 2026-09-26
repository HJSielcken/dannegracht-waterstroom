# Dannegracht waterstroom

Browser-simulatie van de waterstroom in de **Dannegracht in Breukelen**, tussen de **Vecht** en het
**Amsterdam-Rijnkanaal (ARK)**.

- Schematische kaart met stromingspijlen en bewegende deeltjes
- Klik op een coördinaat op de kaart om daar live snelheid, richting en diepte te zien, en volg het punt desgewenst als meetpunt
- Meetpunten zijn genummerd; hetzelfde nummer staat op de kaart en bij de grafiek in het zijpaneel
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
- **Peilen.** Standaard staan Vecht en ARK beide op −0,40 m NAP (aanname). Live peilen vereisen
  `server/` met de meetlocaties van RWS en HDSR (zie [Docker](#docker)).
- **Plezierboten** in de gracht hebben meestal geen AIS; gebruik daarvoor de virtuele boten.
- **AIS-boten in het gesimuleerde water** volgen AIS niet meer: zodra een boot het rekengebied in
  vaart, vaart hij met de koers en snelheid van dat moment door op de simulatieklok, zodat
  verspringende AIS-posities geen valse golven maken. Een bocht die de boot daarna maakt, ziet het
  model dus niet. Verlaat hij het water, dan staat hij weer op zijn AIS-positie en telt hij niet meer
  mee. Dat overnemen gebeurt alleen bij een AIS-positie van hooguit 30 s oud; posities
  worden gedateerd met de AIS-tijdstempel, niet met het moment van ontvangst. De boot staat op het
  midden van de romp, niet op de GPS-antenne (die bij vrachtschepen vaak achterop staat).
- **Rivierstroming** is een typische waarde, geen meting. Het werkelijke debiet wisselt met inlaat en
  spuien; de Vecht kan bij Muiden zelfs tijdelijk terugstromen.
- **Wrijving.** Het model remt de stroming op twee manieren af: bodemwrijving (Manning, n = 0,03) en
  turbulente menging tussen naburige stroomlijnen (wervelviscositeit, 0,05 m²/s). Die menging stond
  eerst op 0,3 m²/s; op de trapjesranden van het rooster werkte dat als extra wandwrijving en kostte
  het ongeveer een kwart van de stroming, veel meer dan de bodemwrijving.
- **Snelheid in de gracht** blijft bij een peilverschil lager dan wat de Manning-formule geeft: de
  smalle, schuin liggende gracht krijgt op het rooster trapjesranden die extra weerstand geven.
- **Boten die verschijnen of optrekken.** Een boot die in het model verschijnt, verdringt zijn
  waterverplaatsing binnen 15 s en een boot die direct op snelheid is, geeft een aanloopgolf. Beide
  lopen als een golf van enkele centimeters voor de boot uit en komen bij een schip in het ARK vóór
  het schip zelf bij de Dannegracht aan. Kijk daarom naar het moment dat het schip de monding passeert.
- **Rivieren op peil houden** dempt ook de waterspiegeldaling van een schip in het ARK. Bij een
  binnenvaartschip dat de monding passeert, is de stroming in de gracht daardoor ongeveer een derde
  lager dan zonder die demping.
- Niet gemodelleerd: wind, korte scheepsgolven, schroefwater.
- **Verborgen tab.** Zolang de simulatie loopt, houdt de app het scherm aan (Screen Wake Lock,
  alleen via https of localhost). Bij minimaliseren of een andere tab stopt de browser de
  simulatie; op Android meteen. Bij terugkomen gaat hij verder waar hij was.

## Live AIS en waterstanden

De browser haalt AIS en waterstanden op bij `server/` (`/ais` en `/levels`), dat de site en beide
endpoints op hetzelfde adres serveert (Docker of `pnpm start`, zie [Docker](#docker)). `pnpm run dev`
start `server/` zelf op poort 8787 en stuurt `/ais` en `/levels` daarheen door; de variabelen komen
uit `.env` (zie `.env.example`). De versie op GitHub Pages heeft geen server en dus geen live gegevens.

Zonder meetpuntcodes (`RWS_ARK_LOCATION_CODE`, `HDSR_VECHT_TIMESERIES_UUID`) geeft `/levels` het
streefpeil terug, met als bron `ark-fallback+vecht-fallback`.

## Docker

Het image bevat één Node-proces (`server/`) dat de gebouwde site serveert en de endpoints `/levels`
en `/ais` levert op hetzelfde adres.

Draaien met Docker Compose (poort 8533): zet in `compose.yaml` je aisstream.io-sleutel en de
meetpuntcodes onder `environment` en start het image van Docker Hub:

```bash
docker compose pull && docker compose up -d
```

| Variabele                    | Betekenis                                                     |
| ---------------------------- | ------------------------------------------------------------- |
| `AISSTREAM_API_KEY`          | API-sleutel van [aisstream.io](https://aisstream.io) voor AIS |
| `RWS_ARK_LOCATION_CODE`      | Locatiecode van een ARK-meetpunt (waterinfo.rws.nl)           |
| `HDSR_VECHT_TIMESERIES_UUID` | Lizard-tijdreeks van een Vecht-meetpunt (hdsr.lizard.net)     |

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
