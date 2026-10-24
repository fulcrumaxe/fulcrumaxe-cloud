// The ownership rule lives in @fx/core (next to withPlatformOps) so the api package can use it without a dependency on this one; re-exported here for the callers that import it from @fx/github.
export { createTeamInstallationOwnership, type TeamInstallationOwnership } from "@fx/core/src/tenancy/installationOwnership.js";
