// aisstream.io subscription message, shared by the Cloudflare Worker
// (proxy/src/ais.ts) and the self-hosted Node server (server/ais.ts).
import type { Env } from './env';

export const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';

const RELEVANT_MESSAGE_TYPES = [
  'PositionReport',
  'ShipStaticData',
  'StandardClassBPositionReport',
  'StaticDataReport',
];

type BboxEnv = Pick<
  Env,
  'AISSTREAM_API_KEY' | 'AIS_BBOX_SOUTH' | 'AIS_BBOX_WEST' | 'AIS_BBOX_NORTH' | 'AIS_BBOX_EAST'
>;

/** The JSON message to send within 3 seconds of opening the upstream socket. */
export function subscriptionMessage(env: BboxEnv): string {
  const bbox: [[number, number], [number, number]] = [
    [Number(env.AIS_BBOX_SOUTH), Number(env.AIS_BBOX_WEST)],
    [Number(env.AIS_BBOX_NORTH), Number(env.AIS_BBOX_EAST)],
  ];
  return JSON.stringify({
    APIKey: env.AISSTREAM_API_KEY,
    BoundingBoxes: [bbox],
    FilterMessageTypes: RELEVANT_MESSAGE_TYPES,
  });
}
