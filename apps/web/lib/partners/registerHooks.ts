import { onAccountCreated } from "@fx/core/src/auth/onAccountCreated";
import { partnerSignupHook } from "@fx/partners/signup";

// D#2607 X3.2: partner assignment on signup. Registered from here so packages/core does not depend on @fx/partners. The hook does
// nothing unless the signup carries a partner host and FX_PARTNER_LAYER is on. Idempotent: a reloaded module registers it once.
if (!onAccountCreated.includes(partnerSignupHook)) onAccountCreated.push(partnerSignupHook);
