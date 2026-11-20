/**
 * `fx-runner setup --cloud-url https://...` (D#845 ON-3): the one command that takes a machine from nothing to a running runner.
 *
 * It refuses at once, sending nothing, when this machine already holds a registration. Otherwise: run the doctor checks and print every failed or warned one with its
 * fix (never blocking: a machine with no KVM registers on the standard tier), start the device flow (deviceRegister.ts), install the per-user service and start it.
 * When the checks show a machine with `/dev/kvm` and no VM helper, it ends with the one next step, `sudo fx-runner vm install`.
 */
import { CliError } from "../cliError.js";
import { normaliseOrigin } from "../cloud.js";
import { loadRegistration, withRegisterLock } from "../config.js";
import type { CommandContext, Flags } from "../context.js";
import { deviceRegister } from "../deviceRegister.js";
import { existingRegistrationError } from "../registration.js";
import type { VmInstallFacts } from "../vm/doctorChecks.js";
import { doctorCommand, type DoctorHost } from "./doctor.js";
import { serviceCommand, userServiceStartArgv, type ServiceHost } from "./service.js";

/** The machine side of `setup`, filled in only by `bin/fx-runner.mjs`. */
export interface SetupHost {
  doctor: DoctorHost;
  service: ServiceHost;
  /** Runs one fixed program with fixed arguments (no shell) and returns its exit code; -1 when it could not be started. */
  run: (argv: readonly string[]) => Promise<number>;
}

export const VM_INSTALL_NEXT = "Next: sudo fx-runner vm install";

/** What `doctor` printed, cut to the failed and warned checks with their fix lines. The registration check is left out: setup is about to make it. */
export function problemLines(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let keep = false;
  for (const line of lines) {
    if (/^(FAIL|WARN)\s/.test(line)) keep = !/^\w+\s+Registration:/.test(line);
    else if (!/^\s/.test(line) && line !== "") keep = false;
    if (keep) kept.push(line);
  }
  return kept;
}

/** The doctor's finding "a microVM could run here, but its helper is not installed": `/dev/kvm` is there and nothing of the install is. */
export function microvmHelperMissing(facts: VmInstallFacts | undefined): boolean {
  return facts !== undefined && facts.kvm === "present" && facts.unit === "absent" && facts.binary.state === "absent";
}

export async function setupCommand(flags: Flags, ctx: CommandContext, host: SetupHost): Promise<number> {
  const raw = flags.get("cloud-url");
  if (typeof raw !== "string" || raw === "") throw new CliError("--cloud-url is required", 2);
  const origin = normaliseOrigin(raw);
  const held = loadRegistration(ctx.stateDir);
  if (held) throw existingRegistrationError(held);
  // Before the checks, which write into the state directory: one that is a link, not a directory or locked by another run is refused now, with nothing written through it.
  await withRegisterLock(ctx.stateDir, ctx.now, async () => undefined);

  // The machine is read once: the same facts feed the checks, the approval page and the closing hint.
  const vm = host.doctor.vmInstall === undefined ? undefined : await host.doctor.vmInstall();
  const found: string[] = [];
  await doctorCommand({ ...ctx, out: (line) => void found.push(line) }, { ...host.doctor, ...(vm === undefined ? {} : { vmInstall: async () => vm }) });
  const problems = problemLines(found);
  for (const line of problems) ctx.out(line);
  if (problems.some((line) => /^(FAIL|WARN)\s+(VM|microvm)/i.test(line))) ctx.out("The VM checks above do not stop setup: this machine registers on the standard tier (the operating-system sandbox).");

  const result = await deviceRegister(ctx, { origin, kvm: vm === undefined ? undefined : vm.kvm === "present" });
  ctx.out(`Registered runner ${result.runnerId} (${result.mode}) in account ${result.accountId}; if that is not the account you meant, run: fx-runner revoke. The key is saved under ${ctx.stateDir}.`);

  serviceCommand("install", { ...ctx, out: () => undefined }, host.service);
  for (const argv of userServiceStartArgv(host.service, ctx.uid)) {
    if ((await host.run(argv)) !== 0) {
      throw new CliError(`the service file is written but could not be started; start it yourself with: ${userServiceStartArgv(host.service, ctx.uid).map((a) => a.join(" ")).join(" && ")}`);
    }
  }
  ctx.out("The runner service is installed and running.");
  if (microvmHelperMissing(vm)) ctx.out(VM_INSTALL_NEXT);
  return 0;
}
