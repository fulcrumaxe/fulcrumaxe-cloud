/** The layer-wide kill switch. Only the exact value `on` turns the partner layer on; unset, `off` and anything else is off. */
export const PARTNER_LAYER_ENV = "FX_PARTNER_LAYER";

export type PartnerEnv = Readonly<Record<string, string | undefined>>;

export function partnerLayerOn(env: PartnerEnv): boolean {
  return env[PARTNER_LAYER_ENV] === "on";
}
