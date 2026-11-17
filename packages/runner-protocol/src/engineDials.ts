/**
 * The dial snapshot a runner asks the cloud for, per repo: `GET /api/runner/engine/dials?repo_gh_id=N`, signed like every runner request. It carries what the
 * repo's decisions resolve to now, plus the halt state, so the runner can write the ceiling file the engine reads. Every field is a fact the cloud holds; the
 * runner derives the ceilings from `dispositions` and nothing else.
 */
import { z } from "zod";
import { ENGINE_DECISION_TYPES } from "./engineCommands.js";

/** The query the runner sends. Its canonical spelling is the one the signature covers. */
export const ENGINE_DIALS_PATH = "/api/runner/engine/dials";
export const engineDialsTarget = (repoGhId: number): string => `${ENGINE_DIALS_PATH}?repo_gh_id=${repoGhId}`;

const DISPOSITION = z.enum(["act", "announce", "ask"]);
/** A UTC time with every part in its range (month 01-12, day 01-31, hour 00-23, minute and second 00-59), so `Date.parse` never answers NaN for a string this accepts. */
const ISO_UTC = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?Z$/;

export const EngineDialsReply = z
  .object({
    repo_gh_id: z.number().int().min(1).safe(),
    catalogue_version: z.number().int().min(1).safe(),
    dispositions: z.object(Object.fromEntries(ENGINE_DECISION_TYPES.map((type) => [type, DISPOSITION])) as Record<(typeof ENGINE_DECISION_TYPES)[number], typeof DISPOSITION>).strict(),
    halt_epoch: z.number().int().min(0).safe(),
    halted: z.boolean(),
    fetched_at: z.string().regex(ISO_UTC),
  })
  .strict();
export type EngineDialsReply = z.infer<typeof EngineDialsReply>;
