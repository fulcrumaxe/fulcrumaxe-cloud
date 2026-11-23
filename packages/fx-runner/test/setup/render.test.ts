import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { epicHeadings, describeFrom, hostAnswers, projectNameOf, renderPlanFiles } from "../../src/setup/render.js";
import { PACKAGE_DIR } from "../helpers/srcFiles.js";
import { EPIC_TEMPLATE } from "../helpers/tarBuilder.js";
import { samplePlan } from "../helpers/machineJobFixture.js";

/** D#845 ON-8c: the plan files are rendered deterministically (golden), with the epic headings copied from the engine's template, and the host's part of the coldstart answers. */
const HEADINGS = ["Context", "Architecture", "Tasks"];

describe("epic headings", () => {
  it("are the template's `## ` lines in order, never one inside a fence or a comment", () => {
    expect(epicHeadings(EPIC_TEMPLATE)).toEqual(HEADINGS);
    expect(epicHeadings("## A\r\n```\n## B\n```\n<!-- ## C -->\n## D\n<!--\n## E\n-->\n##F\n")).toEqual(["A", "D"]);
  });

  const real = path.join(PACKAGE_DIR, "..", "..", "scripts", "coldstart-templates", "epic", "epic.md");
  it.skipIf(!existsSync(real))("the engine's own template, as synced here, gives the headings the golden files below were made with", () => {
    expect(epicHeadings(readFileSync(real, "utf8"))).toEqual(HEADINGS);
  });
});

describe("rendering", () => {
  const files = renderPlanFiles(samplePlan(), HEADINGS);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.content]));

  it("makes exactly the PRD, the roadmap and one epic file per kept row, in plan order", () => {
    expect(files.map((f) => f.path)).toEqual(["docs/PRD.md", ".autonomous-team/roadmap.json", "epics/01-A1.md", "epics/02-B-2.md"]);
  });

  it("the PRD is the plan's text with one final newline and LF line ends", () => {
    expect(byPath["docs/PRD.md"]).toBe("# Widgets\n\nA small service that **counts** widgets, `fast`.\n\n## Goals\n\nCount them.\n");
    expect(renderPlanFiles(samplePlan({ prd_md: "a\r\nb\r\n\r\n\r\n" }), HEADINGS)[0]!.content).toBe("a\nb\n");
  });

  it("golden: roadmap.json", () => {
    expect(byPath[".autonomous-team/roadmap.json"]).toMatchInlineSnapshot(`
      "{
        "milestones": {
          "M1": {
            "definition": "The approved plan, version 2.",
            "tasks": [
              "A1",
              "B-2"
            ]
          }
        },
        "task_status": {
          "A1": {
            "depends_on": [],
            "milestone": "M1",
            "planned_prs": 2,
            "prs": [],
            "size": "M",
            "status": "not-started",
            "summary": "Count every widget once.",
            "title": "Count widgets"
          },
          "B-2": {
            "depends_on": [
              "A1"
            ],
            "milestone": "M1",
            "planned_prs": 1,
            "prs": [],
            "size": "S",
            "status": "not-started",
            "summary": "",
            "title": "Report counts"
          }
        }
      }
      "
    `);
  });

  it("golden: epic files", () => {
    expect(byPath["epics/01-A1.md"]).toMatchInlineSnapshot(`
      "# Epic 1: Count widgets

      ## Context

      Count every widget once.

      Size: M.

      ## Architecture

      _To be written when this epic starts._

      ## Tasks

      _To be written when this epic starts._
      "
    `);
    expect(byPath["epics/02-B-2.md"]).toMatchInlineSnapshot(`
      "# Epic 2: Report counts

      ## Context

      Size: S. Depends on: A1.

      ## Architecture

      _To be written when this epic starts._

      ## Tasks

      _To be written when this epic starts._
      "
    `);
  });

  it("is deterministic: the same plan twice gives the same bytes, whatever order the object's keys were built in", () => {
    const plan = samplePlan();
    const shuffled = JSON.parse(JSON.stringify({ setup: plan.setup, roadmap: plan.roadmap.map((r) => ({ depends_on: r.depends_on, size: r.size, summary: r.summary, title: r.title, row_key: r.row_key })), prd_md: plan.prd_md, version: plan.version, draft_id: plan.draft_id, v: 1 }));
    expect(renderPlanFiles(shuffled, HEADINGS)).toEqual(files);
  });

  it("pads the position to at least two digits, and to the width of the largest", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ row_key: `R${i}`, title: `T${i}`, summary: "", size: "S" as const, depends_on: [] }));
    const many = renderPlanFiles(samplePlan({ roadmap: rows }), ["Context"]).map((f) => f.path);
    expect(many[2]).toBe("epics/001-R0.md");
    expect(many[101]).toBe("epics/100-R99.md");
  });

  it("an empty roadmap renders the PRD and an empty roadmap file", () => {
    const empty = renderPlanFiles(samplePlan({ roadmap: [] }), HEADINGS);
    expect(empty.map((f) => f.path)).toEqual(["docs/PRD.md", ".autonomous-team/roadmap.json"]);
    expect(JSON.parse(empty[1]!.content)).toMatchObject({ milestones: { M1: { tasks: [] } }, task_status: {} });
  });
});

describe("the host's part of the answers", () => {
  it("an existing project: identity, deploy, autonomy at the manifest defaults and the mission line; the stack is left to the guest", () => {
    expect(hostAnswers(samplePlan())).toEqual({
      name: "widgets-service",
      answers: {
        identity: { project_name: "widgets-service", project_description: "A small service that counts widgets, fast.", repo_owner: "acme", boss_github_username: "jane-doe" },
        deploy: { deploy_target: "none" },
        autonomy: { agent_spawn_level: 3, merge_fast_path_level: 2, external_system_level: 1, intent_generate_level: 1, human_approval_before_merge: "no", security_review_required: "yes" },
        mission: { product_vision: "See docs/PRD.md (approved plan v2)." },
      },
    });
  });

  it("a new project also gets the fixed stack and the polyglot language", () => {
    const plan = samplePlan();
    const got = hostAnswers({ ...plan, setup: { ...plan.setup, kind: "new" } });
    expect(got.language).toBe("polyglot");
    expect(got.answers["stack"]).toEqual({ primary_language: "other", runtime_framework: "none", package_manager: "other", test_framework: "unknown", has_frontend: "no" });
  });

  it("project names: lower case, runs outside [a-z0-9-] become one hyphen, at most 39 characters, `project` when nothing is left", () => {
    expect(projectNameOf("My_Repo.Name")).toBe("my-repo-name");
    expect(projectNameOf("a".repeat(60))).toBe("a".repeat(39));
    expect(projectNameOf("...")).toBe("project");
    expect(projectNameOf("-x-")).toBe("x");
    expect(projectNameOf("ab".repeat(19) + "-cd")).toBe("ab".repeat(19)); // cut at 39, then the hyphen it ends on goes
  });

  it("the description is the first non-heading paragraph line as plain text, at most 200 characters, and absent when there is none", () => {
    expect(describeFrom("# T\n\n> - **Bold** and _soft_ `code`\n")).toBe("Bold and soft code");
    expect(describeFrom("# T\n```\nnot this\n```\nthis one\n")).toBe("this one");
    expect(describeFrom("# T\n\n## U\n")).toBeUndefined();
    expect(describeFrom("x\u0007y\u0000z")).toBe("x y z");
    expect(describeFrom("é".repeat(300))).toBe("é".repeat(200));
    expect(hostAnswers(samplePlan({ prd_md: "# Only a heading\n" })).answers["identity"]).not.toHaveProperty("project_description");
  });
});
