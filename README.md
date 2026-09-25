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
| `server`     | Node-server voor Docker: serveert de app plus `/levels` en `/ais`                   |

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
- **Peilen.** Standaard staan Vecht en ARK beide op −0,40 m NAP (aanname). Live peilen vereisen de
  proxy; de meetlocaties van RWS en HDSR moeten nog worden ingesteld in `proxy/wrangler.toml`.
- **Brugstraat 10e** wordt in de browser opgezocht via PDOK en naar het dichtstbijzijnde water verplaatst.
- **Plezierboten** in de gracht hebben meestal geen AIS; gebruik daarvoor de virtuele boten.
- **Rivierstroming** is een typische waarde, geen meting. Het werkelijke debiet wisselt met inlaat en
  spuien; de Vecht kan bij Muiden zelfs tijdelijk terugstromen.
- **Snelheid in de gracht** is bij een peilverschil ongeveer de helft van wat de Manning-formule geeft:
  de smalle, schuin liggende gracht krijgt op het rooster trapjesranden die extra weerstand geven.
- Niet gemodelleerd: wind, korte scheepsgolven, schroefwater.

## Live AIS en waterstanden

De browser haalt AIS en waterstanden via een proxy op (`/ais` en `/levels`). Die kan op twee manieren
draaien:

- **Samen met de app** (Docker, `npm start`): `server/` serveert de site én de proxy op hetzelfde
  adres. Zie [Docker](#docker).
- **Los als Cloudflare Worker** (voor GitHub Pages): zet de proxy op volgens
  [`proxy/README.md`](proxy/README.md) en zet de proxy-URL in `.env` als `VITE_AIS_PROXY_URL` (zie
  `.env.example`), of als repository-variabele `VITE_AIS_PROXY_URL` voor de GitHub Pages-build.

Zonder meetpuntcodes (`RWS_ARK_LOCATION_CODE`, `HDSR_VECHT_TIMESERIES_UUID`) geeft `/levels` het
streefpeil terug, met als bron `ark-fallback+vecht-fallback`.

## Docker

Het image bevat één Node-proces (`server/`) dat de gebouwde site serveert en de proxy-endpoints
`/levels` en `/ais` levert op hetzelfde adres; een aparte proxy of CORS-instelling is niet nodig.

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
met `docker build -t hjsielcken/dannegracht-waterstroom .`.

Zonder Docker: `npm run build && npm start` (poort 8080, zelfde variabelen), met
`VITE_AIS_PROXY_URL=/ais` tijdens de build.

De GitHub Actions-workflow `.github/workflows/docker.yml` bouwt bij elke push naar `main` (en bij
tags `v*`) een image voor `linux/amd64` en `linux/arm64` en zet het op Docker Hub; bij pull requests
wordt het image alleen gebouwd. Stel daarvoor in de repository-instellingen in:

- secret `DOCKERHUB_USERNAME` – je Docker Hub-gebruikersnaam
- secret `DOCKERHUB_TOKEN` – een Docker Hub access token (Account settings → Personal access tokens)
- optioneel variabele `DOCKER_IMAGE` – imagenaam, standaard `<gebruikersnaam>/dannegracht-waterstroom`

## Ontwikkelen

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

Zie [`CONTRIBUTING.md`](CONTRIBUTING.md) voor de branch- en commitconventies.
