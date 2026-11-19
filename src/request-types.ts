import requestTypes from "./data/primal-request-types.json";

const noParams = requestTypes.noParams;
const withParams = requestTypes.withParams;

export const NO_PARAMS_TYPES: ReadonlySet<string> = new Set(noParams);
const VALID = new Set<string>([...noParams, ...withParams]);

export const REQUEST_TYPE_COUNT = VALID.size;

export function isRequestType(value: string): boolean {
  return VALID.has(value);
}
