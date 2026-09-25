export interface Env {
  ALLOWED_ORIGIN: string;
  AIS_BBOX_SOUTH: string;
  AIS_BBOX_WEST: string;
  AIS_BBOX_NORTH: string;
  AIS_BBOX_EAST: string;
  RWS_ARK_LOCATION_CODE: string;
  HDSR_VECHT_TIMESERIES_UUID: string;
  /** Secret — set with `wrangler secret put AISSTREAM_API_KEY`. */
  AISSTREAM_API_KEY: string;
}
