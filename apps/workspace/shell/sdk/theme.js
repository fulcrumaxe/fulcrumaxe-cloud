// Theme reading + change subscriptions. Wraps `FULCTheme.current()` /
// `FULCTheme.onChange()` and the `fulc-theme-change` document event.
//
// `current()` snapshots the active experience plus a `tokens` map of resolved
// CSS custom properties (`--accent`, `--bg`, …). Apps that need a token
// outside the snapshot can call `snap.token("--surface")` to read it from
// `:root` directly.
function fulcTheme() {
    if (typeof window === "undefined")
        return null;
    return window.FULCTheme ?? null;
}
function readTokens(experience) {
    // The desktop's theme manager applies tokens to `:root` as CSS custom
    // properties. We snapshot whatever the experience declared (so apps see the
    // intended values regardless of cascade overrides) plus fall back to a
    // computed-style read for anything unspecified.
    const out = {};
    if (experience?.tokens) {
        for (const [k, v] of Object.entries(experience.tokens)) {
            out[k] = String(v);
        }
    }
    return out;
}
function snapshotFromExperience(experience) {
    const tokens = readTokens(experience);
    return {
        experience,
        tokens,
        token(name) {
            const lookup = name.startsWith("--") ? name : "--" + name;
            if (lookup in tokens)
                return tokens[lookup];
            if (typeof getComputedStyle !== "undefined" && typeof document !== "undefined") {
                return getComputedStyle(document.documentElement).getPropertyValue(lookup).trim();
            }
            return "";
        },
    };
}
export const theme = {
    current() {
        const t = fulcTheme();
        return snapshotFromExperience(t ? t.current() : null);
    },
    onChange(cb) {
        const handler = (e) => {
            const detail = e.detail;
            const exp = detail?.experience ?? null;
            // Prefer the dispatched tokens (they reflect whatever was applied) and
            // fall back to the experience-declared tokens for older event shapes.
            const tokens = detail?.tokens ?? readTokens(exp);
            cb({
                experience: exp,
                tokens,
                token(name) {
                    const lookup = name.startsWith("--") ? name : "--" + name;
                    if (lookup in tokens)
                        return tokens[lookup];
                    if (typeof getComputedStyle !== "undefined" && typeof document !== "undefined") {
                        return getComputedStyle(document.documentElement).getPropertyValue(lookup).trim();
                    }
                    return "";
                },
            });
        };
        if (typeof document !== "undefined") {
            document.addEventListener("fulc-theme-change", handler);
        }
        return () => {
            if (typeof document !== "undefined") {
                document.removeEventListener("fulc-theme-change", handler);
            }
        };
    },
};
//# sourceMappingURL=theme.js.map