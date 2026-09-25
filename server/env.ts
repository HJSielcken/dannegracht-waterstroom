export interface Env {
  AIS_BBOX_SOUTH: string;
  AIS_BBOX_WEST: string;
  AIS_BBOX_NORTH: string;
  AIS_BBOX_EAST: string;
  RWS_ARK_LOCATION_CODE: string;
  HDSR_VECHT_TIMESERIES_UUID: string;
  /** Secret; never sent to the browser. */
  AISSTREAM_API_KEY: string;
}
