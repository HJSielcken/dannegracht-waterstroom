# Dannegracht AIS/waterstanden-proxy

Kleine Cloudflare Worker die twee dingen doet voor de browser-app
(`dannegracht-waterstroom`):

1. **`/ais`** — een WebSocket-relay naar [aisstream.io](https://aisstream.io).
   aisstream.io staat geen directe verbindingen vanuit de browser toe (zie
   hun documentatie: de API-key moet server-side blijven en CORS blokkeert
   browser-verbindingen), dus deze Worker houdt de API-key als secret vast,
   legt zelf de verbinding met aisstream.io, abonneert op een bounding box
   rond Breukelen, en stuurt de ruwe JSON-berichten (`PositionReport`,
   `ShipStaticData`, `StandardClassBPositionReport`, `StaticDataReport`)
   ongewijzigd door naar de browser.
2. **`/levels`** — een gewone GET die actuele waterstanden ophaalt bij
   Rijkswaterstaat (ARK) en HDSR (Vecht) en teruggeeft als JSON, met
   CORS-headers voor de geconfigureerde origin. Browsers kunnen deze
   bronnen doorgaans niet direct bevragen (geen/beperkte CORS-headers),
   vandaar de proxy.

De app zelf leest de proxy-URL uit `VITE_AIS_PROXY_URL` (zie
`src/boats/ais.ts` en `src/levels/levels.ts`).

## Vereisten

- Een (gratis) [Cloudflare](https://dash.cloudflare.com/sign-up)-account.
- Een API-key van [aisstream.io](https://aisstream.io) (gratis account,
  key aanmaken onder "Account").
- Node.js (voor `npx wrangler`).

## Installeren

```bash
cd proxy
npm install
```

## Lokaal draaien

```bash
npm run dev
```

Wrangler start een lokale dev-server (standaard op `http://localhost:8787`).
Voor lokale AIS/websocket-tests heb je nog steeds een geldige
`AISSTREAM_API_KEY` nodig (zie hieronder); zonder key geeft `/ais` een
503 terug.

## Secrets instellen

De AISStream API-key wordt **nooit** in `wrangler.toml` of in git gezet,
maar als Cloudflare-secret:

```bash
npx wrangler secret put AISSTREAM_API_KEY
# plak hier je aisstream.io API-key en druk op Enter
```

## Configuratie (`wrangler.toml`)

Pas de `[vars]`-sectie in `wrangler.toml` aan:

- `ALLOWED_ORIGIN` — de origin van je gedeployde app (bijv.
  `https://<gebruiker>.github.io`), zodat alleen die site de proxy mag
  aanroepen. Gebruik `"*"` alleen tijdens lokaal ontwikkelen.
- `AIS_BBOX_SOUTH` / `AIS_BBOX_WEST` / `AIS_BBOX_NORTH` / `AIS_BBOX_EAST` —
  de bounding box waarbinnen scheepvaart wordt gevolgd. Standaard rond de
  Vecht/ARK bij Breukelen; vergroot deze als je ook scheepvaart verderop
  wilt zien aankomen.
- `RWS_ARK_LOCATION_CODE` — de Rijkswaterstaat Waterwebservices-locatiecode
  (nieuw formaat, kleine letters) voor een meetpunt op het
  Amsterdam-Rijnkanaal bij Maarssen/Breukelen. Staat standaard **leeg**: de
  code kon niet worden opgezocht vanuit de omgeving waarin deze proxy is
  geschreven. Zoek hem op via [waterinfo.rws.nl](https://waterinfo.rws.nl)
  (klik het meetpunt aan en lees de locatiecode af). Zolang hij leeg is,
  gebruikt `/levels` voor het ARK het streefpeil (NAP −0,40 m).
- `HDSR_VECHT_TIMESERIES_UUID` — het Lizard-tijdreeks-UUID voor een
  Vecht-peilmeting bij Breukelen. **Ook niet geverifieerd** — vraag dit op
  via de HDSR Open Water Data API-handleiding of de Lizard-portal
  (https://hdsr.lizard.net) en vul het hier in. Leeg laten betekent dat
  `/levels` voor de Vecht altijd op de fallback-waarde terugvalt.

Als een van beide bronnen niet bereikbaar is of niet is geconfigureerd,
valt `/levels` voor die grens terug op een vaste standaardwaarde
(zie `src/levels.ts`, `FALLBACK_LEVELS`) zodat de simulatie altijd een
bruikbare waterstand heeft.

## Deployen

```bash
npx wrangler deploy
```

Wrangler print de URL van je Worker, bijvoorbeeld
`https://dannegracht-ais-proxy.<jouw-subdomain>.workers.dev`. Zet die in de
app's build-omgeving als:

```
VITE_AIS_PROXY_URL=wss://dannegracht-ais-proxy.<jouw-subdomain>.workers.dev/ais
```

(`src/levels/levels.ts` leidt de `/levels`-basis-URL automatisch af door
`wss:`/`ws:` te vervangen door `https:`/`http:` en het `/ais`-pad te
strippen — je hoeft dus geen aparte env var voor `/levels` te zetten.)

## RWS Waterwebservices

De klassieke DDL-service is eind april 2026 gestopt. De proxy gebruikt de opvolger
(`ddapi20-waterwebservices.rijkswaterstaat.nl`, zelfde `OphalenLaatsteWaarnemingen`-contract).
Die gebruikt nieuwe locatiecodes in kleine letters (bijv. `ameland.nes`); zoek de code van het
ARK-meetpunt bij Maarssen op via [waterinfo.rws.nl](https://waterinfo.rws.nl) en vul hem in als
`RWS_ARK_LOCATION_CODE`. Zie
[rijkswaterstaatdata.nl](https://rijkswaterstaatdata.nl/projecten/waterwebservices-overschakeling/).
