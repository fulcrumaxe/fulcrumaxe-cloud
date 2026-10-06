// A lint rule for the workspace UI code (apps/workspace/apps and apps/workspace/shell).
//
// The native DOM insertion methods (replaceChildren, append, prepend, before, after, replaceWith) turn a
// null or undefined argument into the TEXT "null" / "undefined" on the page. The shared h() builder skips
// nullish children, so `cond ? null : el` is fine there and became a habit; handed to a native method it
// puts a literal "null" on screen. This rule flags every argument of those six calls that is not provably
// a node, a string or number (those become text), or a spread of a list whose items are provably so.
//
// Provable means one of:
//   - a string, number or template literal; arithmetic / string concatenation
//   - a call to h() or another configured node builder, document.createElement and friends, .cloneNode(),
//     or a function declared in the same file whose every return (and whose end) is provable
//   - an identifier whose every assignment is provable
//   - a ?: whose branches are both provable, a || or ?? whose operands both are
//   - a spread of an array literal, of a .map() whose callback returns provable values, of a call to a
//     same-file function that returns such lists, or of .filter(Boolean) over those (the filter drops
//     null/false/undefined entries, so the entries may be conditional there)
// Everything else is reported, including `a && b` (it yields a when a is falsy: false, 0, "", null).
//
// Opt-out: a comment `dom-insert-ok: <reason>` on the call's lines or the line above. An empty reason
// does not count.

const METHODS = new Set(["replaceChildren", "append", "prepend", "before", "after", "replaceWith"]);
const DEFAULT_BUILDERS = ["h", "timeNode", "renderMarkdown"]; // the shared apps/_lib helpers that return a node
const DOM_FACTORIES = new Set(["createElement", "createElementNS", "createTextNode", "createDocumentFragment", "createComment", "cloneNode", "importNode"]);
const TEXT_METHODS = new Set(["join", "toString", "toFixed", "toLocaleString", "toLocaleDateString", "toLocaleTimeString", "trim", "toUpperCase", "toLowerCase", "padStart", "padEnd", "repeat"]);
const DOM_CONSTRUCTORS = new Set(["Text", "Comment", "DocumentFragment", "Option", "Image", "Audio"]);
const OPT_OUT = /\bdom-insert-ok:\s*\S/;

function unwrap(node) {
  let n = node;
  while (n && (n.type === "TSAsExpression" || n.type === "TSNonNullExpression" || n.type === "TSSatisfiesExpression")) n = n.expression;
  return n;
}

const isNullish = (n) => (n.type === "Literal" && n.value === null && !n.regex) || (n.type === "Identifier" && n.name === "undefined") || (n.type === "UnaryExpression" && n.operator === "void");

export default {
  meta: {
    type: "problem",
    schema: [{ type: "object", properties: { builders: { type: "array", items: { type: "string" } } }, additionalProperties: false }],
    messages: {
      nullish: '{{method}}() turns a null or undefined argument into the text "null" or "undefined". Leave the argument out (spread a list) or pass a node.',
      conditionalNullish: '{{method}}() turns a null or undefined argument into the text "null" or "undefined"; this ?: has a nullish branch. Spread a list instead: ...(cond ? [el] : []).',
      andFalsy: '{{method}}() prints "false", "0" or "null" when the left side of && is falsy. Use a ?: with an empty list: ...(cond ? [el] : []).',
      unproven: '{{method}}() prints "null" or "undefined" if this argument is. It is not provably a node or text; build it with h() or spread a list, or opt out with a `dom-insert-ok: <reason>` comment.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const builders = new Set(context.options[0]?.builders ?? DEFAULT_BUILDERS);
    const comments = sourceCode.getAllComments().filter((c) => OPT_OUT.test(c.value));

    // Each check returns null when the value is fine, or the id of the message to report.
    const seen = new Set(); // cycle guard on variables / functions being resolved; a cycle is assumed fine

    function findVariable(id) {
      for (let s = sourceCode.getScope(id); s; s = s.upper) {
        const v = s.set.get(id.name);
        if (v) return v;
      }
      return null;
    }

    function returnsOf(fn) {
      if (fn.body.type !== "BlockStatement") return { exprs: [fn.body], complete: true };
      const exprs = [];
      let bare = false;
      const visit = (n) => {
        if (!n || typeof n.type !== "string") return;
        if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") return;
        if (n.type === "ReturnStatement") {
          if (n.argument) exprs.push(n.argument);
          else bare = true;
          return;
        }
        for (const key of Object.keys(n)) {
          if (key === "parent") continue;
          const val = n[key];
          if (Array.isArray(val)) val.forEach(visit);
          else if (val && typeof val.type === "string") visit(val);
        }
      };
      fn.body.body.forEach(visit);
      const always = (s) => {
        if (!s) return false;
        if (s.type === "ReturnStatement" || s.type === "ThrowStatement") return true;
        if (s.type === "BlockStatement") return s.body.some(always);
        if (s.type === "IfStatement") return !!s.alternate && always(s.consequent) && always(s.alternate);
        return false;
      };
      return { exprs, complete: !bare && always(fn.body) };
    }

    function functionOf(callee) {
      const c = unwrap(callee);
      if (c.type === "FunctionExpression" || c.type === "ArrowFunctionExpression") return c;
      if (c.type !== "Identifier") return null;
      const v = findVariable(c);
      if (!v || v.defs.length !== 1) return null;
      const d = v.defs[0];
      if (d.type === "FunctionName" && d.node.type === "FunctionDeclaration") return d.node;
      if (d.type === "Variable" && d.node.init && v.references.filter((r) => r.isWrite()).length === 1) {
        const init = unwrap(d.node.init);
        if (init.type === "FunctionExpression" || init.type === "ArrowFunctionExpression") return init;
      }
      return null;
    }

    // Is every return value of the function (and its end) accepted by `check`?
    function fnReturns(fn, check) {
      if (seen.has(fn)) return null;
      seen.add(fn);
      try {
        const { exprs, complete } = returnsOf(fn);
        if (!complete) return "unproven";
        for (const e of exprs) {
          const r = check(e);
          if (r) return r;
        }
        return null;
      } finally {
        seen.delete(fn);
      }
    }

    function variableWrites(id, check) {
      const v = findVariable(id);
      if (!v || v.defs.length !== 1 || v.defs[0].type !== "Variable" || v.defs[0].node.id.type !== "Identifier") return "unproven";
      if (seen.has(v)) return null;
      seen.add(v);
      try {
        const writes = v.references.filter((r) => r.isWrite());
        if (writes.length === 0) return "unproven";
        for (const w of writes) {
          if (!w.writeExpr) return "unproven";
          const r = check(w.writeExpr);
          if (r) return r;
        }
        return null;
      } finally {
        seen.delete(v);
      }
    }

    function firstBad(results, conditional) {
      const bad = results.find(Boolean);
      if (!bad) return null;
      return bad === "nullish" && conditional ? "conditionalNullish" : bad;
    }

    // Names (x, x.y.z) known truthy at the point being checked: inside `if (x)`, `x ? ... : ...`, `x && ...`.
    // A truthy value cannot print "null" or "undefined", so it needs no further proof.
    const truthy = new Set();

    function keyOf(node) {
      const n = unwrap(node);
      if (n.type === "Identifier") return n.name;
      if (n.type === "MemberExpression" && !n.computed && n.property.type === "Identifier") {
        const o = keyOf(n.object);
        return o && o + "." + n.property.name;
      }
      return null;
    }

    function idsOf(test, wantTruthy) {
      const t = unwrap(test);
      if (t.type === "Identifier" || t.type === "MemberExpression") return wantTruthy && keyOf(t) ? [t] : [];
      if (t.type === "UnaryExpression" && t.operator === "!") return idsOf(t.argument, !wantTruthy);
      if (t.type === "LogicalExpression" && t.operator === "&&" && wantTruthy) return [...idsOf(t.left, true), ...idsOf(t.right, true)];
      return [];
    }

    function narrowed(ids, fn) {
      const added = [];
      for (const id of ids) {
        const k = keyOf(id);
        if (k && !truthy.has(k)) {
          truthy.add(k);
          added.push(k);
        }
      }
      try {
        return fn();
      } finally {
        added.forEach((k) => truthy.delete(k));
      }
    }

    // Under `filtered` the value is only used when truthy, and a truthy value cannot print "null" or
    // "undefined", so a name, member or call whose type is unknown is fine there.
    function unprovenUnless(filtered, result = "unproven") {
      return filtered && result === "unproven" ? null : result;
    }

    // A value that becomes a node or text. `filtered` means a falsy value is dropped on the way (the value
    // is only used when truthy), so null, undefined, false, 0 and "" are fine.
    function nodeOrText(raw, filtered = false) {
      const n = unwrap(raw);
      if (isNullish(n)) return filtered ? null : "nullish";
      if ((n.type === "Identifier" || n.type === "MemberExpression") && truthy.has(keyOf(n))) return null;
      switch (n.type) {
        case "Literal":
          if (n.regex) return "unproven";
          if (typeof n.value === "boolean") return filtered && n.value === false ? null : "unproven";
          return null;
        case "TemplateLiteral":
          return null;
        case "BinaryExpression":
          return ["+", "-", "*", "/", "%", "**"].includes(n.operator) ? null : "unproven";
        case "ConditionalExpression":
          return firstBad(
            [narrowed(idsOf(n.test, true), () => nodeOrText(n.consequent, filtered)), narrowed(idsOf(n.test, false), () => nodeOrText(n.alternate, filtered))],
            !filtered,
          );
        case "LogicalExpression":
          if (n.operator === "&&") return filtered ? narrowed(idsOf(n.left, true), () => nodeOrText(n.right, true)) : "andFalsy";
          // a || b and a ?? b: a is used only when truthy (non-nullish), otherwise b is.
          return firstBad([nodeOrText(n.left, true), nodeOrText(n.right, filtered)], false);
        case "NewExpression":
          return n.callee.type === "Identifier" && DOM_CONSTRUCTORS.has(n.callee.name) ? null : "unproven";
        case "MemberExpression":
          return n.object.type === "Identifier" && n.object.name === "document" && !n.computed && ["body", "head", "documentElement"].includes(n.property.name) ? null : unprovenUnless(filtered);
        case "Identifier":
          return unprovenUnless(filtered, variableWrites(n, (e) => nodeOrText(e, filtered)));
        case "CallExpression":
          return unprovenUnless(filtered, callIsNode(n, filtered));
        default:
          return "unproven";
      }
    }

    function callIsNode(call, filtered) {
      const callee = unwrap(call.callee);
      if (callee.type === "Identifier" && (builders.has(callee.name) || callee.name === "String" || callee.name === "Number")) {
        // A builder name that the file shadows with its own function is checked as that function.
        if (!functionOf(callee)) return null;
      }
      if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
        if (DOM_FACTORIES.has(callee.property.name) || TEXT_METHODS.has(callee.property.name)) return null;
      }
      const fn = functionOf(callee);
      return fn ? fnReturns(fn, (e) => nodeOrText(e, filtered)) : "unproven";
    }

    // A spread operand: an iterable whose items are all nodes or text. Under filter(Boolean) the falsy
    // items are dropped before they reach the DOM.
    function listOfNodes(raw, filtered) {
      const n = unwrap(raw);
      switch (n.type) {
        case "ArrayExpression":
          for (const el of n.elements) {
            if (!el) return filtered ? null : "nullish";
            const r = el.type === "SpreadElement" ? listOfNodes(el.argument, filtered) : nodeOrText(el, filtered);
            if (r) return r;
          }
          return null;
        case "ConditionalExpression":
          return firstBad(
            [narrowed(idsOf(n.test, true), () => listOfNodes(n.consequent, filtered)), narrowed(idsOf(n.test, false), () => listOfNodes(n.alternate, filtered))],
            false,
          );
        case "Identifier":
          return variableWrites(n, (e) => listOfNodes(e, filtered));
        case "CallExpression": {
          const callee = unwrap(n.callee);
          if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
            const name = callee.property.name;
            if (name === "map" || name === "flatMap") {
              const cb = n.arguments[0] && unwrap(n.arguments[0]);
              const fn = cb && functionOf(cb);
              if (!fn) return "unproven";
              return fnReturns(fn, (e) => (name === "map" ? nodeOrText(e, false) : listOfNodes(e, false)));
            }
            if (name === "filter") {
              const a = n.arguments[0] && unwrap(n.arguments[0]);
              const dropsFalsy = !!a && a.type === "Identifier" && a.name === "Boolean";
              return listOfNodes(callee.object, filtered || dropsFalsy);
            }
            if (["slice", "reverse", "flat"].includes(name)) return listOfNodes(callee.object, filtered);
            if (name === "concat") return firstBad([listOfNodes(callee.object, filtered), ...n.arguments.map((a) => listOfNodes(a, filtered))], false);
          }
          const fn = functionOf(callee);
          return fn ? fnReturns(fn, (e) => listOfNodes(e, filtered)) : "unproven";
        }
        default:
          return "unproven";
      }
    }

    // What the code around the call already established: inside `if (x)`, `x ? ...` or `x && ...`, x is truthy.
    function guardsAround(call) {
      const ids = [];
      for (let child = call, p = call.parent; p; child = p, p = p.parent) {
        if (/Function/.test(p.type)) break;
        if ((p.type === "IfStatement" || p.type === "ConditionalExpression") && child !== p.test) ids.push(...idsOf(p.test, child === p.consequent));
        else if (p.type === "LogicalExpression" && p.operator === "&&" && child === p.right) ids.push(...idsOf(p.left, true));
      }
      return ids;
    }

    function optedOut(call) {
      const first = call.loc.start.line;
      const last = call.loc.end.line;
      return comments.some((c) => c.loc.end.line >= first - 1 && c.loc.start.line <= last);
    }

    return {
      CallExpression(call) {
        const callee = unwrap(call.callee);
        if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier" || !METHODS.has(callee.property.name)) return;
        if (call.arguments.length === 0 || optedOut(call)) return;
        narrowed(guardsAround(call), () => {
          for (const arg of call.arguments) {
            const bad = arg.type === "SpreadElement" ? listOfNodes(arg.argument, false) : nodeOrText(arg);
            if (bad) context.report({ node: arg, messageId: bad, data: { method: callee.property.name } });
          }
        });
      },
    };
  },
};
